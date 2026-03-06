package agentguard

import "time"

// GatewayTrace is the payload sent to POST /api/v1/traces.
type GatewayTrace struct {
	AgentID         string      `json:"agent_id"`
	SessionID       string      `json:"session_id,omitempty"`
	ToolName        string      `json:"tool_name"`
	ToolCall        interface{} `json:"tool_call,omitempty"`
	Observation     interface{} `json:"observation,omitempty"`
	HashChain       string      `json:"hash_chain"`
	Timestamp       time.Time   `json:"timestamp"`
	DurationMs      int64       `json:"duration_ms"`
	Model           string      `json:"model,omitempty"`
	InputTokens     int         `json:"input_tokens,omitempty"`
	OutputTokens    int         `json:"output_tokens,omitempty"`
	CostUsd         float64     `json:"cost_usd,omitempty"`
	RiskLevel       string      `json:"risk_level,omitempty"`
	Blocked         bool        `json:"blocked"`
	BlockReason     string      `json:"block_reason,omitempty"`
	PIIDetected     int         `json:"pii_detected,omitempty"`
	EvalScore       *int        `json:"eval_score,omitempty"`
}

// CheckRequest is the payload for POST /api/v1/check (blocking mode).
type CheckRequest struct {
	AgentID  string      `json:"agent_id"`
	ToolName string      `json:"tool_name"`
	ToolCall interface{} `json:"tool_call"`
}

// CheckResponse is the response from /api/v1/check.
type CheckResponse struct {
	Allowed   bool   `json:"allowed"`
	RiskLevel string `json:"risk_level"`
	Reason    string `json:"reason,omitempty"`
}
