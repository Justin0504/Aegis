# Codex onboarding — AEGIS demo paper, arXiv v2 (replaces 2603.12621)

You are joining a paper + product that are kept honest against each other:
every claim in `aegis.tex` was checked against `packages/` on 2026-10-12/13,
and a compatibility matrix in `research/compat/` drives the shipping gateway
with nineteen real agent harnesses. Your job is to finish what is listed
under **Open tasks**, in the same discipline: nothing goes in the paper that
the code does not do, and nothing goes in a figure that the brief does not
state.

## Map

| path | what |
|---|---|
| `research/paper-arxiv/aegis.tex` + `sections/*.tex` | the paper (acmart sigconf). `tectonic aegis.tex` builds it; 15 pages, 0 undefined refs is the bar. |
| `research/paper-arxiv/figures/table_compat.tex` | **generated** by `research/compat/make_table.py` — never edit by hand |
| `research/paper-arxiv/images/ui/*.png` | Cockpit screenshots, taken by `research/compat/js/shoot.mjs` against a live gateway — never mock |
| `research/paper-arxiv/images/{provenance_mechanism,rollout_construction,audit_chain}.pdf` | **placeholders** you replace (see `CODEX-FIGURE-BRIEF.md`) |
| `research/paper-arxiv/package_for_arxiv.py` | clean-room tarball; run it before any hand-off |
| `research/compat/` | the matrix: `run_compat.py` (gateways + approver), `harnesses.py` (one function per harness), `common.py` (scenarios, tools, DSL rule), `make_table.py`, `js/`, `go/`, `results/` |
| `packages/gateway-mcp` | the gateway (Node/Express/SQLite). `npm run build` → `dist/`; `npx jest` must stay green (1360 tests) |
| `packages/sdk-python` | `agentguard.auto(blocking_mode=True)` patches 15 targets; `integrations/claude_agent_sdk.py` is the PreToolUse hook |
| `packages/sdk-js`, `packages/sdk-go` | JS (`auto()`), Go (`Wrap`) |
| `apps/compliance-cockpit` | Next.js Cockpit; real data by default; `NEXT_PUBLIC_USE_MOCK_TRACES=true` opts into the demo fixtures |

## How to run the matrix

```
cd research/compat
.venv/bin/python run_compat.py                 # all 19 rows × 4 scenarios (S4 = indirect injection, Lp), ~45 min, writes results/
.venv/bin/python run_compat.py crewai S2       # (harness names: see harnesses.py HARNESSES)
.venv/bin/python make_table.py                 # → paper table + results/COMPAT.md
```
Keys: `ANTHROPIC_API_KEY` from `~/.anthropic.env`, `OPENAI_API_KEY` from
`~/chronoception/.env` (the runner reads both; file keys override the shell),
`GEMINI_API_KEY` from `~/Dynabridge/backend/.env`. Ollama must be running with
`qwen3:8b` and `qwen2.5:7b` pulled. Each harness runs in its own process
because `auto()` patches SDKs process-wide. Port 18080/18081 must be free
(`pkill -f "node dist/server.js"`). Use the nvm Node 22, not Homebrew's
(better-sqlite3 is built against it).

## How to screenshot the Cockpit

```
cd research/compat && bash shoot_cockpit.sh /tmp/aegis-compat-main-<ts>.db   # → paper-arxiv/images/ui/*.png
```

The script does the whole thing: `sqlite3 .backup` of the matrix DB (never
`cp` — WAL), a gateway on :18085 with the model keys loaded, `next start`
on :13003 with `GATEWAY_URL` set (the Cockpit's server-side proxy reads
that env, `NEXT_PUBLIC_` alone is not enough), then `js/shoot.mjs`, which
hides toasts, opens the first trace's detail pane, runs a scan on the demo
agent and an alignment audit before capturing. Build the Cockpit first
(`npm run build`); demo fixtures are opt-in (`NEXT_PUBLIC_USE_MOCK_TRACES=true`),
a plain build shows the gateway.

## Open tasks (in priority order)

1. ~~Figures F1, F2, F3, F5~~ — drawn 2026-10-13 with figkit
   (`figures_src/fig_architecture.py`, `fig_provenance.py`, `fig_rollout.py`,
   `fig_audit.py`). F2's values are computed on corpus record
   `ds_enhanced::219` with `cascade/provenance.py` (see the docstring);
   F3's numbers are §4.2's; F1 is the two-row layout of the brief. Type
   floor 12 units, fonts embedded (`pdffonts`), checked at print size
   (`pdftoppm -r 100`). If you touch them, re-run the five checks in
   `CODEX-FIGURE-BRIEF.md`.
2. ~~In-band refusals for framework rows~~ — done 2026-10-13: every
   framework row is in-band via `enforce_at="tool"`. Plain SDK loops,
   LiteLLM and Google GenAI now use the one-line helper
   `execute_tool = agentguard.guarded(execute_tool)` (`agentguard.check` /
   `acheck` / `refusal` are the pieces); the table marks them
   *in-band (helper)*.
3. ~~`demo/live-agent/app.py`~~ — migrated 2026-10-13 to
   `agentguard.auto(..., blocking_mode=True, enforce_at="tool")` +
   `agentguard.guarded`; it installs its own `hold-send-report` DSL rule
   at start (merging with the tenant's rules). Hand-rolled `/check`,
   polling and trace posting are gone.
4. ~~Cockpit "0/N chains"~~ — this was **not** cosmetic: every SDK
   process started a new chain at sequence 0, so any restarted agent
   failed verification. Fixed 2026-10-13: `GET /api/v1/traces/chain-head`
   (open route) + `AgentGuard.resume_chain()` in the Python SDK and the
   same in the JS tracer (traces built before the head arrives are
   deferred in order). The tooltip now says what a broken chain means.
   The Activity chart bucketing bug was fixed earlier (naive-UTC parse).
5. ~~Streaming on the Anthropic patch~~ — done 2026-10-13 (events are
   assembled and checked at `message_stop`; verified with a live streamed
   `curl | sh` call). `messages.stream()` (the helper) is untested.
6. ~~Go SDK chain resumption~~ — done 2026-10-13, and more was wrong:
   its traces were not in the gateway's schema and `Close()` returned
   before the final flush, so no Go trace had ever reached the gateway.
   `types.go` now mirrors `AgentActionTrace`, agent ids map to the same
   uuid5 as the Python SDK, and chains resume from `chain-head`.
7. **Violations table** had foreign keys to `policies(id)` and
   `traces(trace_id)`; every `/check` block or hold failed to insert
   ("hit-rate stats will undercount" in the gateway log). Fixed by a
   rebuild-on-open migration (`db/database.ts`); if you see that warning
   again, something re-added a constraint.
8. **Decisions in traces**: the Python SDK now writes the gateway's
   verdict into each trace (`safety_validation`, `approval_status`:
   AUTO_APPROVED / APPROVED / REJECTED). The Cockpit's Violations page
   lists traces with a failed validation while the status bar counts the
   gateway's `violations` table; after a full matrix run the two agree.
   The JS SDK has `enforceAt: 'tool'` + `check/guarded/refusal` like
   Python; `js/agent.cjs` uses them.
9. **Gemini**: Google's API returns 503/429 on a large fraction of calls;
   `harnesses.py` retries transient errors (`_gemini_call`) and defaults to
   `gemini-3.8-flash` (`COMPAT_GEMINI_MODEL` overrides; the key's model
   list is at `generativelanguage.googleapis.com/v1beta/models`).
10. **MCP proxy traces** (`agentguard/mcp_proxy.py`) now go through the
    SDK's trace builder (schema, chain-head resume, decision fields) and
    are sent synchronously from a non-daemon thread; the proxy flushes on
    exit. Before this, every forwarded call raised in the trace step
    (missing `timezone` import) and the record would have been rejected
    anyway. Agent id for the matrix row is `compat-mcp`.
11. **Demo model**: `demo/live-agent` defaults to `claude-haiku-4-5`
   (`AEGIS_DEMO_MODEL` overrides). Sonnet 4.5 declines the S2 payload on
   its own; Haiku emits it 5/5 with the neutral system prompt and ~1/3
   with a prompt that names the firewall. Do not put "AEGIS" or
   "compliance" back into the agent's system prompt.

## Rules

- Numbers in the paper come from `research/compat/results/`, the research
  harness (`research/selective`, `research/benchmark`), or the code. If you
  cannot point to the file, the number does not go in.
- Figures: `reference/figkit` language — white, Geist, hairlines, colour
  only for allow/block/pending/untrusted and one accent; 12-unit type floor
  on a 1000-wide canvas; look at the rendered PNG, not the code.
- Commits: one topic per commit, message explains *why*, ends with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` if Claude
  wrote it with you. Do not push `research/compat/results/` transcripts
  that contain keys (they should not; check).
- The arXiv upload needs co-author sign-off (Zhiyuan Su, Yue Zhao): v2
  withdraws a shared result.
