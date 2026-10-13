| Harness | Path | Model | S1 | S2 | S3 |
|---|---|---|---|---|---|
| Anthropic SDK tool loop | SDK auto() | Claude Haiku 4.5 | allow · 7 ms | block · handler · 4 ms | held → allow, 3 s |
| OpenAI SDK tool loop | SDK auto() | GPT-4o-mini | allow · 4 ms | block · handler · 4 ms | held → allow, 3 s |
| LiteLLM tool loop | SDK auto() | Claude Haiku 4.5 | allow · 4 ms | block · 3 ms | held → allow, 3 s |
| Qwen3-8B on Ollama (RL-trained, local) | manual check (10 lines) | Qwen3-8B | allow · 3 ms | block · in-band · 4 ms | held → allow, 3 s |
| Go SDK Wrap | SDK (Go) | --- (explicit) | allow · 5 ms | block · in-band · 2 ms | held → allow, 3 s |
| JS SDK + Anthropic | SDK auto() (JS) | Claude Haiku 4.5 | allow | block · handler | held → allow, 3 s |
| LangGraph ReAct agent | SDK auto() | Claude Haiku 4.5 | allow · 8 ms | block · handler · 5 ms | held → allow, 3 s |
| CrewAI | SDK auto() | Claude Haiku 4.5 | allow · 8 ms | block · in-band · 5 ms | held → allow, 3 s |
| AutoGen 0.4 (agentchat) | SDK auto() | GPT-4o-mini | allow · 6 ms | block · in-band · 6 ms | held → allow, 3 s |
| LlamaIndex FunctionAgent | SDK auto() | GPT-4o-mini | allow · 14 ms | block · in-band · 7 ms | held → allow, 3 s |
| smolagents ToolCallingAgent | SDK auto() | Claude Haiku 4.5 | allow · 5 ms | block · in-band · 5 ms | held → allow, 3 s |
| Pydantic AI | SDK auto() | Claude Haiku 4.5 | allow · 5 ms | block · in-band · 4 ms | held → allow, 3 s |
| OpenAI Agents SDK (Responses API) | SDK auto() | GPT-4o-mini | allow · 6 ms | block · in-band · 4 ms | held → allow, 3 s |
| OpenAI Agents SDK (chat completions) | SDK auto() | GPT-4o-mini | allow · 3 ms | block · in-band · 4 ms | held → allow, 3 s |
| Claude Agent SDK (Claude Code runtime) | PreToolUse hook | Claude Code | allow · 7 ms | block · in-band · 11 ms | held → allow, 3 s |
| Google GenAI function calling | SDK auto() | Gemini Flash | allow · 6 ms | block · handler · 5 ms | held → allow, 3 s |
| MCP stdio proxy (Claude Desktop shape) | MCP proxy | --- (host) | allow · 12 ms | block · in-band · 7 ms | held → allow, 3 s |
| Egress proxy → OpenAI | egress proxy | GPT-4o-mini | allow · 841 ms | block · inline · 751 ms | block (proxy cannot hold) |
| Egress proxy → Ollama (self-hosted) | egress proxy | Qwen2.5-7B | allow · 1359 ms | block · inline · 906 ms | block (proxy cannot hold) |
