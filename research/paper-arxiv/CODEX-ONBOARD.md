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
| `apps/compliance-cockpit` | Next.js Cockpit; build with `NEXT_PUBLIC_USE_MOCK_TRACES=false` for real data |

## How to run the matrix

```
cd research/compat
.venv/bin/python run_compat.py                 # all 19 rows × 3 scenarios, ~20 min, writes results/
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
DB=$(ls -t /tmp/aegis-compat-main-*.db | head -1)
(cd packages/gateway-mcp && PORT=18080 DB_PATH=$DB AEGIS_LICENSE_TIER=enterprise node dist/server.js &)
(cd apps/compliance-cockpit && GATEWAY_URL=http://127.0.0.1:18080 npx next start -p 13003 &)
KEY=$(curl -s http://127.0.0.1:18080/api/v1/auth/key | jq -r .api_key)
cd research/compat/js && node shoot.mjs http://127.0.0.1:13003 http://127.0.0.1:18080 $KEY ../results/ui
```
Stage held calls first (POST `/api/v1/check` with `blocking: true` and a
`kubectl delete …` command) so the approvals view has cards.

## Open tasks (in priority order)

1. **Figures F2, F3, F5** per `CODEX-FIGURE-BRIEF.md`. Drop the files into
   `images/`, same names; the LaTeX does not change. Run the five checks in
   the brief before handing back. F1 (architecture) exists but should be
   redrawn to the two-row spec in the brief.
2. **In-band refusals for model-level patches.** Rows marked *escaped* in
   Table `tab:compat` are frameworks where the SDK can only raise inside the
   model call (plain SDK loops are *handler*: three lines in the agent
   loop). For the OpenAI Agents SDK the right hook is a `FunctionTool`
   wrapper that returns the refusal as the tool's output; LiteLLM and Gemini
   have no tool-execution hook and stay *handler*. Any change must be
   re-run through the matrix and the table regenerated.
3. **`demo/live-agent/app.py`** still calls `/api/v1/check` by hand; the
   paper says the demo agent uses `agentguard.auto(blocking_mode=True)`.
   Migrate it (the S1–S3 flow and the in-band refusal must survive) or the
   paper's §3 "Setup" paragraph must say what the app really does.
4. **Cockpit**: the topbar's "0/N chains" is red whenever SDK signing is
   off (`enable_signing=False` in `auto()`); show it neutral with a
   tooltip. The Activity chart on the overview shows 0 actions for the
   last 24 h while the counter shows N — find the bucketing bug.
5. ~~Streaming on the Anthropic patch~~ — done 2026-10-13 (events are
   assembled and checked at `message_stop`; verified with a live streamed
   `curl | sh` call). `messages.stream()` (the helper) is untested.

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
