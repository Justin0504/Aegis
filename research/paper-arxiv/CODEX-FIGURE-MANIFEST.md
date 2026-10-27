# Figure manifest — AEGIS arXiv v2 (authoritative; read this first)

Updated 2026-10-27. The paper's prose is final; it builds to **33 pages, 0
undefined references**. Every float below exists in the LaTeX with a caption
written — your job is to replace the grey placeholder images with real ones.
**If what you draw would contradict a caption, stop and report**; do not edit
a caption to fit a figure.

- Full spec for each item: `CODEX-FIGURE-BRIEF-v3.md` (sections named below),
  with palette/type/checks in `CODEX-FIGURE-BRIEF.md`.
- Numbers and strings come only from `figdata/` — never typed. Regenerate:
  `cd research && python3 -m figures_src.figure_data`.
- The gate for every slot: `cd research && python3 -m figures_src.check_figures`.
  A slot is done when it PASSES **and** you have looked at the rendered page.
- Tables (`\input{figures/table_*}`) are **generated from results** — do not
  touch them. They are listed here only so you know what is already on the page.

## What is already real — do NOT redraw (unless a revision is listed)

| image | label | where | note |
|---|---|---|---|
| `architecture.pdf` | fig:architecture | §System Architecture, Fig. 1 | **revise → F1′** (4 small edits, below) |
| `provenance_mechanism.pdf` | fig:provenance | §2.3 L_p | done |
| `rollout_construction.pdf` | fig:instantiate | §Evaluation, Mechanism | done |
| `audit_chain.pdf` | fig:audit | §2.5 Audit | **revise → F5′** (below) |
| `demo_walkthrough.pdf` | fig:demo | §Walkthrough | done (rendered 2026-10-26) |
| `ui/*.png`, `demo/*.png` | fig:ui-*, fig:demo-* | App. Cockpit | real screenshots, done |
| `ui/mcp-tools.png` | fig:ui-mcp | App. Cockpit | real capture (U1), done |

## Body — diagrams to draw (figkit, palette in brief)

| id | image | label | position in paper | width | spec |
|---|---|---|---|---|---|
| F6 | `cascade.pdf` | fig:cascade | §2.3, after the *Decision* paragraph | `\textwidth` | v3 §F6 |
| F7 | `fallback.pdf` | fig:fallback | §2.x Failure Modes and Fallback (`sections/fallback.tex`), top | `\textwidth` | v3 §F7 |
| F8 | `judge.pdf` | fig:judge | §2.x LLM as Judge (`sections/judge.tex`) | `\textwidth` | v3 §F8 |
| F9 | `deployment.pdf` | fig:deployment | end of §2.2 Interposition | `\textwidth` | v3 §F9 |
| F10 | `receipts_pins.pdf` | fig:receipts-pins | §2.3, after F6 | `\columnwidth` | v3 §F10 |

## Body — data plots (figkit script over figdata/plots.json; no literal numbers)

| id | image | label | position | width | data |
|---|---|---|---|---|---|
| D1 | `frontier.pdf` | fig:frontier | §Eval AgentDojo, after Table~\ref{tab:agentdojo-qwen} | `\columnwidth` | `plots.json` D1_* (both models) |
| D2 | `load.pdf` | fig:load | §Eval Overhead, after Table~\ref{tab:overhead} | `\columnwidth` | `plots.json` D2_load |
| D3 | `agentdrift.pdf` | fig:agentdrift | §Eval AgentDrift, after Table~\ref{tab:agentdrift} | `\columnwidth` | `plots.json` D3_agentdrift |
| F4 | `capability.pdf` | fig:capability | §Eval Authority | `\columnwidth` | **redraw** — exists but its smallest text prints at 3.7 pt (floor 6 pt); `figures_src/fig_capability.py`, numbers unchanged |

## Appendix — interception gallery cards (500×300 each, one PDF each)

Section: `sections/appendix_gallery.tex`. Template + per-card content and the
two false positives (G6, G7) and the miss (G8): v3 §G. All strings verbatim
from `figdata/gallery.json`; G9 from `figdata/captures/g9_*`.

| id | image | label | shows |
|---|---|---|---|
| G1 | `gallery/G1.pdf` | fig:gallery-g1 | banking: held standing-order redirect |
| G2 | `gallery/G2.pdf` | fig:gallery-g2 | banking: `send_money` to attacker IBAN, blocked |
| G3 | `gallery/G3.pdf` | fig:gallery-g3 | slack: phishing-link DM, blocked |
| G4 | `gallery/G4.pdf` | fig:gallery-g4 | slack: all channels → external page, blocked |
| G5 | `gallery/G5.pdf` | fig:gallery-g5 | workspace: email to injected address, blocked |
| G6 | `gallery/G6.pdf` | fig:gallery-g6 | slack: **false positive** under attack |
| G7 | `gallery/G7.pdf` | fig:gallery-g7 | banking: **false positive** on a clean task |
| G8 | `gallery/G8.pdf` | fig:gallery-g8 | workspace: **the miss** (same-tool delete) |
| G9 | `gallery/G9.pdf` | fig:gallery-g9 | MCP rug pull (from `captures/g9_*`) |
| C1 | `gallery/C1.pdf` | fig:gallery-c1 | Claude Agent SDK S2: `curl\|sh` blocked |
| C2 | `gallery/C2.pdf` | fig:gallery-c2 | OpenAI Agents SDK S4: provenance block |

## Appendix — deployment terminal cards (figkit mono-on-surface cards)

Section: `sections/appendix_ui.tex` §"Deployment, as It Runs". **All three are
recorded already** (real runs on the blockelite host, 2026-10-26); draw the
cards verbatim from the capture files, trimming only as v3 §R allows.

| id | image | label | from |
|---|---|---|---|
| R1 | `deploy/mcp-host.pdf` | fig:deploy-mcp | README `mcpServers` block + `figdata/captures/g9_run2.json`, `g9_proxy.txt` |
| R2 | `deploy/compose.pdf` | fig:deploy-compose | `figdata/captures/r2_compose.txt`, `r2_agent.txt` |
| R3 | `deploy/receipt-verify.pdf` | fig:deploy-receipt | `figdata/captures/r3_receipt.txt` |

## Revisions to the two already-drawn figures (2026-10-26 claims audit)

The audit changed what the paper claims about signing; both captions are
already updated, so these figures must match them (details: v3 §F1′, §F5′):

- **F1′ `architecture.pdf`**: (1) add the signed receipt on the allow lane;
  (2) pending → `L3 auditor` card → person, with note `opt-in · AEGIS_HOLD_REVIEWER=auditor`;
  (3) MCP stub note `L1 + policy · tool pins`; (4) request-side arrow
  Agent→L_p `what the model read`. Audit card: `signed receipt on every allow`
  + `SHA-256 chain per agent → heads anchored in Merkle log`, dashed arrow
  label `every decision, chained`. Keep `15 frameworks`.
- **F5′ `audit_chain.pdf`**: each block's two mono lines become
  `content  sha256(input, call, result)` and `H = SHA256(… ‖ H_prev)`;
  relabel the bracket `head anchored → Merkle log (every 10 min) → witnesses`;
  add to the tampered row the second failure mode `chain re-hashed (links ok)
  but ≠ anchored head`. Traces are **not** individually signed in `auto()`.

## Tables already on the page (generated — do not touch)

tab:agentdojo, tab:agentdojo-qwen, tab:overhead, tab:integrity, tab:results,
tab:provenance, tab:features, tab:patterns, tab:compat, tab:agentdrift,
**tab:adaptive** (corpus/Haiku) and **tab:adaptive-agentdojo** (the new
AgentDojo adaptive run: 61 carried out undefended, 60 flagged, 0 escaped by
rewriting). Regenerated by their own scripts in `research/`.

## Order of work (suggested)

1. `python3 -m figures_src.figure_data` → confirm `figdata/` current.
2. Body diagrams F6–F10, then plots D1–D3, then F4 redraw.
3. F1′ and F5′ revisions.
4. Gallery G1–G9, C1–C2; then deploy cards R1–R3.
5. Per slot: `check_figures <slot>` PASS, then `tectonic aegis.tex`, then look
   at the page. Report page count before/after and a PNG of each new page.
