package agentguard

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
)

// hashChain maintains a running SHA-256 chain matching the gateway schema.
type hashChain struct {
	mu   sync.Mutex
	prev string
}

func newHashChain() *hashChain { return &hashChain{prev: "genesis"} }

func (h *hashChain) next(agentID, toolName string, payload interface{}) string {
	h.mu.Lock()
	defer h.mu.Unlock()

	payloadBytes, _ := json.Marshal(payload)
	raw := fmt.Sprintf("%s|%s|%s|%s", h.prev, agentID, toolName, string(payloadBytes))
	sum := sha256.Sum256([]byte(raw))
	hash := hex.EncodeToString(sum[:])
	h.prev = hash
	return hash
}
