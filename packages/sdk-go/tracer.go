package agentguard

import (
	"time"
)

// Wrap executes fn, records its result and duration, and sends a trace to the gateway.
//
// If BlockingMode is enabled, Wrap first checks with the gateway. If the call
// is blocked, fn is NOT executed and a *BlockedError is returned.
//
// toolCall is any serialisable value describing the call arguments (map, struct, etc.).
// It is stored verbatim in the gateway trace.
func (g *AgentGuard) Wrap(toolName string, toolCall interface{}, fn func() (interface{}, error)) (interface{}, error) {
	// Blocking pre-check
	if g.cfg.BlockingMode {
		check, err := g.transport.check(g.cfg.AgentID, toolName, toolCall)
		if err == nil && !check.Allowed {
			return nil, &BlockedError{
				ToolName:  toolName,
				Reason:    check.Reason,
				RiskLevel: check.RiskLevel,
			}
		}
	}

	start := time.Now()
	result, execErr := fn()
	durationMs := time.Since(start).Milliseconds()

	blocked := false
	blockReason := ""
	var errMsg string
	if execErr != nil {
		errMsg = execErr.Error()
	}

	hash := g.chain.next(g.cfg.AgentID, toolName, toolCall)

	trace := GatewayTrace{
		AgentID:    g.cfg.AgentID,
		SessionID:  g.cfg.SessionID,
		ToolName:   toolName,
		ToolCall:   toolCall,
		Observation: result,
		HashChain:  hash,
		Timestamp:  start,
		DurationMs: durationMs,
		Blocked:    blocked,
		BlockReason: blockReason,
	}
	if errMsg != "" {
		trace.Observation = map[string]string{"error": errMsg}
	}

	g.transport.enqueue(trace)
	return result, execErr
}

// WrapBlocked records a trace for a call that was blocked externally (e.g. by policy)
// without executing fn. This is useful when you handle blocking logic yourself.
func (g *AgentGuard) WrapBlocked(toolName string, toolCall interface{}, reason string) {
	hash := g.chain.next(g.cfg.AgentID, toolName, toolCall)
	trace := GatewayTrace{
		AgentID:     g.cfg.AgentID,
		SessionID:   g.cfg.SessionID,
		ToolName:    toolName,
		ToolCall:    toolCall,
		HashChain:   hash,
		Timestamp:   time.Now(),
		Blocked:     true,
		BlockReason: reason,
		RiskLevel:   "high",
	}
	g.transport.enqueue(trace)
}
