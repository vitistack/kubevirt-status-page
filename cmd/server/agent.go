package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	kruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
)

const (
	agentTickEvery     = 5 * time.Second
	agentHeartbeat     = 10 * time.Second // must stay well below hubStaleAfter
	agentSummaryEvery  = 5 * time.Minute
	pushTimeout        = 10 * time.Second
	pushFailLogEveryN  = 12
	syncProgressLogged = 30 * time.Second
)

var (
	vmiGVR = schema.GroupVersionResource{Group: "kubevirt.io", Version: "v1", Resource: "virtualmachineinstances"}
	vmGVR  = schema.GroupVersionResource{Group: "kubevirt.io", Version: "v1", Resource: "virtualmachines"}
)

// --- Slim cached objects ---
//
// Informer transforms replace the full KubeVirt objects (tens of KB each,
// mostly managedFields/spec we never read) with these, so the cache only
// holds what the status page renders.

type vmiInfo struct {
	NodeName       string
	Phase          string
	Cluster        string
	Cores          int64
	MemMB          int64
	LiveMigratable bool
}

type vmiSlim struct {
	metav1.ObjectMeta
	Info vmiInfo
}

func (o *vmiSlim) GetObjectKind() schema.ObjectKind { return schema.EmptyObjectKind }
func (o *vmiSlim) DeepCopyObject() kruntime.Object {
	c := *o
	o.ObjectMeta.DeepCopyInto(&c.ObjectMeta)
	return &c
}

type vmInfo struct {
	Status string
	MemMB  int64
}

type vmSlim struct {
	metav1.ObjectMeta
	Info vmInfo
}

func (o *vmSlim) GetObjectKind() schema.ObjectKind { return schema.EmptyObjectKind }
func (o *vmSlim) DeepCopyObject() kruntime.Object {
	c := *o
	o.ObjectMeta.DeepCopyInto(&c.ObjectMeta)
	return &c
}

func slimMeta(u *unstructured.Unstructured) metav1.ObjectMeta {
	return metav1.ObjectMeta{Name: u.GetName(), Namespace: u.GetNamespace(), ResourceVersion: u.GetResourceVersion()}
}

func memFrom(obj map[string]any, prefix ...string) int64 {
	if s, found, _ := unstructured.NestedString(obj, append(prefix, "memory", "guest")...); found {
		return parseMemoryToMB(s)
	}
	if s, found, _ := unstructured.NestedString(obj, append(prefix, "resources", "requests", "memory")...); found {
		return parseMemoryToMB(s)
	}
	return 0
}

// Transforms must tolerate already-transformed objects.
func transformVMI(obj any) (any, error) {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return obj, nil
	}
	o := u.Object
	s := &vmiSlim{ObjectMeta: slimMeta(u)}
	s.Info.NodeName, _, _ = unstructured.NestedString(o, "status", "nodeName")
	s.Info.Phase, _, _ = unstructured.NestedString(o, "status", "phase")
	s.Info.Cores, _, _ = unstructured.NestedInt64(o, "spec", "domain", "cpu", "cores")
	s.Info.MemMB = memFrom(o, "spec", "domain")
	s.Info.Cluster = inferClusterName(u.GetName(), u.GetLabels())
	s.Info.LiveMigratable = true
	if conds, found, _ := unstructured.NestedSlice(o, "status", "conditions"); found {
		for _, c := range conds {
			if m, ok := c.(map[string]any); ok && m["type"] == "LiveMigratable" && m["status"] == "False" {
				s.Info.LiveMigratable = false
				break
			}
		}
	}
	return s, nil
}

func transformVM(obj any) (any, error) {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return obj, nil
	}
	s := &vmSlim{ObjectMeta: slimMeta(u)}
	s.Info.Status, _, _ = unstructured.NestedString(u.Object, "status", "printableStatus")
	s.Info.MemMB = memFrom(u.Object, "spec", "template", "spec", "domain")
	return s, nil
}

// transformNode drops images, managedFields, addresses, nodeInfo etc.
// Condition timestamps are dropped too so heartbeats don't look like changes.
func transformNode(obj any) (any, error) {
	n, ok := obj.(*corev1.Node)
	if !ok {
		return obj, nil
	}
	out := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: n.Name, ResourceVersion: n.ResourceVersion}}
	for k, v := range n.Labels {
		if strings.HasPrefix(k, "node-role.kubernetes.io/") {
			if out.Labels == nil {
				out.Labels = map[string]string{}
			}
			out.Labels[k] = v
		}
	}
	for _, c := range n.Status.Conditions {
		if c.Type == corev1.NodeReady {
			out.Status.Conditions = []corev1.NodeCondition{{Type: c.Type, Status: c.Status}}
		}
	}
	out.Status.Capacity = corev1.ResourceList{}
	for _, r := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
		if q, ok := n.Status.Capacity[r]; ok {
			out.Status.Capacity[r] = q
		}
	}
	if q, ok := n.Status.Allocatable[corev1.ResourceMemory]; ok {
		out.Status.Allocatable = corev1.ResourceList{corev1.ResourceMemory: q}
	}
	return out, nil
}

// nodeToInfo returns ok=false for control-plane nodes, which cannot schedule VMs.
func nodeToInfo(n *corev1.Node) (NodeInfo, bool) {
	ni := NodeInfo{Name: n.Name, Status: "NotReady"}
	for _, c := range n.Status.Conditions {
		if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
			ni.Status = "Ready"
		}
	}
	isControlPlane := false
	for lbl := range n.Labels {
		switch lbl {
		case "node-role.kubernetes.io/control-plane":
			ni.Roles = append(ni.Roles, "control-plane")
			isControlPlane = true
		case "node-role.kubernetes.io/worker":
			ni.Roles = append(ni.Roles, "worker")
		}
	}
	if len(ni.Roles) == 0 {
		ni.Roles = []string{"worker"}
	}
	sort.Strings(ni.Roles)
	if q, ok := n.Status.Capacity[corev1.ResourceCPU]; ok {
		ni.CPUCapacity = q.Value()
	}
	if q, ok := n.Status.Capacity[corev1.ResourceMemory]; ok {
		ni.MemoryCapMB = q.Value() / (1024 * 1024)
	}
	// CPU is overcommittable (3x), memory is not
	ni.CPUAllocatable = ni.CPUCapacity * 3
	if q, ok := n.Status.Allocatable[corev1.ResourceMemory]; ok {
		ni.MemAllocMB = q.Value() / (1024 * 1024)
	}
	return ni, !isControlPlane
}

// buildStatus assembles the frontend payload from cached slim objects.
func buildStatus(nodeObjs, vmObjs, vmiObjs []any) *StatusData {
	nodeMap := make(map[string]int, len(nodeObjs))
	nodes := make([]NodeInfo, 0, len(nodeObjs))
	for _, o := range nodeObjs {
		n, ok := o.(*corev1.Node)
		if !ok {
			continue
		}
		if ni, worker := nodeToInfo(n); worker {
			nodes = append(nodes, ni)
			nodeMap[n.Name] = len(nodes) - 1
		}
	}

	vms := make(map[string]vmInfo, len(vmObjs))
	for _, o := range vmObjs {
		if v, ok := o.(*vmSlim); ok {
			vms[v.Namespace+"/"+v.Name] = v.Info
		}
	}

	clusterMap := make(map[string]*ClusterGroup)
	clusterNodes := make(map[string]map[string]struct{})
	for _, o := range vmiObjs {
		v, ok := o.(*vmiSlim)
		if !ok {
			continue
		}
		status := v.Info.Phase
		memMB := v.Info.MemMB
		if vm, ok := vms[v.Namespace+"/"+v.Name]; ok {
			if vm.Status != "" {
				status = vm.Status
			}
			if vm.MemMB != 0 {
				memMB = vm.MemMB
			}
		}
		info := VMInfo{
			Name:           v.Name,
			Namespace:      v.Namespace,
			Status:         status,
			NodeName:       v.Info.NodeName,
			CPUCores:       v.Info.Cores,
			MemoryMB:       memMB,
			Cluster:        v.Info.Cluster,
			LiveMigratable: v.Info.LiveMigratable,
		}
		if idx, ok := nodeMap[info.NodeName]; ok {
			nodes[idx].VMs = append(nodes[idx].VMs, info)
		}
		cg, ok := clusterMap[info.Cluster]
		if !ok {
			cg = &ClusterGroup{Name: info.Cluster}
			clusterMap[info.Cluster] = cg
			clusterNodes[info.Cluster] = map[string]struct{}{}
		}
		cg.VMs = append(cg.VMs, info)
		if info.NodeName != "" {
			if _, seen := clusterNodes[info.Cluster][info.NodeName]; !seen {
				clusterNodes[info.Cluster][info.NodeName] = struct{}{}
				cg.Nodes = append(cg.Nodes, info.NodeName)
			}
		}
	}

	clusters := make([]ClusterGroup, 0, len(clusterMap))
	for _, cg := range clusterMap {
		sort.Slice(cg.VMs, func(i, j int) bool { return cg.VMs[i].Name < cg.VMs[j].Name })
		sort.Strings(cg.Nodes)
		clusters = append(clusters, *cg)
	}
	sort.Slice(clusters, func(i, j int) bool { return clusters[i].Name < clusters[j].Name })
	for i := range nodes {
		sort.Slice(nodes[i].VMs, func(a, b int) bool { return nodes[i].VMs[a].Name < nodes[i].VMs[b].Name })
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })

	return &StatusData{Nodes: nodes, Clusters: clusters}
}

// --- Hub pusher ---

// pusher sends at most one report at a time; newer snapshots replace queued ones.
type pusher struct {
	client      *http.Client
	url         string
	token       string
	datacenter  string
	queue       chan []byte
	failing     int
	failSince   time.Time
	everPushed  bool
	okCount     atomic.Int64
	failCount   atomic.Int64
	lastSuccess atomic.Int64 // unix seconds
}

func newPusher(hubURL, token, dc string) *pusher {
	return &pusher{
		client:     &http.Client{Timeout: pushTimeout},
		url:        strings.TrimRight(hubURL, "/") + "/api/report",
		token:      token,
		datacenter: dc,
		queue:      make(chan []byte, 1),
	}
}

func (p *pusher) offer(b []byte) {
	select {
	case <-p.queue: // drop the stale queued snapshot
	default:
	}
	select {
	case p.queue <- b:
	default:
	}
}

func (p *pusher) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-p.queue:
			start := time.Now()
			err := p.push(ctx, b)
			p.record(err, len(b), time.Since(start))
		}
	}
}

func (p *pusher) push(ctx context.Context, data []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.token != "" {
		req.Header.Set("Authorization", "Bearer "+p.token)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("hub returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	_, _ = io.Copy(io.Discard, resp.Body) // allow connection reuse
	return nil
}

func (p *pusher) record(err error, size int, took time.Duration) {
	attrs := []any{"hub", p.url, "datacenter", p.datacenter, "bytes", size, "took", took.Round(time.Millisecond)}
	if err != nil {
		p.failCount.Add(1)
		p.failing++
		if p.failing == 1 {
			p.failSince = time.Now()
			slog.Warn("hub push failed", append(attrs, "err", err)...)
		} else if p.failing%pushFailLogEveryN == 0 {
			slog.Warn("hub push still failing", append(attrs, "err", err, "consecutiveFailures", p.failing,
				"failingFor", time.Since(p.failSince).Round(time.Second))...)
		}
		return
	}
	p.okCount.Add(1)
	p.lastSuccess.Store(time.Now().Unix())
	switch {
	case !p.everPushed:
		slog.Info("first successful push to hub", attrs...)
	case p.failing > 0:
		slog.Info("hub push recovered", append(attrs, "failedAttempts", p.failing,
			"downFor", time.Since(p.failSince).Round(time.Second))...)
	default:
		slog.Debug("hub push ok", attrs...)
	}
	p.everPushed = true
	p.failing = 0
}

// --- Agent wiring ---

type agent struct {
	dc        string
	nodes     cache.SharedIndexInformer
	vms       cache.SharedIndexInformer
	vmis      cache.SharedIndexInformer
	dirty     atomic.Bool
	latest    atomic.Pointer[[]byte]
	pusher    *pusher
	broker    *SSEBroker
	lastPush  time.Time
	lastBuild time.Duration
}

func (a *agent) markDirty() { a.dirty.Store(true) }

func (a *agent) handlers(changed func(oldObj, newObj any) bool) cache.ResourceEventHandlerFuncs {
	return cache.ResourceEventHandlerFuncs{
		AddFunc: func(any) { a.markDirty() },
		UpdateFunc: func(oldObj, newObj any) {
			if changed(oldObj, newObj) {
				a.markDirty()
			}
		},
		DeleteFunc: func(any) { a.markDirty() },
	}
}

func runAgent(ctx context.Context, mux *http.ServeMux, broker *SSEBroker, hubToken string) error {
	dcName := os.Getenv("DATACENTER_NAME")
	hubURL := os.Getenv("HUB_URL")
	slog.Info("starting in agent mode", "datacenter", dcName, "hubURL", hubURL,
		"hubAuth", hubToken != "", "kubeContext", os.Getenv("KUBE_CONTEXT"))
	if dcName == "" && hubURL != "" {
		slog.Warn("DATACENTER_NAME is empty: the hub will reject every report")
	}

	cfg, err := buildConfig()
	if err != nil {
		return fmt.Errorf("build kubeconfig: %w", err)
	}
	slog.Info("kubernetes API", "host", cfg.Host)

	// Protobuf for core types is much cheaper to decode than JSON.
	pcfg := rest.CopyConfig(cfg)
	pcfg.ContentType = kruntime.ContentTypeProtobuf
	pcfg.AcceptContentTypes = kruntime.ContentTypeProtobuf + "," + kruntime.ContentTypeJSON
	k8s, err := kubernetes.NewForConfig(pcfg)
	if err != nil {
		return fmt.Errorf("create k8s client: %w", err)
	}
	dynClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("create dynamic client: %w", err)
	}

	a := &agent{dc: dcName, broker: broker}
	if hubURL != "" {
		a.pusher = newPusher(hubURL, hubToken, dcName)
	}

	kf := informers.NewSharedInformerFactoryWithOptions(k8s, 0, informers.WithTransform(transformNode))
	a.nodes = kf.Core().V1().Nodes().Informer()
	df := dynamicinformer.NewDynamicSharedInformerFactory(dynClient, 0)
	a.vms = df.ForResource(vmGVR).Informer()
	a.vmis = df.ForResource(vmiGVR).Informer()

	for name, inf := range map[string]cache.SharedIndexInformer{"nodes": a.nodes, "virtualmachines": a.vms, "virtualmachineinstances": a.vmis} {
		resource := name
		if err := inf.SetWatchErrorHandler(func(_ *cache.Reflector, err error) {
			slog.Warn("list/watch failed, retrying", "resource", resource, "err", err)
		}); err != nil {
			return err
		}
	}
	if err := a.vms.SetTransform(transformVM); err != nil {
		return err
	}
	if err := a.vmis.SetTransform(transformVMI); err != nil {
		return err
	}

	if _, err := a.nodes.AddEventHandler(a.handlers(func(o, n any) bool {
		on, ok1 := o.(*corev1.Node)
		nn, ok2 := n.(*corev1.Node)
		return !ok1 || !ok2 || !reflect.DeepEqual(on.Labels, nn.Labels) || !reflect.DeepEqual(on.Status, nn.Status)
	})); err != nil {
		return err
	}
	if _, err := a.vms.AddEventHandler(a.handlers(func(o, n any) bool {
		ov, ok1 := o.(*vmSlim)
		nv, ok2 := n.(*vmSlim)
		return !ok1 || !ok2 || ov.Info != nv.Info
	})); err != nil {
		return err
	}
	if _, err := a.vmis.AddEventHandler(a.handlers(func(o, n any) bool {
		ov, ok1 := o.(*vmiSlim)
		nv, ok2 := n.(*vmiSlim)
		return !ok1 || !ok2 || ov.Info != nv.Info
	})); err != nil {
		return err
	}

	kf.Start(ctx.Done())
	df.Start(ctx.Done())
	if a.pusher != nil {
		go a.pusher.run(ctx)
	}
	go a.loop(ctx)

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		b := a.latest.Load()
		if b == nil {
			http.Error(w, "initial sync in progress", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(*b)
	})
	return nil
}

func (a *agent) waitForSync(ctx context.Context) bool {
	start := time.Now()
	progress := time.NewTicker(syncProgressLogged)
	defer progress.Stop()
	poll := time.NewTicker(200 * time.Millisecond)
	defer poll.Stop()
	for {
		if a.nodes.HasSynced() && a.vms.HasSynced() && a.vmis.HasSynced() {
			slog.Info("initial sync complete", "took", time.Since(start).Round(time.Millisecond),
				"nodes", len(a.nodes.GetStore().ListKeys()), "vms", len(a.vms.GetStore().ListKeys()),
				"vmis", len(a.vmis.GetStore().ListKeys()))
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-progress.C:
			slog.Warn("initial sync still in progress", "waited", time.Since(start).Round(time.Second),
				"nodesSynced", a.nodes.HasSynced(), "vmsSynced", a.vms.HasSynced(), "vmisSynced", a.vmis.HasSynced())
		case <-poll.C:
		}
	}
}

func (a *agent) loop(ctx context.Context) {
	if !a.waitForSync(ctx) {
		return
	}
	a.markDirty()
	a.tick()

	ticker := time.NewTicker(agentTickEvery)
	defer ticker.Stop()
	summary := time.NewTicker(agentSummaryEvery)
	defer summary.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.tick()
		case <-summary.C:
			a.logSummary()
		}
	}
}

// tick rebuilds the snapshot from the local cache (no API calls), broadcasts it
// locally and hands it to the pusher when something changed or a heartbeat is due.
func (a *agent) tick() {
	start := time.Now()
	data := buildStatus(a.nodes.GetStore().List(), a.vms.GetStore().List(), a.vmis.GetStore().List())
	data.Datacenter = a.dc
	data.Updated = time.Now().Format(time.RFC3339)
	b, err := json.Marshal(data)
	if err != nil {
		slog.Error("marshal status", "err", err)
		return
	}
	a.lastBuild = time.Since(start)
	a.latest.Store(&b)
	changed := a.dirty.Swap(false)

	if a.broker.ClientCount() > 0 {
		a.broker.Broadcast(b)
	}
	slog.Debug("snapshot built", "changed", changed, "nodes", len(data.Nodes), "clusters", len(data.Clusters),
		"vms", countVMs(data.Clusters), "bytes", len(b), "took", a.lastBuild.Round(time.Microsecond))

	if a.pusher != nil && (changed || time.Since(a.lastPush) >= agentHeartbeat) {
		a.pusher.offer(b)
		a.lastPush = time.Now()
	}
}

func (a *agent) logSummary() {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	attrs := []any{
		"nodes", len(a.nodes.GetStore().ListKeys()),
		"vms", len(a.vms.GetStore().ListKeys()),
		"vmis", len(a.vmis.GetStore().ListKeys()),
		"sseClients", a.broker.ClientCount(),
		"lastBuild", a.lastBuild.Round(time.Microsecond),
		"heapMiB", ms.HeapAlloc >> 20,
		"sysMiB", ms.Sys >> 20,
	}
	if b := a.latest.Load(); b != nil {
		attrs = append(attrs, "snapshotBytes", len(*b))
	}
	if p := a.pusher; p != nil {
		attrs = append(attrs, "pushOK", p.okCount.Swap(0), "pushFailed", p.failCount.Swap(0))
		if ts := p.lastSuccess.Load(); ts > 0 {
			attrs = append(attrs, "lastPushOK", time.Unix(ts, 0).Format(time.RFC3339))
		}
	}
	slog.Info("agent summary", attrs...)
}
