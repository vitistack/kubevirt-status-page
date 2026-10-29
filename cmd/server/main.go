package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

//go:embed static/*
var staticFiles embed.FS

// --- Data types sent to frontend ---

type VMInfo struct {
	Name           string `json:"name"`
	Namespace      string `json:"namespace"`
	Status         string `json:"status"`
	NodeName       string `json:"nodeName"`
	CPUCores       int64  `json:"cpuCores"`
	MemoryMB       int64  `json:"memoryMB"`
	Cluster        string `json:"cluster"`
	LiveMigratable bool   `json:"liveMigratable"`
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

func setupLogging() {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler = slog.NewTextHandler(os.Stderr, opts)
	if strings.EqualFold(os.Getenv("LOG_FORMAT"), "json") {
		h = slog.NewJSONHandler(os.Stderr, opts)
	}
	slog.SetDefault(slog.New(h))
}

// setMemoryLimitFromCgroup makes the GC work harder before the container limit
// is reached, instead of letting the heap grow to 2x live data. GOMEMLIMIT wins if set.
func setMemoryLimitFromCgroup() {
	if os.Getenv("GOMEMLIMIT") != "" {
		return
	}
	b, err := os.ReadFile("/sys/fs/cgroup/memory.max")
	if err != nil {
		return
	}
	limit, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil || limit <= 0 {
		return // "max" or unparsable
	}
	soft := limit * 9 / 10
	debug.SetMemoryLimit(soft)
	slog.Info("memory limit set from cgroup", "cgroupLimitMiB", limit>>20, "goMemLimitMiB", soft>>20)
}

func buildConfig() (*rest.Config, error) {
	// If KUBECONFIG is explicitly set, use it (skip in-cluster config)
	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
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

func inferClusterName(vmName string, labels map[string]string) string {
	if p := splitVMName(vmName); p != "" {
		return p
	}
	if src, ok := labels["vitistack.io/source-machine"]; ok {
		if p := splitVMName(src); p != "" {
			return p
		}
	}
	return "unknown"
}

func splitVMName(name string) string {
	// Strip a trailing role segment (ctp\d+, wrk\d+)
	lastDash := strings.LastIndexByte(name, '-')
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
	switch s[i:] {
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

func countVMs(clusters []ClusterGroup) int {
	count := 0
	for _, c := range clusters {
		count += len(c.VMs)
	}
	return count
}

func main() {
	setupLogging()
	setMemoryLimitFromCgroup()

	hubMode := strings.EqualFold(os.Getenv("HUB_MODE"), "true")
	hubToken := os.Getenv("HUB_TOKEN")

	broker := NewSSEBroker()
	mux := http.NewServeMux()
	mux.Handle("/events", broker)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if hubMode {
		runHub(ctx, mux, broker, hubToken)
	} else {
		if err := runAgent(ctx, mux, broker, hubToken); err != nil {
			slog.Error("agent startup failed", "err", err)
			os.Exit(1)
		}
	}

	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		slog.Error("failed to create static FS", "err", err)
		os.Exit(1)
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

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		slog.Info("shutting down")
		cancel()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	slog.Info("listening", "addr", addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
}
