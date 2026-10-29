package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	hubStaleAfter     = 30 * time.Second
	hubBroadcastEvery = 5 * time.Second
	maxReportBytes    = 10 << 20
)

// dcStore holds the latest report from each agent.
type dcStore struct {
	mu    sync.RWMutex
	dcs   map[string]*dcEntry
	stale time.Duration
}

type dcEntry struct {
	data      StatusData
	received  time.Time
	wasStale  bool // last staleness state that was logged
	firstSeen time.Time
}

func newDCStore(staleDuration time.Duration) *dcStore {
	return &dcStore{dcs: make(map[string]*dcEntry), stale: staleDuration}
}

func (s *dcStore) update(d StatusData, remote string) {
	now := time.Now()
	s.mu.Lock()
	e, ok := s.dcs[d.Datacenter]
	if !ok {
		e = &dcEntry{firstSeen: now}
		s.dcs[d.Datacenter] = e
	}
	recovered := ok && e.wasStale
	gap := now.Sub(e.received)
	e.data = d
	e.received = now
	e.wasStale = false
	s.mu.Unlock()

	attrs := []any{"datacenter", d.Datacenter, "remote", remote,
		"nodes", len(d.Nodes), "clusters", len(d.Clusters), "vms", countVMs(d.Clusters)}
	switch {
	case !ok:
		slog.Info("datacenter reported for the first time", attrs...)
	case recovered:
		slog.Info("datacenter recovered", append(attrs, "silentFor", gap.Round(time.Second))...)
	default:
		slog.Debug("report received", attrs...)
	}
}

// checkStale logs datacenters that transitioned to stale since the last call.
func (s *dcStore) checkStale() {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for name, e := range s.dcs {
		age := now.Sub(e.received)
		if age > s.stale && !e.wasStale {
			e.wasStale = true
			slog.Warn("datacenter went stale: no report received", "datacenter", name,
				"lastReport", e.received.Format(time.RFC3339), "age", age.Round(time.Second))
		}
	}
}

func (s *dcStore) snapshot() HubData {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]DCStatus, 0, len(s.dcs))
	now := time.Now()
	for _, e := range s.dcs {
		out = append(out, DCStatus{StatusData: e.data, Stale: now.Sub(e.received) > s.stale})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Datacenter < out[j].Datacenter })
	return HubData{Datacenters: out, Updated: now.Format(time.RFC3339)}
}

func runHub(ctx context.Context, mux *http.ServeMux, broker *SSEBroker, hubToken string) {
	slog.Info("starting in hub mode", "auth", hubToken != "", "staleAfter", hubStaleAfter)
	if hubToken == "" {
		slog.Warn("HUB_TOKEN not set, accepting unauthenticated reports")
	}
	store := newDCStore(hubStaleAfter)

	reject := func(w http.ResponseWriter, r *http.Request, code int, msg string, attrs ...any) {
		slog.Warn("report rejected", append([]any{"remote", clientAddr(r), "status", code, "reason", msg}, attrs...)...)
		http.Error(w, msg, code)
	}

	mux.HandleFunc("/api/report", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			reject(w, r, http.StatusMethodNotAllowed, "POST only", "method", r.Method)
			return
		}
		if hubToken != "" {
			auth := r.Header.Get("Authorization")
			if !strings.HasPrefix(auth, "Bearer ") || subtle.ConstantTimeCompare([]byte(auth[7:]), []byte(hubToken)) != 1 {
				reject(w, r, http.StatusUnauthorized, "unauthorized")
				return
			}
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxReportBytes+1))
		if err != nil {
			reject(w, r, http.StatusBadRequest, "read error", "err", err)
			return
		}
		if len(body) > maxReportBytes {
			reject(w, r, http.StatusRequestEntityTooLarge, "report too large", "limitBytes", maxReportBytes)
			return
		}
		var sd StatusData
		if err := json.Unmarshal(body, &sd); err != nil {
			reject(w, r, http.StatusBadRequest, "bad json", "err", err, "bytes", len(body))
			return
		}
		if sd.Datacenter == "" {
			reject(w, r, http.StatusBadRequest, "datacenter field required")
			return
		}
		store.update(sd, clientAddr(r))
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(store.snapshot())
	})

	go func() {
		ticker := time.NewTicker(hubBroadcastEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				store.checkStale()
				if broker.ClientCount() == 0 {
					continue
				}
				jsonData, err := json.Marshal(store.snapshot())
				if err != nil {
					slog.Error("marshal hub snapshot", "err", err)
					continue
				}
				if dropped := broker.Broadcast(jsonData); dropped > 0 {
					slog.Debug("sse: dropped update for slow clients", "dropped", dropped)
				}
			}
		}
	}()
}
