package agentguard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

const (
	defaultBatchSize  = 10
	defaultFlushEvery = 2 * time.Second
)

type transport struct {
	gatewayURL string
	apiKey     string
	client     *http.Client
	// How long Wrap waits for a person to decide a held (pending) call.
	approvalTimeout time.Duration
	pollInterval    time.Duration

	mu    sync.Mutex
	batch []GatewayTrace
	done  chan struct{}
}

func newTransport(gatewayURL, apiKey string) *transport {
	t := &transport{
		gatewayURL:      gatewayURL,
		apiKey:          apiKey,
		client:          &http.Client{Timeout: 10 * time.Second},
		approvalTimeout: 300 * time.Second,
		pollInterval:    time.Second,
		batch:           make([]GatewayTrace, 0, defaultBatchSize),
		done:            make(chan struct{}),
	}
	go t.flushLoop()
	return t
}

func (t *transport) enqueue(trace GatewayTrace) {
	t.mu.Lock()
	t.batch = append(t.batch, trace)
	flush := len(t.batch) >= defaultBatchSize
	t.mu.Unlock()
	if flush {
		t.flush()
	}
}

func (t *transport) flushLoop() {
	ticker := time.NewTicker(defaultFlushEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			t.flush()
		case <-t.done:
			t.flush()
			return
		}
	}
}

func (t *transport) flush() {
	t.mu.Lock()
	if len(t.batch) == 0 {
		t.mu.Unlock()
		return
	}
	traces := t.batch
	t.batch = make([]GatewayTrace, 0, defaultBatchSize)
	t.mu.Unlock()

	for _, trace := range traces {
		_ = t.send(trace)
	}
}

func (t *transport) send(trace GatewayTrace) error {
	body, err := json.Marshal(trace)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", t.gatewayURL+"/api/v1/traces", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if t.apiKey != "" {
		req.Header.Set("X-API-Key", t.apiKey)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("gateway returned %d", resp.StatusCode)
	}
	return nil
}

func (t *transport) check(agentID, toolName string, toolCall interface{}) (*CheckResponse, error) {
	req := CheckRequest{AgentID: agentID, ToolName: toolName, Arguments: toolCall, Blocking: true}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequest("POST", t.gatewayURL+"/api/v1/check", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if t.apiKey != "" {
		httpReq.Header.Set("X-API-Key", t.apiKey)
	}
	resp, err := t.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out CheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("gateway check failed: %d %s", resp.StatusCode, out.Error)
	}
	// A held call: poll until a person decides (or the hold expires server-side).
	if out.Decision == "pending" && out.CheckID != "" {
		deadline := time.Now().Add(t.approvalTimeout)
		for time.Now().Before(deadline) {
			time.Sleep(t.pollInterval)
			d, err := t.pollDecision(out.CheckID)
			if err != nil {
				continue
			}
			if d.Decision == "allow" || d.Decision == "block" {
				out.Decision = d.Decision
				if d.Reason != "" {
					out.Reason = d.Reason
				} else if d.Decision == "block" {
					out.Reason = "rejected by human reviewer"
				}
				break
			}
		}
		if out.Decision == "pending" {
			out.Decision, out.Reason = "block", "human approval timed out"
		}
	}
	out.Allowed = out.Decision == "allow" || (out.Decision == "" && out.Allowed)
	return &out, nil
}

func (t *transport) pollDecision(checkID string) (*CheckResponse, error) {
	httpReq, err := http.NewRequest("GET", t.gatewayURL+"/api/v1/check/"+checkID+"/decision", nil)
	if err != nil {
		return nil, err
	}
	if t.apiKey != "" {
		httpReq.Header.Set("X-API-Key", t.apiKey)
	}
	resp, err := t.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out CheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (t *transport) close() {
	close(t.done)
}
