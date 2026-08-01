//! Minimal in-process counters + a `/metrics` endpoint (Prometheus
//! text format) for the transparent proxy.
//!
//! Bound to `127.0.0.1:<PROXY_PORT+1>` (default `18082`) — same
//! localhost-only posture as the proxy itself. SREs can scrape from
//! Prometheus / node-exporter / Grafana Agent on the same machine;
//! nothing about this exposes state over the LAN.
//!
//! Counters are lock-free (AtomicU64). No histogram / summary yet —
//! request latency shows up in the trace envelopes already; this
//! endpoint's job is throughput + policy-enforcement stats that
//! traces alone can't answer ("how many requests did we block?
//! how many did we tunnel past?").

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Every counter we expose. Ordering::Relaxed is correct for
/// monotonic counters — we never make control-flow decisions from
/// the value, only report it.
#[derive(Default)]
pub struct Metrics {
    /// Requests that hit an allowlisted host and got decrypted +
    /// forwarded (traced). One increment per request, at the point
    /// of trace envelope construction.
    pub requests_mitm_total: AtomicU64,
    /// Requests that bypassed MITM (non-allowlisted host). Zero
    /// currently — hudsucker's CA gates this before we see it —
    /// reserved for a future accounting when we log tunnelled
    /// destinations for compliance visibility.
    pub requests_tunneled_total: AtomicU64,
    /// Requests the enforcement path blocked with a synthetic 403.
    /// Only nonzero when config.enforce = true.
    pub requests_blocked_total: AtomicU64,
    /// Requests the enforcement path held pending human review that
    /// eventually resolved to allow. Doesn't count timeouts (those
    /// go to enforcement_failopen_total).
    pub requests_pending_allow_total: AtomicU64,
    /// Times we couldn't reach the gateway / got a malformed
    /// response and fell open. Sign of gateway/proxy divergence.
    pub enforcement_failopen_total: AtomicU64,
    /// Trace posts that hit an error (gateway down, timeout, non-2xx).
    pub trace_post_errors_total: AtomicU64,
    /// LLM request bodies successfully parsed (Anthropic/OpenAI/etc).
    pub llm_enriched_total: AtomicU64,
    /// Bytes intercepted (sum of request + response body sizes for
    /// MITM'd requests). Useful for the "how much am I tracing?"
    /// question on the wizard's status card later.
    pub bytes_intercepted_total: AtomicU64,
}

impl Metrics {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }

    pub fn inc(&self, c: &AtomicU64) { c.fetch_add(1, Ordering::Relaxed); }
    pub fn add(&self, c: &AtomicU64, n: u64) { c.fetch_add(n, Ordering::Relaxed); }

    /// Render Prometheus text format. Simple; no library dependency.
    pub fn render(&self) -> String {
        let mut s = String::new();
        emit(&mut s, "aegis_proxy_requests_mitm_total", "Requests intercepted + forwarded (traced).", &self.requests_mitm_total);
        emit(&mut s, "aegis_proxy_requests_tunneled_total", "Requests that bypassed decryption (non-allowlisted host).", &self.requests_tunneled_total);
        emit(&mut s, "aegis_proxy_requests_blocked_total", "Requests blocked by policy enforcement (403 synthetic).", &self.requests_blocked_total);
        emit(&mut s, "aegis_proxy_requests_pending_allow_total", "Pending checks resolved to allow.", &self.requests_pending_allow_total);
        emit(&mut s, "aegis_proxy_enforcement_failopen_total", "Enforcement checks that failed open (gateway unreachable / malformed).", &self.enforcement_failopen_total);
        emit(&mut s, "aegis_proxy_trace_post_errors_total", "Trace POST failures to the gateway.", &self.trace_post_errors_total);
        emit(&mut s, "aegis_proxy_llm_enriched_total", "LLM request bodies successfully parsed and enriched.", &self.llm_enriched_total);
        emit(&mut s, "aegis_proxy_bytes_intercepted_total", "Total bytes of request+response bodies intercepted.", &self.bytes_intercepted_total);
        s
    }
}

fn emit(out: &mut String, name: &str, help: &str, counter: &AtomicU64) {
    use std::fmt::Write;
    let _ = writeln!(out, "# HELP {} {}", name, help);
    let _ = writeln!(out, "# TYPE {} counter", name);
    let _ = writeln!(out, "{} {}", name, counter.load(Ordering::Relaxed));
}

/// Spawn the /metrics HTTP server on 127.0.0.1:port. Never fails
/// the proxy startup — if the bind fails, log a warning and skip.
/// Metrics are still updated in-memory; only external scraping is
/// affected.
pub fn spawn_server(metrics: Arc<Metrics>, port: u16) {
    tokio::spawn(async move {
        let addr: std::net::SocketAddr = match format!("127.0.0.1:{port}").parse() {
            Ok(a) => a,
            Err(e) => { tracing::warn!(target: "aegis-proxy", error = %e, "metrics addr parse failed"); return; }
        };
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(target: "aegis-proxy", error = %e, %addr, "metrics bind failed — skipping /metrics server");
                return;
            }
        };
        tracing::info!(target: "aegis-proxy", %addr, "metrics endpoint listening at /metrics");

        loop {
            let Ok((mut sock, _)) = listener.accept().await else { continue; };
            let m = metrics.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                // Path-agnostic: any GET returns the metrics body.
                let body = m.render();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/plain; version=0.0.4\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(), body,
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
}
