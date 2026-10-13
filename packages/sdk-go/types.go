package agentguard

// GatewayTrace is the payload sent to POST /api/v1/traces. It is the
// gateway's AgentActionTrace schema (packages/core-schema), the same
// record the Python and JS SDKs send, so Go traces land in the same
// table, join the same per-agent hash chain, and verify with the same
// integrity check.
type GatewayTrace struct {
	TraceID        string       `json:"trace_id"`
	AgentID        string       `json:"agent_id"`
	SessionID      string       `json:"session_id,omitempty"`
	Timestamp      string       `json:"timestamp"`
	SequenceNumber int          `json:"sequence_number"`
	InputContext   InputContext `json:"input_context"`
	ThoughtChain   ThoughtChain `json:"thought_chain"`
	ToolCall       ToolCall     `json:"tool_call"`
	Observation    Observation  `json:"observation"`
	IntegrityHash  string       `json:"integrity_hash"`
	PreviousHash   string       `json:"previous_hash,omitempty"`
	// Decision metadata, when Wrap took a decision before running the tool.
	SafetyValidation *SafetyValidation `json:"safety_validation,omitempty"`
	ApprovalStatus   string            `json:"approval_status,omitempty"`
	Environment      string            `json:"environment"`
	Version          string            `json:"version"`
}

// InputContext is what the agent was asked; Wrap records the tool name.
type InputContext struct {
	Prompt string `json:"prompt"`
}

// ThoughtChain is the model's reasoning, which Wrap cannot see.
type ThoughtChain struct {
	RawTokens   string   `json:"raw_tokens"`
	ParsedSteps []string `json:"parsed_steps"`
}

// ToolCall is the call as the gateway stores it.
type ToolCall struct {
	ToolName  string                 `json:"tool_name"`
	Function  string                 `json:"function"`
	Arguments map[string]interface{} `json:"arguments"`
	Timestamp string                 `json:"timestamp"`
}

// Observation is what the tool returned.
type Observation struct {
	RawOutput  interface{}            `json:"raw_output"`
	Error      *string                `json:"error,omitempty"`
	DurationMs float64                `json:"duration_ms"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

// SafetyValidation carries the gateway's pre-execution decision.
type SafetyValidation struct {
	PolicyName string   `json:"policy_name"`
	Passed     bool     `json:"passed"`
	Violations []string `json:"violations,omitempty"`
	RiskLevel  string   `json:"risk_level"`
}

// CheckRequest is the payload for POST /api/v1/check.
type CheckRequest struct {
	AgentID   string      `json:"agent_id"`
	ToolName  string      `json:"tool_name"`
	Arguments interface{} `json:"arguments"`
	Blocking  bool        `json:"blocking"`
}

// CheckResponse is the response from POST /api/v1/check. The gateway
// answers with a decision (allow | block | pending); Allowed is derived
// from it once a pending call has been decided.
type CheckResponse struct {
	Decision  string `json:"decision"`
	CheckID   string `json:"check_id,omitempty"`
	Allowed   bool   `json:"allowed"`
	RiskLevel string `json:"risk_level"`
	Reason    string `json:"reason,omitempty"`
	Error     string `json:"error,omitempty"`
	// Held is true when the call was pending and a person (or the hold's
	// expiry) decided it; the trace is then APPROVED rather than AUTO_APPROVED.
	Held bool `json:"-"`
}

// chainHead is the response from GET /api/v1/traces/chain-head.
type chainHead struct {
	SequenceNumber int    `json:"sequence_number"`
	IntegrityHash  string `json:"integrity_hash"`
}
