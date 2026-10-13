# @justinnn/agentguard

JavaScript / TypeScript SDK for **AEGIS** — the firewall for AI agents.

Every tool call your agent makes is classified, policy-checked, and
recorded by the AEGIS gateway. This package auto-instruments the
common LLM clients (Anthropic, OpenAI, Vercel AI SDK, Mastra,
LangChain) so you get the full audit + blocking surface with one
line of code.

> **Looking for the full README, screenshots, deployment templates,
> and Cockpit dashboard?** Head to
> [github.com/Justin0504/Aegis](https://github.com/Justin0504/Aegis).
> This file is the SDK quickstart only.

## Install

```bash
npm install @justinnn/agentguard
```

You also need an AEGIS gateway running. Easiest: [download the
desktop app](https://github.com/Justin0504/Aegis/releases/latest)
(macOS arm64 .dmg, 164 MB; Windows / Linux in v0.2.x), or
`docker run -p 8080:8080 ghcr.io/aegis-sec/aegis-gateway:latest`.

## Quick start — auto-instrument

```ts
import agentguard from '@justinnn/agentguard'

agentguard.auto('http://localhost:8080', {
  agentId: 'my-agent',
  blockingMode: true,
})

// Your existing Anthropic / OpenAI / Vercel AI / Mastra code can
// stay completely unchanged. Every tool call now flows through
// AEGIS before it runs.
import Anthropic from '@anthropic-ai/sdk'
const client = new Anthropic()
```

### Where the decision is enforced

By default a blocked call throws `AgentGuardBlockedError` out of the
model call. With `enforceAt: 'tool'` the model-level patch only observes
and your own dispatcher decides, returning the refusal as the tool's
result so the model explains it and continues:

```ts
import { auto, guarded } from '@justinnn/agentguard'
auto('http://localhost:8080', { agentId: 'ops', blockingMode: true, enforceAt: 'tool' })
const execute = guarded(async (toolName, args) => runTool(toolName, args))
```

`check(toolName, args)` is the explicit form; `refusal(err)` the in-band
text. The agent's hash chain continues across restarts: the SDK reads
`GET /api/v1/traces/chain-head` before its first trace.

## Code Shield — static checks on agent-generated code

```ts
import ag from '@justinnn/agentguard'

const result = await ag.codeShield.scan({
  code: 'exec(user_input)',
  language: 'python',
  agentId: 'my-agent',
  gatewayUrl: 'http://localhost:8080',
})
// → { worst: 'CRITICAL', findings: [...], rules: ['py.exec'], ... }
```

Sub-millisecond, no LLM round-trip. 19 curated regex rules covering
`eval` / `exec` / `subprocess` / `rm -rf` / hardcoded AWS·OpenAI·
Anthropic·GitHub keys / PEM private blocks / dangerous SQL / DOM XSS.

The verdict also buffers in-process keyed by `agentId`; the SDK's
auto-instrumentation interceptor reads it on the next `/check` and
splices `code_shield.*` into the payload so Policy DSL rules like
`{ code_shield.worst: CRITICAL }` fire on the same hop.

## Alignment — does the next tool call serve the declared goal?

For agents whose chain-of-thought you can capture:

```ts
import { alignmentCheck } from '@justinnn/agentguard'

const verdict = await alignmentCheck({
  agentId: 'my-agent',
  declaredGoal: 'Summarise this week\'s customer-feedback survey.',
  thoughtChain: ['Thought: I should fetch the survey first.'],
  proposedAction: {
    tool_name: 'execute_sql',
    arguments: { sql: 'DELETE FROM audit_logs' },
  },
  gatewayUrl: 'http://localhost:8080',
})
// → { score: 0.18, drifted: true, signals: ['scope-expansion'], ... }
```

Same closed-loop bridge as Code Shield: the verdict flows into the
next `/check` payload automatically.

## Other entry points

| Import                                 | What it does                                   |
| -------------------------------------- | ---------------------------------------------- |
| `agentguard.auto(url, opts)`           | Patch all supported LLM SDKs at once           |
| `new AgentGuard(config)`               | Manual / explicit configuration                |
| `codeShieldScan({...})`                | Same as `ag.codeShield.scan`                   |
| `alignmentCheck({...})`                | Standalone alignment audit                     |
| `AgentGuardBlockedError`               | Thrown when `blockingMode` blocks a tool call  |

Full TypeScript types ship with the package.

## License

MIT. See the [parent repo](https://github.com/Justin0504/Aegis) for
the rest of AEGIS (gateway, Cockpit, CLI, deployment templates).
