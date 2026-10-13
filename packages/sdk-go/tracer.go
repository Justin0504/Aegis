package agentguard

import (
	"encoding/json"
	"time"
)

const sdkVersion = "1.0.0"

// Wrap executes fn, records its result and duration, and sends a trace to the gateway.
//
// If BlockingMode is enabled, Wrap first checks with the gateway. If the call
// is blocked, fn is NOT executed and a *BlockedError is returned. A call the
// gateway holds for a person blocks here until that person decides.
//
// toolCall is any serialisable value describing the call arguments (map, struct, etc.).
// It is stored as the trace's tool arguments.
func (g *AgentGuard) Wrap(toolName string, toolCall interface{}, fn func() (interface{}, error)) (interface{}, error) {
	var validation *SafetyValidation
	approval := ""

	// Blocking pre-check
	if g.cfg.BlockingMode {
		check, err := g.transport.check(g.cfg.AgentID, toolName, toolCall)
		if err == nil {
			validation = &SafetyValidation{
				PolicyName: "gateway",
				Passed:     check.Allowed,
				RiskLevel:  normaliseRisk(check.RiskLevel),
			}
			if check.Allowed && check.Held {
				approval = "APPROVED"
			} else if check.Allowed {
				approval = "AUTO_APPROVED"
			}
			if !check.Allowed {
				validation.Violations = []string{check.Reason}
				g.record(toolName, toolCall, nil, check.Reason, 0, validation, "REJECTED")
				return nil, &BlockedError{
					ToolName:  toolName,
					Reason:    check.Reason,
					RiskLevel: check.RiskLevel,
				}
			}
		}
	}

	start := time.Now()
	result, execErr := fn()
	durationMs := float64(time.Since(start).Microseconds()) / 1000.0

	errMsg := ""
	if execErr != nil {
		errMsg = execErr.Error()
	}
	g.record(toolName, toolCall, result, errMsg, durationMs, validation, approval)
	return result, execErr
}

// WrapBlocked records a trace for a call that was blocked externally (e.g. by policy)
// without executing fn. This is useful when you handle blocking logic yourself.
func (g *AgentGuard) WrapBlocked(toolName string, toolCall interface{}, reason string) {
	g.record(toolName, toolCall, nil, reason, 0, &SafetyValidation{
		PolicyName: "external",
		Passed:     false,
		Violations: []string{reason},
		RiskLevel:  "HIGH",
	}, "REJECTED")
}

// record builds one trace in the gateway's schema, links it into the
// agent's hash chain, and enqueues it.
func (g *AgentGuard) record(toolName string, toolCall interface{}, result interface{}, errMsg string,
	durationMs float64, validation *SafetyValidation, approval string) {
	g.resumeOnce.Do(g.resumeChain)

	args := toArguments(toolCall)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if durationMs <= 0 {
		durationMs = 0.001 // the schema wants a positive duration; a refused call took none
	}
	obs := Observation{RawOutput: result, DurationMs: durationMs}
	if errMsg != "" {
		obs.Error = &errMsg
	}
	payload := struct {
		Tool string                 `json:"tool"`
		Args map[string]interface{} `json:"args"`
		Out  interface{}            `json:"out"`
		Err  string                 `json:"err"`
		At   string                 `json:"at"`
	}{toolName, args, result, errMsg, now}
	seq, prev, hash := g.chain.next(payload)

	trace := GatewayTrace{
		TraceID:          newUUID(),
		AgentID:          g.agentUUID,
		SessionID:        g.cfg.SessionID,
		Timestamp:        now,
		SequenceNumber:   seq,
		InputContext:     InputContext{Prompt: toolName},
		ThoughtChain:     ThoughtChain{RawTokens: "Recorded via Go SDK Wrap", ParsedSteps: []string{}},
		ToolCall:         ToolCall{ToolName: toolName, Function: toolName, Arguments: args, Timestamp: now},
		Observation:      obs,
		IntegrityHash:    hash,
		PreviousHash:     prev,
		SafetyValidation: validation,
		ApprovalStatus:   approval,
		Environment:      "DEVELOPMENT",
		Version:          sdkVersion,
	}
	g.transport.enqueue(trace)
}

// resumeChain continues the agent's chain from the gateway's head. Any
// failure leaves a fresh chain, which is what the SDK did before.
func (g *AgentGuard) resumeChain() {
	head, err := g.transport.chainHead(g.agentUUID)
	if err != nil || head == nil {
		return
	}
	g.chain.resume(head.SequenceNumber, head.IntegrityHash)
}

// toArguments turns whatever the caller passed as the tool call into the
// map the schema requires: maps pass through, structs are marshalled,
// anything else is wrapped as {"value": ...}.
func toArguments(toolCall interface{}) map[string]interface{} {
	switch v := toolCall.(type) {
	case nil:
		return map[string]interface{}{}
	case map[string]interface{}:
		return v
	}
	b, err := json.Marshal(toolCall)
	if err == nil {
		var m map[string]interface{}
		if json.Unmarshal(b, &m) == nil && m != nil {
			return m
		}
	}
	return map[string]interface{}{"value": toolCall}
}

func normaliseRisk(r string) string {
	switch r {
	case "LOW", "MEDIUM", "HIGH", "CRITICAL":
		return r
	case "low":
		return "LOW"
	case "medium":
		return "MEDIUM"
	case "critical":
		return "CRITICAL"
	case "high":
		return "HIGH"
	}
	return "LOW"
}
