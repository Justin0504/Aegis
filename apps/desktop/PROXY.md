# Transparent HTTPS proxy — architecture + delivery plan

The "no-code integration" path: user installs AEGIS, grants OS admin
once, and every HTTPS call any agent makes on that machine flows
through AEGIS's gateway — no SDK, no source-code change.

Status: **Phase 2a/2b/2c shipped (v0.3); Phase 3 in flight (policy enforcement, attribution scaffold, LLM enrichment).**

Phase 3 additions (this commit):
- `enforce` config flag (default false): when true, every intercepted
  request is submitted to the gateway's `/api/v1/check` BEFORE
  forwarding. Block → synthetic 403 with `x-aegis-block` headers;
  pending → poll up to `enforce_pending_timeout_secs` (default 60s)
  then fail-open; allow → forward normally. Fail-open on any gateway
  error (never break user traffic).
- `attribution` module: cached Attributor per peer address, replacing
  the flat global `agent_id`. Platform TCP-owner resolver (SO_PEERCRED
  / lsof / GetExtendedTcpTable) is stubbed with the plumbing in
  place — trace payload already carries the per-connection agent_id,
  so activating the resolver is a drop-in.
- `llm` module: LLM-aware body enrichment for Anthropic / OpenAI /
  Gemini / Mistral. Extracts `model`, `messages` count, `max_tokens`,
  `stream`, and (from response) `input_tokens` / `output_tokens`.
  Attached to trace envelope as an `llm` field. 5 unit tests.


| Piece | State | File |
|---|---|---|
| CA-trust install helpers (macOS `security`, Windows `certutil`, Linux `update-ca-certificates`) | shipped | `src-tauri/src/system_proxy.rs` |
| System-proxy config helpers (macOS `networksetup`, Windows `netsh winhttp`, Linux env file) | shipped | `src-tauri/src/system_proxy.rs` |
| Cockpit `/proxy` wizard UI — 5-step flow, verbatim commands, reversal instructions | shipped | `apps/compliance-cockpit/src/components/proxy/proxy-wizard.tsx` |
| CA generator (rcgen), on-disk PEM (0600) | shipped | `apps/desktop/proxy/src/ca.rs` |
| MITM proxy binary listening on `:18081` (hudsucker + rustls) | shipped | `apps/desktop/proxy/src/main.rs` |
| Trace forwarder from proxy → gateway `/api/v1/traces` | shipped | `apps/desktop/proxy/src/handler.rs` |
| Sidecar spawn from Tauri (opt-in via wizard `Start proxy` button, never auto-starts) | shipped | `src-tauri/src/sidecars.rs` + `system_proxy.rs::proxy_start` |
| Proxy binary bundled into .app resources via `prepare-sidecars.mjs` | shipped | `apps/desktop/scripts/prepare-sidecars.mjs` |
| First-launch wizard offer on `/activate` (two-path card: zero-code vs SDK) | shipped | `apps/compliance-cockpit/src/app/activate/page.tsx` |
| Per-connection FIFO correlation (fixes HTTP/1.1 pipelining + HTTP/2 in-order streams) | shipped | `handler.rs` — `pending: DashMap<SocketAddr, VecDeque<Pending>>` |
| HTTP/2 stream-id-level correlation (races across multiplexed streams on same conn) | v0.4 | needs hudsucker to surface `:stream-id`; tracked upstream |
| CA private key in OS keychain (`keyring` crate) instead of 0600 file | v0.4 | `ca.rs` — 0600 file is fine for single-user desktop; keyring is a hardening pass |

## Design

### Why a per-host allowlist (not "MITM everything")

Certificate-installed MITM is a big hammer. If the AEGIS CA is trusted
by the OS, every HTTPS connection from every process is theoretically
decryptable. That's a scope of authority we do not want — and one that
security-review boards will (rightly) refuse.

Instead: the proxy holds an explicit allowlist of hosts to MITM. Any
connection to a host NOT on the allowlist is passed through TCP-tunnel-
style: the proxy sees SNI + destination IP + byte count, but the payload
is opaque. This is the standard corporate-MITM posture (Zscaler, Netskope,
Cisco Umbrella all work this way) and it's what our users' security
teams will need to sign off on.

Default allowlist (v0.3):

- `api.anthropic.com`
- `api.openai.com`
- `generativelanguage.googleapis.com` (Gemini)
- `api.mistral.ai`
- `api.stripe.com` — payment
- (optional, opt-in) `api.modern-treasury.com`, `api.column.com`, `api.chainalysis.com`

Operators can add/remove hosts via `/proxy` wizard.

### Why `hudsucker` (Rust)

- Actively maintained (2025+)
- Rustls-based → no OpenSSL dep, cross-compiles trivially
- Pluggable request/response handlers → the trace forwarder is 20 lines
- Total binary size: ~5-8 MB, no external runtime
- BSD-2 licensed

Alternatives considered + rejected:

- `mitmproxy` (Python) — battle-tested but drags a 100+ MB Python
  runtime. Not acceptable for a "just download the .dmg" experience.
- `hyper_reverse_proxy` — reverse proxy, not MITM. Doesn't cover our
  use case.
- Node.js `http-mitm-proxy` — would let us reuse the bundled Node
  runtime, saving 5 MB, but the library is unmaintained since 2022
  and the certificate-signing code has known TLS 1.3 gaps.

### Where the CA lives

- **CA private key**: generated on very first proxy start via `rcgen`,
  stored via `keyring` crate (OS keychain — macOS Keychain, Windows
  Credential Manager, Linux Secret Service). Never written to disk in
  plaintext. Never exported over any IPC.
- **CA public cert (PEM)**: written to `~/Library/Application Support/AEGIS/aegis-proxy-ca.crt`
  (or platform equivalent) — this is what `install_proxy_ca` shell-outs
  to `security add-trusted-cert` etc. with.
- **Leaf certs**: signed on-the-fly per SNI hostname, cached in-memory
  with a 24h TTL. Never persisted.

### Trace forwarder

Every intercepted request/response pair becomes one trace record posted
to the running gateway at `http://127.0.0.1:18080/api/v1/traces`.
Shape mirrors the SDK's trace shape so downstream Cockpit code doesn't
branch:

```json
{
  "trace_id": "...",
  "agent_id": "no-code-proxy",  // synthesized; wizard can override
  "input_context": {
    "prompt": "<not captured — no LLM context outside SDK>"
  },
  "tool_call": {
    "tool_name": "http.POST",
    "arguments": { "url": "https://api.openai.com/v1/messages", "body": {...} }
  },
  "response_summary": { "http_status": 200, "latency_ms": 812 },
  "source": "system-proxy"
}
```

Attribution weakness: without SDK context, we can't tie the request
back to a specific agent workflow — we get "some process made a call
to Anthropic" but not "the `refund-bot` agent chain call 3 of 7". The
wizard is explicit about this trade-off; users who want deep attribution
still use the SDK.

## Sequencing

- **v0.3.0** (target: week of 2026-08-11)
  - `hudsucker`-based proxy binary
  - CA generator + keychain storage
  - Trace forwarder
  - Ship the proxy binary as a fourth sidecar next to gateway/cockpit/node-runtime
  - Cockpit wizard "Start proxy" button actually starts something

- **v0.3.1**
  - Allowlist editor persists to gateway config (currently client-side only)
  - Per-host toggles trigger a proxy hot-reload
  - Wizard integrated into first-launch flow after activation

- **v0.4.0**
  - Cert pinning detection + friendly error ("this app pins its cert
    to their own CA — we can see the connection but not decrypt.
    Consider using the SDK for full observability.")
  - Optional: mTLS-outbound support so the proxy can also be a
    corporate-gateway hop

## Non-goals

- **Not** a full web proxy (no browser configuration UI — use system default)
- **Not** WireGuard / VPN — we're TLS-terminating, not network-tunneling
- **Not** a corporate-egress product — single-user desktop is the scope;
  enterprise multi-user is a distinct SKU

## Alternatives that did NOT make the cut

- **eBPF-based network filter (Linux)** — technically cleaner than
  proxy setting because it doesn't require app cooperation, but
  Linux-only, needs kernel headers, requires root. Kills the "one-click
  .dmg" story. Deferred to enterprise SKU.
- **macOS Network Extension** — same trade-off. Requires paid App
  Store review + entitlement grant. Not in v0.3 scope.
- **DNS-based redirect** — trivial to bypass (any tool that does its
  own DNS or uses IP literals escapes). Not sufficient for security.
