package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

//go:embed static/*
var staticFiles embed.FS

// --- Data types sent to frontend ---

type VMInfo struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Status    string `json:"status"`
	NodeName  string `json:"nodeName"`
	CPUCores  int64  `json:"cpuCores"`
	MemoryMB  int64  `json:"memoryMB"`
	Cluster   string `json:"cluster"`
}

type NodeInfo struct {
	Name           string   `json:"name"`
	Roles          []string `json:"roles"`
	Status         string   `json:"status"`
	CPUCapacity    int64    `json:"cpuCapacity"`
	MemoryCapMB    int64    `json:"memoryCapMB"`
	CPUAllocatable int64    `json:"cpuAllocatable"`
	MemAllocMB     int64    `json:"memAllocMB"`
	VMs            []VMInfo `json:"vms"`
}

type ClusterGroup struct {
	Name  string   `json:"name"`
	VMs   []VMInfo `json:"vms"`
	Nodes []string `json:"nodes"`
}

type StatusData struct {
	Datacenter string         `json:"datacenter,omitempty"`
	Nodes      []NodeInfo     `json:"nodes"`
	Clusters   []ClusterGroup `json:"clusters"`
	Updated    string         `json:"updated"`
}

// HubData is the combined payload the hub sends to frontends.
type HubData struct {
	Datacenters []DCStatus `json:"datacenters"`
	Updated     string     `json:"updated"`
}

// DCStatus is one datacenter's snapshot as stored in the hub.
type DCStatus struct {
	StatusData
	Stale bool `json:"stale"`
}

// dcStore holds the latest report from each agent.
type dcStore struct {
	mu    sync.RWMutex
	dcs   map[string]*dcEntry
	stale time.Duration
}

type dcEntry struct {
	data     StatusData
	received time.Time
}

func newDCStore(staleDuration time.Duration) *dcStore {
	return &dcStore{dcs: make(map[string]*dcEntry), stale: staleDuration}
}

func (s *dcStore) update(d StatusData) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dcs[d.Datacenter] = &dcEntry{data: d, received: time.Now()}
}

func (s *dcStore) snapshot() HubData {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []DCStatus
	now := time.Now()
	for _, e := range s.dcs {
		ds := DCStatus{StatusData: e.data, Stale: now.Sub(e.received) > s.stale}
		out = append(out, ds)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Datacenter < out[j].Datacenter })
	return HubData{Datacenters: out, Updated: time.Now().Format(time.RFC3339)}
}

// --- SSE ---

type sseClient struct {
	ch chan []byte
}

type SSEBroker struct {
	mu      sync.RWMutex
	clients map[*sseClient]bool
}

func NewSSEBroker() *SSEBroker {
	return &SSEBroker{clients: make(map[*sseClient]bool)}
}

func (b *SSEBroker) Subscribe() *sseClient {
	c := &sseClient{ch: make(chan []byte, 8)}
	b.mu.Lock()
	b.clients[c] = true
	b.mu.Unlock()
	return c
}

func (b *SSEBroker) Unsubscribe(c *sseClient) {
	b.mu.Lock()
	delete(b.clients, c)
	close(c.ch)
	b.mu.Unlock()
}

func (b *SSEBroker) Broadcast(data []byte) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for c := range b.clients {
		select {
		case c.ch <- data:
		default:
			// drop if client is slow
		}
	}
}

func (b *SSEBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	client := b.Subscribe()
	defer b.Unsubscribe(client)

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-client.ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		}
	}
}

// --- Kubernetes data fetcher ---

func buildConfig() (*rest.Config, error) {
	// If KUBECONFIG is explicitly set, use it (skip in-cluster config)
	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		// Try in-cluster first
		if cfg, err := rest.InClusterConfig(); err == nil {
			return cfg, nil
		}
		home, _ := os.UserHomeDir()
		kubeconfig = home + "/.kube/config"
	}
	kubeContext := os.Getenv("KUBE_CONTEXT")

	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		&clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeconfig},
		&clientcmd.ConfigOverrides{CurrentContext: kubeContext},
	).ClientConfig()
}

func fetchStatus(ctx context.Context, k8s kubernetes.Interface, dynClient dynamic.Interface) (*StatusData, error) {
	// 1. Get nodes
	nodeList, err := k8s.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list nodes: %w", err)
	}

	nodeMap := make(map[string]int) // name -> index in nodes
	var nodes []NodeInfo
	for _, n := range nodeList.Items {
		ni := NodeInfo{
			Name:   n.Name,
			Status: "NotReady",
		}
		for _, cond := range n.Status.Conditions {
			if cond.Type == "Ready" && cond.Status == "True" {
				ni.Status = "Ready"
			}
		}
		// roles
		isControlPlane := false
		for lbl := range n.Labels {
			if lbl == "node-role.kubernetes.io/control-plane" {
				ni.Roles = append(ni.Roles, "control-plane")
				isControlPlane = true
			} else if lbl == "node-role.kubernetes.io/worker" {
				ni.Roles = append(ni.Roles, "worker")
			}
		}
		if len(ni.Roles) == 0 {
			ni.Roles = []string{"worker"}
		}
		// Skip control-plane nodes as they cannot schedule VMs
		if isControlPlane {
			continue
		}
		// capacity
		if cpu, ok := n.Status.Capacity["cpu"]; ok {
			ni.CPUCapacity = cpu.Value()
		}
		if mem, ok := n.Status.Capacity["memory"]; ok {
			ni.MemoryCapMB = mem.Value() / (1024 * 1024)
		}
		// CPU is overcommittable (3x), memory is not
		ni.CPUAllocatable = ni.CPUCapacity * 3
		if mem, ok := n.Status.Allocatable["memory"]; ok {
			ni.MemAllocMB = mem.Value() / (1024 * 1024)
		}
		nodes = append(nodes, ni)
		nodeMap[n.Name] = len(nodes) - 1
	}

	// 2. Get VMIs (VirtualMachineInstances)
	vmiGVR := schema.GroupVersionResource{
		Group:    "kubevirt.io",
		Version:  "v1",
		Resource: "virtualmachineinstances",
	}
	vmiList, err := dynClient.Resource(vmiGVR).Namespace("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list VMIs: %w", err)
	}

	// 3. Get VMs for status info
	vmGVR := schema.GroupVersionResource{
		Group:    "kubevirt.io",
		Version:  "v1",
		Resource: "virtualmachines",
	}
	vmList, err := dynClient.Resource(vmGVR).Namespace("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list VMs: %w", err)
	}
	vmStatusMap := make(map[string]string) // ns/name -> printableStatus
	vmMemMap := make(map[string]int64)     // ns/name -> memoryMB
	for _, vm := range vmList.Items {
		key := vm.GetNamespace() + "/" + vm.GetName()
		if st, found, _ := unstructured.NestedString(vm.Object, "status", "printableStatus"); found {
			vmStatusMap[key] = st
		}
		// Get memory from VM spec
		if memStr, found, _ := unstructured.NestedString(vm.Object, "spec", "template", "spec", "domain", "memory", "guest"); found {
			vmMemMap[key] = parseMemoryToMB(memStr)
		}
	}

	clusterMap := make(map[string]*ClusterGroup)

	for _, vmi := range vmiList.Items {
		name := vmi.GetName()
		ns := vmi.GetNamespace()
		key := ns + "/" + name

		nodeName, _, _ := unstructured.NestedString(vmi.Object, "status", "nodeName")
		phase, _, _ := unstructured.NestedString(vmi.Object, "status", "phase")
		cpuCores, _, _ := unstructured.NestedInt64(vmi.Object, "spec", "domain", "cpu", "cores")

		// Get status from VM if available, otherwise use VMI phase
		status := phase
		if vmSt, ok := vmStatusMap[key]; ok {
			status = vmSt
		}

		memMB := vmMemMap[key]

		// Determine cluster from VM name pattern or labels
		labels := vmi.GetLabels()
		clusterName := inferClusterName(name, labels)

		vmInfo := VMInfo{
			Name:      name,
			Namespace: ns,
			Status:    status,
			NodeName:  nodeName,
			CPUCores:  cpuCores,
			MemoryMB:  memMB,
			Cluster:   clusterName,
		}

		// Assign to node
		if idx, ok := nodeMap[nodeName]; ok {
			nodes[idx].VMs = append(nodes[idx].VMs, vmInfo)
		}

		// Group by cluster
		cg, ok := clusterMap[clusterName]
		if !ok {
			cg = &ClusterGroup{Name: clusterName}
			clusterMap[clusterName] = cg
		}
		cg.VMs = append(cg.VMs, vmInfo)
		// track nodes in cluster
		if nodeName != "" {
			found := false
			for _, n := range cg.Nodes {
				if n == nodeName {
					found = true
					break
				}
			}
			if !found {
				cg.Nodes = append(cg.Nodes, nodeName)
			}
		}
	}

	var clusters []ClusterGroup
	for _, cg := range clusterMap {
		sort.Slice(cg.VMs, func(i, j int) bool { return cg.VMs[i].Name < cg.VMs[j].Name })
		sort.Strings(cg.Nodes)
		clusters = append(clusters, *cg)
	}
	sort.Slice(clusters, func(i, j int) bool { return clusters[i].Name < clusters[j].Name })

	// Sort VMs within each node
	for i := range nodes {
		sort.Slice(nodes[i].VMs, func(a, b int) bool { return nodes[i].VMs[a].Name < nodes[i].VMs[b].Name })
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })

	return &StatusData{
		Nodes:    nodes,
		Clusters: clusters,
		Updated:  time.Now().Format(time.RFC3339),
	}, nil
}

func inferClusterName(vmName string, labels map[string]string) string {
	parts := splitVMName(vmName)
	if parts != "" {
		return parts
	}
	if src, ok := labels["vitistack.io/source-machine"]; ok {
		p := splitVMName(src)
		if p != "" {
			return p
		}
	}
	return "unknown"
}

func splitVMName(name string) string {
	// Find the last segment that looks like a role (ctp\d+, wrk\d+)
	lastDash := -1
	for i := len(name) - 1; i >= 0; i-- {
		if name[i] == '-' {
			lastDash = i
			break
		}
	}
	if lastDash > 0 {
		suffix := name[lastDash+1:]
		if len(suffix) >= 4 && (suffix[:3] == "ctp" || suffix[:3] == "wrk") {
			return name[:lastDash]
		}
	}
	return ""
}

func parseMemoryToMB(s string) int64 {
	if len(s) == 0 {
		return 0
	}
	var num int64
	var i int
	for i = 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			num = num*10 + int64(s[i]-'0')
		} else {
			break
		}
	}
	suffix := s[i:]
	switch suffix {
	case "Gi":
		return num * 1024
	case "Mi":
		return num
	case "G":
		return num * 1000
	case "M":
		return num
	case "Ti":
		return num * 1024 * 1024
	case "Ki":
		return num / 1024
	default:
		return num / (1024 * 1024) // assume bytes
	}
}

func main() {
	log.SetFlags(log.Ltime | log.Lshortfile)

	hubMode := strings.EqualFold(os.Getenv("HUB_MODE"), "true")
	hubToken := os.Getenv("HUB_TOKEN")

	broker := NewSSEBroker()
	mux := http.NewServeMux()
	mux.Handle("/events", broker)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if hubMode {
		// ---- Hub mode: receive reports from agents, serve combined view ----
		store := newDCStore(30 * time.Second)

		mux.HandleFunc("/api/report", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "POST only", http.StatusMethodNotAllowed)
				return
			}
			if hubToken != "" {
				auth := r.Header.Get("Authorization")
				if !strings.HasPrefix(auth, "Bearer ") || subtle.ConstantTimeCompare([]byte(auth[7:]), []byte(hubToken)) != 1 {
					http.Error(w, "unauthorized", http.StatusUnauthorized)
					return
				}
			}
			body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20)) // 10 MB max
			if err != nil {
				http.Error(w, "read error", http.StatusBadRequest)
				return
			}
			var sd StatusData
			if err := json.Unmarshal(body, &sd); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			if sd.Datacenter == "" {
				http.Error(w, "datacenter field required", http.StatusBadRequest)
				return
			}
			store.update(sd)
			w.WriteHeader(http.StatusNoContent)
		})

		mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(store.snapshot())
		})

		// Broadcast combined snapshot every 5 seconds
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					snap := store.snapshot()
					jsonData, _ := json.Marshal(snap)
					broker.Broadcast(jsonData)
				}
			}
		}()

		log.Println("Running in HUB mode")
	} else {
		// ---- Agent mode: query local k8s, serve local dashboard ----
		cfg, err := buildConfig()
		if err != nil {
			log.Fatalf("Failed to build kubeconfig: %v", err)
		}

		k8s, err := kubernetes.NewForConfig(cfg)
		if err != nil {
			log.Fatalf("Failed to create k8s client: %v", err)
		}

		dynClient, err := dynamic.NewForConfig(cfg)
		if err != nil {
			log.Fatalf("Failed to create dynamic client: %v", err)
		}

		dcName := os.Getenv("DATACENTER_NAME")
		hubURL := os.Getenv("HUB_URL") // e.g. https://hub.example.com

		interval := 5 * time.Second

		// Background poller
		go func() {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()

			httpClient := &http.Client{Timeout: 10 * time.Second}

			doFetch := func() {
				data, err := fetchStatus(ctx, k8s, dynClient)
				if err != nil {
					log.Printf("Error fetching status: %v", err)
					return
				}
				data.Datacenter = dcName

				jsonData, err := json.Marshal(data)
				if err != nil {
					log.Printf("Error marshaling data: %v", err)
					return
				}
				broker.Broadcast(jsonData)

				// Push to hub if configured
				if hubURL != "" {
					go pushToHub(httpClient, hubURL, hubToken, jsonData)
				}
			}

			doFetch()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					doFetch()
				}
			}
		}()

		mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
			data, err := fetchStatus(r.Context(), k8s, dynClient)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			data.Datacenter = dcName
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(data)
		})

		if dcName != "" {
			log.Printf("Running in AGENT mode, datacenter=%s", dcName)
		}
	}

	// Serve embedded static files
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatalf("Failed to create sub FS: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(staticFS)))

	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		cancel()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Printf("Listening on %s", addr)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

func pushToHub(client *http.Client, hubURL, token string, data []byte) {
	url := strings.TrimRight(hubURL, "/") + "/api/report"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		log.Printf("Hub push: request error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Hub push: %v", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("Hub push: status %d", resp.StatusCode)
	}
}
