# Codex onboarding — AEGIS paper, arXiv v2 (replaces 2603.12621)

Updated 2026-10-26 for **round 3** (figures). The paper and the product are
kept honest against each other: every claim in `aegis.tex` was checked
against `packages/`, and figures are checked against result files by a
script, not by eye. Your job is the figure round below, in that
discipline: nothing goes in a figure that a file does not say, and nothing
goes in a caption that the product does not do.

## Read, in this order (≈20 min)

1. This file, all of it.
2. `CODEX-FIGURE-BRIEF-v3.md` — what to draw (every slot, its content, its data).
3. `CODEX-FIGURE-BRIEF.md` — **only** "Palette and type" and "Checks"; they apply to every figure.
4. `aegis.pdf` — find each grey `PLACEHOLDER` box and read the paragraph around it.
5. `figdata/plots.json`, `figdata/gallery.json` (search `"pick"`), `figdata/captures/`.

## Environment (verified on this machine 2026-10-26)

| need | how |
|---|---|
| figkit (figures) | system `python3` (3.14) **run from `research/`** — `figkit/` is a package there, not installed; needs `python-pptx`, `Pillow` (present). Fonts Geist / Geist Mono are in `~/Library/Fonts`. Icons are cached in `research/figkit/assets/icons/tabler/`; fetching a new one needs network and a non-default User-Agent (see `figkit/icons.py`). |
| SDK, MCP, captures | `research/compat/.venv/bin/python` — has `agentguard` (editable, from `packages/sdk-python`), `mcp`, `cryptography`. System python cannot import `agentguard` (`agentguard_core_schema` missing). |
| gateway | `cd packages/gateway-mcp && npm run build` → `node dist/server.js`. Use **nvm Node 22** (`~/.nvm/versions/node/v22.21.1`), not 20 and not Homebrew's — better-sqlite3 is built against 22. |
| Cockpit | `apps/compliance-cockpit`, built (`.next/` is current as of 10-21; rebuild with `npm run build` if you change it). `next start` needs `GATEWAY_URL` (server-side proxy), not only `NEXT_PUBLIC_*`. |
| screenshots | Playwright browsers live in `research/compat/js/node_modules` — always `export PLAYWRIGHT_BROWSERS_PATH=0`. |
| paper | `cd research/paper-arxiv && tectonic aegis.tex`; `pdffonts`, `pdftotext`, `pdfinfo`, `pdftoppm` (poppler) are installed. |
| Docker | CLI installed, **daemon not running**; only R2 needs it (`open -a Docker`). |

A fresh gateway for any capture (temp DB, tenant key from the bootstrap route):

```
PORT=18086 DB_PATH=$(mktemp -d)/x.db AEGIS_LICENSE_TIER=enterprise RATE_LIMIT_MAX=1000000 LOG_LEVEL=warn \
  node packages/gateway-mcp/dist/server.js > /tmp/gw.log 2>&1 &  GW_PID=$!
KEY=$(curl -s http://127.0.0.1:18086/api/v1/auth/key | python3 -c "import sys,json;print(json.load(sys.stdin)['api_key'])")
# … use it …
kill $GW_PID
```

`AEGIS_LICENSE_TIER=enterprise` matters: on the free tier agents beyond the
cap go audit-only and nothing is blocked.

### Ports (one owner each — check `lsof -iTCP:<port> -sTCP:LISTEN` first)

| port | used by |
|---|---|
| 18080 / 18081 | compatibility matrix gateways (`run_compat.py`) |
| 18085 / 13003 | `shoot_replay.sh`, `shoot_cockpit.sh` (gateway / Cockpit) |
| 18086 | ad-hoc gateway for R2/R3 and experiments |
| 18087 / 13004 | `shoot_mcp.sh` (gateway / Cockpit) |

**Never `pkill -f` or kill by name** — other agents and sessions run
gateways and model servers on this machine. Kill only the PIDs you
started (`$!`), as the shoot scripts do with `trap`.

## Map

| path | what |
|---|---|
| `research/paper-arxiv/aegis.tex` + `sections/*.tex` | the paper (acmart sigconf). Builds to 31 pages with placeholders, **0 undefined references** is the bar. |
| `research/paper-arxiv/figdata/plots.json`, `gallery.json` | **generated** by `python3 -m figures_src.figure_data` (from `research/`) out of the result files the tables use. The only source of numbers and quoted strings. Do not edit; re-generate. |
| `research/paper-arxiv/figdata/captures/` | recorded runs: `g9_*` (MCP rug pull, done); you add `r1_*`–`r3_*` |
| `research/paper-arxiv/figdata/sourced_numbers.json` | the few numbers a figure may print that are in no result file, each with its source (today: F2's worked example) |
| `research/figures_src/placeholders.py` | the slot list (`SLOTS`: canvas, printed width, brief section). Draws missing slots; never overwrites a file unless `--force <stem>`. |
| `research/figures_src/check_figures.py` | **the acceptance gate** — see below |
| `research/figures_src/fig_*.py` | round-2 figures (architecture, provenance, rollout, audit, capability, demo) — the pattern for yours |
| `research/compat/mcp_rugpull_demo.py`, `shoot_mcp.sh` | the MCP rug pull through the shipping proxy (G9 data, U1 screenshot) |
| `research/compat/shoot_replay.sh`, `shoot_cockpit.sh`, `js/shoot.mjs` | Cockpit captures (`SHOOT_PAGES="/settings#mcp=mcp-tools"` shoots an anchored section under another name) |
| `research/paper-arxiv/package_for_arxiv.py` | clean-room tarball; run it at the end |
| `packages/gateway-mcp`, `packages/sdk-python`, `apps/compliance-cockpit` | gateway, SDK (+ `mcp_proxy.py`, `receipts.py`), Cockpit |

## The acceptance gate

```
cd research
python3 -m figures_src.check_figures            # every slot
python3 -m figures_src.check_figures F6 gallery/G1
```

Per slot it checks: the file exists; it is no longer the placeholder; its
aspect is within 3 % of the slot's canvas (so pages do not reflow); every
font is embedded; the smallest word is ≥ 5 pt at the printed width; every
number it prints is in `figdata/`, the paper's sources or the brief (axis
ticks allowed on plots); and gallery cards contain their record's tool
name and reason verbatim. It warns when a glyph fell back from Geist to a
system font. **A slot is done when it passes here _and_ you have looked
at its rendered page** — the script cannot see collisions or whether the
figure says what the brief asks. If the gate is wrong about something,
say so in your report; do not loosen it to pass.

Today: the five drawn figures pass except **F4 `capability`**, whose
smallest text prints at 3.7 pt (task 3 below); everything else is a
placeholder.

## Open tasks (priority order)

1. **Round-3 figures** — `CODEX-FIGURE-BRIEF-v3.md`. To do: F6 cascade,
   F7 fallback, F8 judge (+ reliability diagram), F9 deployment, F10
   receipts/pins; D1–D3 as figkit scripts reading `figdata/plots.json` at
   render time; gallery cards G1–G9, C1–C2 from `gallery.json` and
   `captures/g9_*`; terminal cards R1–R3. F1′ is a four-item revision of
   the existing architecture figure on its current canvas. Done already:
   U1 and G9's data. G6, G7 (false positives) and G8 (a miss) stay — they
   are what make the rest credible.
   Captions and figure environments are already in the LaTeX; **if what
   you draw contradicts a caption, stop and report** rather than edit the
   caption to fit.
2. **Fallback glyphs** in F3 (`Menlo`) and F5 (`Monaco`): find the glyph
   Geist lacks (likely an arrow or `‖`) and replace it with one Geist has,
   or draw it as a path.
3. **F4 `capability` print size**: redraw in `fig_capability.py` so its
   smallest text is ≥ 6 pt at `\columnwidth` (≈ 241 pt): the page is 486 pt
   wide today, so text must be ≥ 12 pt in the PDF — or narrow the canvas.
   Numbers unchanged.
4. **P1 (product, optional — ask first)**: receipts are issued and
   verified, but the Cockpit never shows them, because the SDK drops the
   receipt when it builds the trace (`interceptors/auto.py`,
   `_pop_decision` keeps only `passed`/`risk_level`/`reason`). Carrying
   it to the run step (`components/traces/run-timeline.tsx`) would let
   the appendix show it; until then no caption may claim it.
5. **P2 (product, optional — ask first)**: the Cockpit's status bar counts
   "blocked" from `/check` decisions, so a call the MCP proxy refused on a
   tool pin (never reaches `/check`) is not counted (U1's bar shows
   `0 blocked`). Either report pin refusals as blocks or label the count.

## Rules

- **Numbers** come from a file you can name. In figures: `figdata/`, or
  `sourced_numbers.json` with a source a reader could re-run.
- **Do not edit** `research/benchmark/data/**` (a corpus file trips GitHub
  secret scanning on a model-generated fake SID; the owner unblocks it on
  GitHub), any `figures/table_*.tex` (generated), or a caption to fit a
  figure.
- **Do not push.** `main` is ahead of `origin` and the push is waiting on
  the owner. Commit locally, one topic per commit, message says *why*,
  ending `Co-Authored-By: <the model that wrote it> <noreply@…>` if a
  model wrote it with you.
- **Keys**: the matrix reads `ANTHROPIC_API_KEY` from `~/.anthropic.env`,
  `OPENAI_API_KEY` from `~/chronoception/.env`, `GEMINI_API_KEY` from
  `~/Dynabridge/backend/.env`. Round 3 needs no model key. Never print a
  key into a capture.
- The arXiv upload needs co-author sign-off (Zhiyuan Su, Yue Zhao); you do
  not submit.

## Hand back

1. The files, in place, and `check_figures` output with every slot PASS
   (or each FAIL explained).
2. For each figure: every number it prints → the JSON path or capture
   line it came from.
3. `tectonic aegis.tex` page count before/after and the PNG of each page
   that carries a new figure (`pdftoppm -r 110 -f N -l N -png aegis.pdf`).
4. Anything in the brief you found wrong, with the evidence.

## Running the compatibility matrix (not needed for round 3)

```
cd research/compat
.venv/bin/python run_compat.py                 # 19 harnesses × 4 scenarios, ~45 min
.venv/bin/python run_compat.py crewai S2       # one row (names: harnesses.py HARNESSES)
.venv/bin/python make_table.py                 # → paper table + results/COMPAT.md
```

Ollama must serve `qwen3:8b` and `qwen2.5:7b`. Each harness runs in its
own process because `auto()` patches SDKs process-wide.

## History (done; for context)

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
