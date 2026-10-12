| Harness | Path | Model | S1 | S2 | S3 |
|---|---|---|---|---|---|
| Anthropic SDK tool loop | SDK auto() | Claude Haiku 4.5 | allow · 7 ms | block · handler · 4 ms | pending |
| OpenAI SDK tool loop | SDK auto() | GPT-4o-mini | allow · 4 ms | block · handler · 4 ms | pending |
| LiteLLM tool loop | SDK auto() | Claude Haiku 4.5 | allow · 4 ms | block · 3 ms | pending |
| Qwen3-8B on Ollama (RL-trained, local) | manual check (10 lines) | Qwen3-8B | allow · 3 ms | block · in-band · 4 ms | pending |
| Go SDK Wrap | SDK (Go) | --- (explicit) | allow · 5 ms | block · in-band · 2 ms | allow |
| JS SDK + Anthropic | SDK auto() (JS) | Claude Haiku 4.5 | allow | block · handler | allow |
| LangGraph ReAct agent | SDK auto() | Claude Haiku 4.5 | allow · 5 ms | block · handler · 4 ms | pending |
| CrewAI | SDK auto() | Claude Haiku 4.5 | allow · 3 ms | block · escaped · 4 ms | pending |
| AutoGen 0.4 (agentchat) | SDK auto() | GPT-4o-mini | allow · 6 ms | block · escaped · 3 ms | pending |
| LlamaIndex FunctionAgent | SDK auto() | GPT-4o-mini | allow · 9 ms | block · escaped · 5 ms | pending |
| smolagents ToolCallingAgent | SDK auto() | Claude Haiku 4.5 | allow · 3 ms | block · in-band · 3 ms | pending |
| Pydantic AI | SDK auto() | Claude Haiku 4.5 | allow · 3 ms | block · escaped · 5 ms | pending |
| OpenAI Agents SDK (Responses API) | SDK auto() | GPT-4o-mini | allow · 3 ms | block · escaped · 3 ms | pending |
| OpenAI Agents SDK (chat completions) | SDK auto() | GPT-4o-mini | allow · 5 ms | block · escaped · 3 ms | pending |
| Claude Agent SDK (Claude Code runtime) | PreToolUse hook | Claude Code | allow · 7 ms | block · in-band · 11 ms | pending |
| Google GenAI function calling | SDK auto() | Gemini Flash | allow · 6 ms | block · handler · 5 ms | pending |
| MCP stdio proxy (Claude Desktop shape) | MCP proxy | --- (host) | allow · 12 ms | block · in-band · 7 ms | allow |
| Egress proxy → OpenAI | egress proxy | GPT-4o-mini | allow · 841 ms | block · inline · 751 ms | block |
| Egress proxy → Ollama (self-hosted) | egress proxy | Qwen2.5-7B | allow · 1359 ms | block · inline · 906 ms | block |
