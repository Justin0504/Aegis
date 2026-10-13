| Harness | Path | Model | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|---|
| Anthropic SDK tool loop | SDK auto() | Claude Haiku 4.5 | allow · 5 ms | block · in-band (helper) · 4 ms | held (3 s at the queue) → allow | model declined |
| OpenAI SDK tool loop | SDK auto() | GPT-4o-mini | allow · 6 ms | block · in-band (helper) · 4 ms | held 4 s → allow | block · L$_\mathrm{p$ · 6 ms |
| LiteLLM tool loop | SDK auto() | Claude Haiku 4.5 | allow · 2 ms | block · in-band (helper) · 3 ms | held 4 s → allow | model declined |
| Qwen3-8B on Ollama (RL-trained, local) | manual check (10 lines) | Qwen3-8B | allow · 9 ms | block · in-band · 4 ms | held 4 s → allow | no ledger |
| Go SDK Wrap | SDK (Go) | --- (explicit) | allow · 8 ms | block · in-band · 2 ms | held → allow | no ledger |
| JS SDK + Anthropic | SDK auto() (JS) | Claude Haiku 4.5 | allow | block · in-band (helper) | held → allow | no ledger |
| LangGraph ReAct agent | SDK auto() | Claude Haiku 4.5 | allow · 2 ms | block · handler · 3 ms | held 4 s → allow | model declined |
| CrewAI | SDK auto() | Claude Haiku 4.5 | allow · 3 ms | block · in-band · 3 ms | held 4 s → allow | block · L$_\mathrm{p$ · 3 ms |
| AutoGen 0.4 (agentchat) | SDK auto() | GPT-4o-mini | allow · 2 ms | block · in-band · 2 ms | held 4 s → allow | block · L$_\mathrm{p$ · 9 ms |
| LlamaIndex FunctionAgent | SDK auto() | GPT-4o-mini | allow · 3 ms | block · in-band · 2 ms | held 4 s → allow | block · L$_\mathrm{p$ · 7 ms |
| smolagents ToolCallingAgent | SDK auto() | Claude Haiku 4.5 | allow · 3 ms | block · in-band · 5 ms | held 4 s → allow | held · not L$_\mathrm{p$ · 4 ms |
| Pydantic AI | SDK auto() | Claude Haiku 4.5 | allow · 3 ms | block · in-band · 3 ms | held 4 s → allow | held · not L$_\mathrm{p$ · 5 ms |
| OpenAI Agents SDK (Responses API) | SDK auto() | GPT-4o-mini | allow · 2 ms | block · in-band · 2 ms | held 4 s → allow | block · L$_\mathrm{p$ · 8 ms |
| OpenAI Agents SDK (chat completions) | SDK auto() | GPT-4o-mini | allow · 3 ms | block · in-band · 3 ms | held 4 s → allow | block · L$_\mathrm{p$ · 9 ms |
| Claude Agent SDK (Claude Code runtime) | PreToolUse hook | Claude Code | allow · 8 ms | block · in-band · 12 ms | held → allow | no ledger |
| Google GenAI function calling | SDK auto() | Gemini Flash (3.8; 3-preview for S2) | n/a | provider 503 | provider 429 | provider 429 |
| MCP stdio proxy (Claude Desktop shape) | MCP proxy | --- (host) | allow · 14 ms | block · in-band · 11 ms | held → allow | no ledger |
| Egress proxy → OpenAI | egress proxy | GPT-4o-mini | allow · 1013 ms | block · inline · 891 ms | block (proxy cannot hold) | no ledger |
| Egress proxy → Ollama (self-hosted) | egress proxy | Qwen2.5-7B | allow · 3486 ms | block · inline · 963 ms | block (proxy cannot hold) | no ledger |
