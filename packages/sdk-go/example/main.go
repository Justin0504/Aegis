package main

import (
	"errors"
	"fmt"
	"log"

	agentguard "github.com/Justin0504/Aegis/packages/sdk-go"
)

func main() {
	// Auto-configure from environment variables:
	//   AGENTGUARD_URL        (default: http://localhost:8080)
	//   AGENTGUARD_AGENT_ID
	//   AGENTGUARD_API_KEY
	//   AGENTGUARD_BLOCKING   (set to "true" to block high-risk calls)
	guard := agentguard.Auto()
	defer guard.Close()

	// Wrap a simulated tool call
	result, err := guard.Wrap("read_file", map[string]string{"path": "/etc/passwd"}, func() (interface{}, error) {
		// Simulate actual tool execution
		return map[string]string{"content": "root:x:0:0:root:/root:/bin/bash\n..."}, nil
	})

	var blocked *agentguard.BlockedError
	if errors.As(err, &blocked) {
		log.Printf("Call blocked by gateway: %s (risk=%s)", blocked.Reason, blocked.RiskLevel)
		return
	}
	if err != nil {
		log.Fatalf("Tool error: %v", err)
	}

	fmt.Printf("Result: %v\n", result)

	// Example with explicit config
	guard2 := agentguard.New(agentguard.Config{
		GatewayURL:   "http://localhost:8080",
		AgentID:      "my-go-agent",
		APIKey:       "your-api-key",
		BlockingMode: false,
	})
	defer guard2.Close()

	_, _ = guard2.Wrap("search_web", map[string]string{"query": "golang best practices"}, func() (interface{}, error) {
		return []string{"result1", "result2"}, nil
	})

	fmt.Println("Traces sent to AgentGuard gateway.")
}
