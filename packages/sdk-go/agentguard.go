// Package agentguard provides a Go SDK for the AgentGuard / AEGIS gateway.
//
// Usage:
//
//	guard := agentguard.Auto()
//	result, err := guard.Wrap("query_db", args, func() (any, error) {
//	    return db.Query("SELECT ...")
//	})
//	var blocked *agentguard.BlockedError
//	if errors.As(err, &blocked) {
//	    log.Printf("Blocked: %s", blocked.Reason)
//	}
package agentguard

import (
	"fmt"
	"os"
)

// Config holds AgentGuard connection settings.
type Config struct {
	// GatewayURL is the base URL of the AEGIS gateway (e.g. "http://localhost:8080").
	GatewayURL string

	// AgentID uniquely identifies this agent.
	AgentID string

	// APIKey is the dashboard API key (optional if gateway has no auth).
	APIKey string

	// SessionID groups related tool calls into a session (optional).
	SessionID string

	// BlockingMode: if true, check the gateway before executing the tool.
	// If the gateway blocks the call, Wrap returns a *BlockedError.
	BlockingMode bool
}

// BlockedError is returned by Wrap when the gateway blocks a tool call.
type BlockedError struct {
	ToolName  string
	Reason    string
	RiskLevel string
}

func (e *BlockedError) Error() string {
	return fmt.Sprintf("agentguard: tool %q blocked (risk=%s): %s", e.ToolName, e.RiskLevel, e.Reason)
}

// AgentGuard is the main SDK handle.
type AgentGuard struct {
	cfg       Config
	transport *transport
	chain     *hashChain
}

// Auto creates an AgentGuard using environment variables:
//   - AGENTGUARD_URL   (default: http://localhost:8080)
//   - AGENTGUARD_AGENT_ID
//   - AGENTGUARD_API_KEY
//   - AGENTGUARD_BLOCKING  ("true" to enable blocking mode)
func Auto() *AgentGuard {
	url := os.Getenv("AGENTGUARD_URL")
	if url == "" {
		url = "http://localhost:8080"
	}
	return New(Config{
		GatewayURL:   url,
		AgentID:      os.Getenv("AGENTGUARD_AGENT_ID"),
		APIKey:       os.Getenv("AGENTGUARD_API_KEY"),
		SessionID:    os.Getenv("AGENTGUARD_SESSION_ID"),
		BlockingMode: os.Getenv("AGENTGUARD_BLOCKING") == "true",
	})
}

// New creates an AgentGuard with the given Config.
func New(cfg Config) *AgentGuard {
	if cfg.AgentID == "" {
		cfg.AgentID = "go-agent"
	}
	return &AgentGuard{
		cfg:       cfg,
		transport: newTransport(cfg.GatewayURL, cfg.APIKey),
		chain:     newHashChain(),
	}
}

// Close flushes any pending traces and stops background goroutines.
// Call this with defer in your main function.
func (g *AgentGuard) Close() {
	g.transport.close()
}
