package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"sync"
)

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
	n := len(b.clients)
	b.mu.Unlock()
	slog.Debug("sse client subscribed", "clients", n)
	return c
}

func (b *SSEBroker) Unsubscribe(c *sseClient) {
	b.mu.Lock()
	delete(b.clients, c)
	close(c.ch)
	n := len(b.clients)
	b.mu.Unlock()
	slog.Debug("sse client unsubscribed", "clients", n)
}

func (b *SSEBroker) ClientCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.clients)
}

// Broadcast returns how many slow clients had the message dropped.
func (b *SSEBroker) Broadcast(data []byte) (dropped int) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for c := range b.clients {
		select {
		case c.ch <- data:
		default:
			dropped++
		}
	}
	return dropped
}

func (b *SSEBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		slog.Warn("sse: response writer does not support flushing", "remote", clientAddr(r))
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

// clientAddr prefers X-Forwarded-For since hub and agents sit behind ingresses.
func clientAddr(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}
	return r.RemoteAddr
}
