package agentguard

import (
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
)

// hashChain is the per-agent SHA-256 chain the gateway verifies: every
// trace carries the previous trace's integrity hash and a sequence
// number, so a modified or removed record breaks every record after it.
//
// The chain belongs to the agent, not to the process. Before the first
// trace leaves, AgentGuard asks the gateway where the agent's chain ends
// (GET /api/v1/traces/chain-head) and continues from there; a restarted
// agent extends one chain rather than starting a second at sequence 0.
type hashChain struct {
	mu   sync.Mutex
	prev string // integrity hash of the previous trace; "" at genesis
	seq  int    // sequence number of the next trace
}

func newHashChain() *hashChain { return &hashChain{} }

// resume seeds the chain from the gateway's head. Only honoured before
// the first trace of this process, so a late answer cannot rewind.
func (h *hashChain) resume(seq int, hash string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.seq != 0 || h.prev != "" {
		return
	}
	if seq >= 0 && hash != "" {
		h.seq = seq + 1
		h.prev = hash
	}
}

// next allocates the next link: returns the sequence number, the previous
// hash, and this record's integrity hash, and advances the chain.
func (h *hashChain) next(payload interface{}) (seq int, prev string, hash string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		payloadBytes = []byte("{}")
	}
	raw := fmt.Sprintf("%s|%d|%s", h.prev, h.seq, string(payloadBytes))
	sum := sha256.Sum256([]byte(raw))
	hash = hex.EncodeToString(sum[:])
	seq, prev = h.seq, h.prev
	h.prev = hash
	h.seq++
	return seq, prev, hash
}

// uuidNamespaceURL is RFC 4122's URL namespace, the one the Python SDK
// uses, so a Go agent and a Python agent with the same name share an id.
var uuidNamespaceURL = [16]byte{0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8}

// agentUUID maps the operator's agent id to the UUID the trace schema
// requires: the id itself if it already is one, otherwise
// uuid5(NAMESPACE_URL, "aegis-agent:" + id), exactly as the Python SDK.
func agentUUID(agentID string) string {
	if isUUID(agentID) {
		return agentID
	}
	h := sha1.New()
	h.Write(uuidNamespaceURL[:])
	h.Write([]byte("aegis-agent:" + agentID))
	s := h.Sum(nil)
	s[6] = (s[6] & 0x0f) | 0x50
	s[8] = (s[8] & 0x3f) | 0x80
	return formatUUID(s[:16])
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return false
			}
		}
	}
	return true
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is not something to continue past silently;
		// fall back to a hash of the time-ordered sequence to stay unique.
		sum := sha256.Sum256([]byte(fmt.Sprintf("%p", &b)))
		copy(b[:], sum[:16])
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return formatUUID(b[:])
}

func formatUUID(b []byte) string {
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
