# AEGIS Roadmap

What's shipping when. Written for engineers, prospective design
partners, and anyone wondering whether AEGIS is alive (it is — see
[releases](https://github.com/Justin0504/Aegis/releases) and
the commit graph).

Last updated: 2026-05-24 · Current release: **v0.1.0** · On `main`: SOC 2 evidence-pack export + bulk integrity verify + content-hash tamper detection + audit-log attribution & filters + closed-loop alignment + CodeShield (see [CHANGELOG](CHANGELOG.md))

## Now (v0.1)

What you get today, from the published .dmg.

- **Self-contained desktop app** — gateway + Cockpit + Node runtime in
  one 164 MB DMG. Drag, drop, launch. No Docker.
- **Welcome onboarding** with a process scanner that flags any
  running Python/Node agent that hasn't been routed through AEGIS.
- **System-tray badge** showing live unprotected-agent count.
- **Per-tenant Policy DSL** with fail-safe semantics — defaults can
  be tightened, never relaxed.
- **5 deployment templates**: dev, standard, strict, financial
  (7-year retention, SOX), healthcare (6-year, HIPAA).
- **Cost-aware L1 → L2 → L3 cascade**: rules → XGBoost → LLM judge.
  99.9 % block rate at 1.1 ms median on a 5,525-call benchmark.
- **14 framework SDKs**: Anthropic, OpenAI, LangChain, CrewAI,
  Gemini, Bedrock, Mistral, LlamaIndex, smolagents, plus
  Anthropic/OpenAI/Vercel AI/Mastra in JS, plus Go.
- **MCP proxy** for Claude Desktop integrations.
- **Tamper-evident audit trail**: SHA-256 hash chain + optional
  Ed25519 signatures.

Known limits at v0.1: macOS Apple Silicon only on the download path,
unsigned binary (Gatekeeper warns once), no auto-update.

---

## Next (v0.2) — target: ~6 weeks out

Closing the "this is a real product" gaps in the install + update
loop.

- [ ] **Apple Developer code signing + notarization.** Removes the
  Gatekeeper warning. Tracking under `signing/macos-apple-dev`.
- [ ] **macOS Intel build** — CI job already wired in
  `.github/workflows/release.yml`; first run lands with v0.2.
- [ ] **Windows .msi** — CI job exists, blocked on better-sqlite3
  native build on `windows-latest`. Iterating from CI logs.
- [ ] **Linux .AppImage + .deb** — CI wired, expected to go green
  on first v0.2 tag push.
- [ ] **Auto-update via tauri-plugin-updater** — see
  [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md). Blocked on
  generating the signing keypair.
- [ ] **Linux arm64** — Raspberry Pi 5, Graviton, etc.
- [ ] **First-run telemetry (opt-in)** — anonymous "agent
  instrumented" event so we know what frameworks people actually
  use.

---

## After that (v0.3 / Q3 2026)

Closing the "this catches things other guardrails miss" gap.

- [x] **Agent alignment auditor.** Inspect the agent's
  chain-of-thought trace for goal divergence (drift from the
  declared task). LlamaFirewall has a version of this; AEGIS now
  has one with first-class DSL integration and audit-trail
  evidence. Surfaces as a new signal in the L3 layer + an
  `alignment.score` field for the DSL evaluator. _Closed-loop
  bridge landed on `main`: LangChain callback verdicts flow into
  `/check` automatically via an in-process 30 s buffer._
- [ ] **PromptGuard-2-equivalent ML layer.** Currently L2 is an
  XGBoost classifier over 15 structural features. The v0.3 update
  adds an optional DeBERTa / ModernBERT jailbreak detector that
  runs in parallel and contributes to the cascade.
- [x] **CodeShield v1.** Fast, local-only regex scanner for
  agent-generated code. 19 high-precision rules across Python /
  JS / shell / SQL / secrets. Exposed at
  `POST /api/v1/code-shield/scan`. Sub-millisecond per scan; no
  LLM, no subprocess. The Semgrep-backed v2 (taint analysis,
  AST-aware passes) is still on the roadmap for v0.4.
- [x] **Cockpit dark mode (proper).** `globals.css` now defines a
  full dark palette behind both an explicit `.dark` class and the
  `prefers-color-scheme: dark` media query, with a three-state
  Light / System / Dark switch in the sidebar footer and a no-flash
  inline bootstrap that runs before paint.
- [x] **Tray click → specific unprotected agent** — when the tray
  badge shows N unprotected processes, clicking the tray now
  routes to `/welcome?pid=<top>` and the matching card auto-
  expands + scrolls into view with a 2s highlight ring.
- [x] **Audit-chain linkage verification** — three surfaces all
  hit `GET /api/v1/integrity/verify`: `agentguard integrity
  verify <id>` for cron/CI; the REST endpoint for ad-hoc pipelines;
  the Cockpit `/audit-log` page's inline widget for live reviewer
  use. Linkage checks insertion / deletion / reorder of trace rows.
- [x] **Audit-log attribution + filters.** Every audit row now
  records the API key name + prefix so SOC 2 reviewers can answer
  "which actor changed this." The `/audit-log` page filters by
  action, resource type, resource id, free-text on the JSON
  details, and date range; CSV export ships the visible page.

---

## v0.4 (scoped)

- [ ] **Single-row content-tamper detection.** Today's integrity
  verify is linkage-only because PII redaction happens before
  insert (the stored row no longer hashes back to the SDK's
  pre-redaction hash). v0.4 adds a separate canonical hash field
  (e.g. `content_hash_unredacted`) so reviewers can prove a row's
  content has not been mutated since insert.
- [ ] **CodeShield (Semgrep) v2.** v0.3 ships 19 curated regex
  rules at <1ms per scan; v0.4 adds an optional Semgrep-backed
  pass that catches taint flows the regex layer can't, behind a
  feature flag so the latency profile stays optional.
- [x] **Cockpit dark mode pass over remaining tabs** (Costs / Eval
  / Live Feed) — text colors now pull from `--foreground`; beige
  surface tints replaced by `--card` / `--muted` / `--secondary`;
  BLOCK/ERROR/OK row prefixes in Live Feed reuse the semantic
  `--status-*` vars so they read on both themes. Tool-color palette
  (web_search / read_file / execute_sql / send_request) was already
  mid-lightness band so it stays.

---

## v1.0 — target: end of 2026

The "ready to be deployed somewhere that matters" line.

- [x] **SOC 2 Type II evidence pack export.** `GET
  /api/v1/evidence-pack/export` (also `agentguard evidence-pack
  export --out`) returns one canonical JSON with audit log +
  policies + tenant config + bulk integrity verdict + per-agent
  trace anchors. Org-scoped so multi-tenant deployments don't leak.
  Auditors get a single, frozen, grep-able artifact.
- [x] **Ed25519 signed pack + offline verification.** Every pack
  now ships with a self-contained `signature` field (algorithm,
  key_id, signature, public_key_pem). `agentguard evidence-pack
  verify <file>` recomputes the canonical form locally and
  verifies — no network, no API key, no trust in the verifier
  process beyond `node:crypto`. Tamper one byte → exit 1. The
  gateway also exposes `GET /evidence-pack/public-key` for
  out-of-band pubkey comparison.
- [ ] **SSO via WorkOS** (SAML/OIDC) + RBAC across SSO identities,
  not just API keys.
- [ ] **Postgres adapter.** SQLite stays the default; enterprise
  customers needing replication / high concurrency get a real
  Postgres backend behind the same `DbAdapter` interface.
- [ ] **Multi-region** deployment story. Today the gateway is one
  process. v1.0 needs to survive a region outage.
- [ ] **Marketplace pages** — Cisco AI Defense / Lakera-style
  partnerships where AEGIS is the open-source bring-your-own-data
  reference.
- [ ] **First paying customer.** Tracked publicly, no specific
  date.

---

## Research-driven (Q4 2026) — tracking the field

Each item is tied to a 2026 result we verified at source, and each
ships as a measurement in the paper, not only as code.

- [x] **AgentDrift step-level replay** (arXiv:2609.06972). The
  provenance layer as a detector on 19,517 labelled steps: 62.8% of
  hijacked steps caught against the dataset's 55.4% baseline, precision
  48.5%. `python -m selective.agentdrift_eval`.
- [ ] **Adaptive attacker with an agent in the loop** (the objection in
  arXiv:2606.26479: static injection sets overstate every defense). An
  attacker model rewrites what the agent reads with verdict or white-box
  feedback; an agent model emits the call; only a realised attack counts.
  Running; result lands in the paper's evaluation. Next: a frontier
  attacker model.
- [x] **Decision receipts** (half of the gap aiAuthZ, arXiv:2607.05518,
  names: in-process defenses share the attacker's trust domain). Every
  allow returns an Ed25519-signed receipt bound to check, agent, tool and
  argument hash; a held call allowed by a person names who; verifiable
  offline against `GET /api/v1/check/receipt-key`
  (`agentguard.receipts.verify_receipt`).
- [ ] **Per-message caller identity.** The other half: HMAC-signed
  SDK→gateway messages with a nonce and timestamp in place of the bare
  agent secret, so a captured request cannot be replayed.
- [ ] **Role-stratified thresholds with a finite-sample guarantee**
  (arXiv:2607.24343). Separate thresholds and risk budgets for target,
  command, credential and content arguments, calibrated by split
  conformal (`selective/conformal.py`), reported as a budget per role.
- [x] **MCP tool pinning in the proxy** (OWASP MCP Top 10, MCP03 tool
  poisoning: description injection, shadowing, rug pulls). The proxy
  reports every tool it is offered; the gateway pins name, description
  and schema at first sight, marks changes and descriptions that instruct
  the model, refuses those until re-pinned in Settings, and writes each
  event to the audit log; Security 360 reads the state.
- [ ] **Anthropic deployment surfaces.** Agent SDK hooks and Managed
  Agents custom tools (which run in the customer's application, outside
  the sandbox and credential vault) as first-class integrations with
  their own compatibility-matrix rows.

## Out of scope (for now)

We are explicitly **not** doing any of these in 2026. Logged here so
people don't bring them up at every meetup.

- **Browser extensions** — agents in the browser deserve their own
  product; AEGIS is for SDK-instrumented agents.
- **Closed-source SaaS-only**. AEGIS will remain MIT and
  self-hostable. There may be a hosted version, but the core
  gateway stays open.
- **Embedded model retraining** — we score with policies and
  judges, we don't fine-tune your model for you. Use Lakera Red /
  PromptArmor for that.
- **General observability** (LangFuse / Helicone / Arize) — AEGIS
  is a *firewall*, not a tracing platform. Both layers coexist;
  AEGIS does not aim to replace the observability vendors.

---

## How to influence this

- **Open a discussion**: <https://github.com/Justin0504/Aegis/discussions>
- **Email**: aojieyua@usc.edu — design-partner pitches especially welcome.
- **Star the repo** if you want updates to land in your feed.

Best signal you can send: file a real issue from a real workload,
with reproducible steps. That moves things to the top of the queue
faster than anything else.
