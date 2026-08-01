//! Hudsucker HttpHandler that forwards intercepted request/response
//! pairs to the AEGIS gateway trace endpoint.
//!
//! One `Handler` instance is shared across every connection (via
//! hudsucker's Clone requirement). Mutable state — pending-request
//! map, HTTP client, config — lives behind Arc.
//!
//! Trace payload mirrors the AEGIS SDK's `POST /api/v1/traces` shape
//! so downstream Cockpit code doesn't have to branch on source.

use hudsucker::{
    hyper::{Request, Response, StatusCode},
    Body, HttpContext, HttpHandler, RequestOrResponse,
};
use http_body_util::{BodyExt, Full};
use hudsucker::hyper::body::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::attribution::Attributor;
use crate::config::ProxyConfig;
use crate::llm::{enrich_request, enrich_response, LlmEnrichment};
use crate::metrics::Metrics;

const MAX_BODY_PREVIEW: usize = 8 * 1024;

#[derive(Clone)]
pub struct Handler {
    pub config: Arc<ProxyConfig>,
    pub http: reqwest::Client,
    /// Per-client-connection FIFO queue of pending requests. Handler
    /// is called back for handle_request and handle_response as
    /// separate events; hudsucker guarantees the ordering of BOTH is
    /// preserved per connection, so a FIFO keyed on `client_addr`
    /// correctly correlates (req, resp) pairs for HTTP/1.1 keep-
    /// alive AND HTTP/2 in-order streams. Real HTTP/2 multiplexing
    /// across the same connection would still race — documented in
    /// PROXY.md, tracked for a v0.4 fix using the `:stream-id`
    /// pseudo-header once hudsucker exposes it.
    pub pending: Arc<dashmap::DashMap<SocketAddr, VecDeque<Pending>>>,
    /// Resolves the local process behind a peer address so traces
    /// can be attributed to the actual agent (claude-code, cursor,
    /// custom-python) instead of the generic proxy label.
    pub attributor: Attributor,
    pub metrics: Arc<Metrics>,
}

pub struct Pending {
    pub trace_id: String,
    pub agent_id: String,
    pub method: String,
    pub url: String,
    pub host: String,
    pub path: String,
    pub started_at: Instant,
    pub req_body_preview: String,
    pub req_body_bytes: Bytes,
    pub llm: Option<LlmEnrichment>,
}

#[derive(Serialize)]
struct TraceEnvelope<'a> {
    trace_id: &'a str,
    agent_id: &'a str,
    tool_call: ToolCall<'a>,
    response_summary: ResponseSummary,
    source: &'static str,
    ts: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    llm: Option<&'a LlmEnrichment>,
}

#[derive(Serialize)]
struct ToolCall<'a> {
    tool_name: String,
    arguments: ToolArgs<'a>,
}

#[derive(Serialize)]
struct ToolArgs<'a> {
    url: &'a str,
    host: &'a str,
    method: &'a str,
    request_body_preview: &'a str,
    response_body_preview: String,
}

#[derive(Serialize)]
struct ResponseSummary {
    http_status: u16,
    latency_ms: u128,
}

impl HttpHandler for Handler {
    fn handle_request(
        &mut self,
        ctx: &HttpContext,
        req: Request<Body>,
    ) -> impl Future<Output = RequestOrResponse> + Send {
        let handler = self.clone();
        let addr = ctx.client_addr;
        async move { handler.on_request(addr, req).await }
    }

    fn handle_response(
        &mut self,
        ctx: &HttpContext,
        res: Response<Body>,
    ) -> impl Future<Output = Response<Body>> + Send {
        let handler = self.clone();
        let addr = ctx.client_addr;
        async move { handler.on_response(addr, res).await }
    }
}

impl Handler {
    async fn on_request(&self, client_addr: SocketAddr, req: Request<Body>) -> RequestOrResponse {
        let method = req.method().to_string();
        let uri = req.uri().clone();
        let host = uri.host().unwrap_or("").to_string();
        let url = uri.to_string();

        // Only trace allowlisted hosts. Non-allowlisted still get
        // forwarded — this is a safety net; the primary decision is
        // in main.rs (hudsucker's CA never signs for these hosts, so
        // we don't reach this arm for tunnelled traffic in practice).
        if !self.config.should_mitm(&host) {
            return req.into();
        }

        let (parts, body) = req.into_parts();
        let bytes = match body.collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(_) => Bytes::new(),
        };
        let preview = preview_of(&bytes);

        // Resolve the actual agent behind this connection. Cached
        // per peer; falls back to the config-level agent_id.
        let agent_id = self.attributor.resolve(client_addr);

        // ── Policy enforcement (opt-in) ─────────────────────────────
        // Before touching the pending queue, run the request past the
        // gateway's /api/v1/check. On block → return 403 to caller,
        // never forward. On pending → poll up to the configured
        // timeout, fail-open if it lapses. On allow → fall through
        // to normal forward+trace path.
        //
        // Fail-open semantics on ANY gateway error: enforcement is
        // best-effort; we would rather leak observability than break
        // the user's agent traffic. Every failure is logged at WARN.
        if self.config.enforce {
            match self.enforce_check(&agent_id, &method, &host, &url, &preview).await {
                CheckOutcome::Allow => {}
                CheckOutcome::Block(reason) => {
                    tracing::info!(target: "aegis-proxy", %host, %method, %agent_id, reason, "policy BLOCK");
                    self.metrics.inc(&self.metrics.requests_blocked_total);
                    return synthetic_403(&reason).into();
                }
            }
        }

        let path = uri.path().to_string();
        let llm = enrich_request(&host, &path, &bytes);
        if llm.is_some() {
            self.metrics.inc(&self.metrics.llm_enriched_total);
        }
        self.metrics.inc(&self.metrics.requests_mitm_total);
        self.metrics.add(&self.metrics.bytes_intercepted_total, bytes.len() as u64);

        let trace_id = uuid::Uuid::new_v4().to_string();
        let pending = Pending {
            trace_id,
            agent_id,
            method: method.clone(),
            url: url.clone(),
            host,
            path,
            started_at: Instant::now(),
            req_body_preview: preview,
            req_body_bytes: bytes.clone(),
            llm,
        };
        // Push to the tail of the per-connection queue.
        self.pending
            .entry(client_addr)
            .or_insert_with(VecDeque::new)
            .push_back(pending);

        let new_req = Request::from_parts(parts, body_from_bytes(bytes));
        new_req.into()
    }

    /// Submit the intercepted request to the gateway for a policy
    /// decision. Returns Allow (proceed) or Block (return 403).
    /// Pending is polled internally; timeout = fail-open (Allow).
    async fn enforce_check(
        &self,
        agent_id: &str,
        method: &str,
        host: &str,
        url: &str,
        body_preview: &str,
    ) -> CheckOutcome {
        #[derive(Serialize)]
        struct CheckReq<'a> {
            agent_id: &'a str,
            tool_name: String,
            arguments: serde_json::Value,
            blocking: bool,
        }
        #[derive(Deserialize)]
        struct CheckRes {
            decision: String,
            reason: Option<String>,
            check_id: Option<String>,
        }
        #[derive(Deserialize)]
        struct DecisionRes {
            decision: String,
            reason: Option<String>,
        }

        let req_body = CheckReq {
            agent_id,
            // Namespace the tool so DSL rules can match on `http.POST`
            // (all methods) or `http.POST anthropic.com` (specific host).
            tool_name: format!("http.{} {}", method, host),
            arguments: serde_json::json!({
                "url": url,
                "host": host,
                "method": method,
                "body_preview": body_preview,
            }),
            blocking: true,
        };
        let check_url = format!("{}/api/v1/check", self.config.gateway_url);

        let initial = match self
            .http
            .post(&check_url)
            .json(&req_body)
            .timeout(Duration::from_secs(5))
            .send()
            .await
        {
            Ok(r) => r,
            Err(err) => {
                tracing::warn!(
                    target: "aegis-proxy",
                    error = %err,
                    "gateway /check unreachable — fail-open (Allow)",
                );
                return CheckOutcome::Allow;
            }
        };
        let parsed: CheckRes = match initial.json().await {
            Ok(p) => p,
            Err(err) => {
                tracing::warn!(target: "aegis-proxy", error = %err, "malformed /check response — fail-open");
                return CheckOutcome::Allow;
            }
        };

        match parsed.decision.as_str() {
            "allow" => CheckOutcome::Allow,
            "block" => CheckOutcome::Block(parsed.reason.unwrap_or_else(|| "policy block".into())),
            "pending" => {
                let Some(check_id) = parsed.check_id else {
                    tracing::warn!(target: "aegis-proxy", "pending without check_id — fail-open");
                    return CheckOutcome::Allow;
                };
                let poll_url = format!("{}/api/v1/check/{}/decision", self.config.gateway_url, check_id);
                let deadline = Instant::now() + Duration::from_secs(self.config.enforce_pending_timeout_secs);

                while Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    let Ok(res) = self.http.get(&poll_url).timeout(Duration::from_secs(3)).send().await else {
                        continue;
                    };
                    let Ok(d) = res.json::<DecisionRes>().await else { continue; };
                    match d.decision.as_str() {
                        "allow" => return CheckOutcome::Allow,
                        "block" => return CheckOutcome::Block(d.reason.unwrap_or_else(|| "policy block".into())),
                        _ => continue,
                    }
                }
                tracing::warn!(
                    target: "aegis-proxy",
                    timeout_s = self.config.enforce_pending_timeout_secs,
                    "pending decision timed out — fail-open",
                );
                CheckOutcome::Allow
            }
            other => {
                tracing::warn!(target: "aegis-proxy", decision = other, "unknown /check decision — fail-open");
                CheckOutcome::Allow
            }
        }
    }

    async fn on_response(&self, client_addr: SocketAddr, res: Response<Body>) -> Response<Body> {
        let (parts, body) = res.into_parts();
        let bytes = match body.collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(_) => Bytes::new(),
        };

        // Pop the head of the queue for THIS connection. Hudsucker
        // preserves per-connection handler-call ordering, so this
        // pairs correctly with the corresponding on_request for
        // HTTP/1.1 keep-alive + HTTP/2 in-order streams. Cleans up
        // empty queues to bound memory across long-lived clients.
        let matched = self
            .pending
            .get_mut(&client_addr)
            .and_then(|mut q| q.pop_front());
        if let Some(entry) = self.pending.get(&client_addr) {
            if entry.is_empty() {
                drop(entry);
                self.pending.remove(&client_addr);
            }
        }

        if let Some(mut pending) = matched {
            {
                let elapsed_ms = pending.started_at.elapsed().as_millis();
                let status = parts.status.as_u16();
                let resp_preview = preview_of(&bytes);
                self.metrics.add(&self.metrics.bytes_intercepted_total, bytes.len() as u64);

                // Merge response-side LLM signals into the enrichment
                // we built from the request. Non-LLM hosts skip this
                // inside enrich_response.
                if let Some(mut llm) = pending.llm.take() {
                    enrich_response(&pending.host, &pending.path, &bytes, &mut llm);
                    pending.llm = Some(llm);
                }
                let _ = pending.req_body_bytes; // suppress unused-field warning

                let envelope = TraceEnvelope {
                    trace_id: &pending.trace_id,
                    agent_id: &pending.agent_id,
                    tool_call: ToolCall {
                        tool_name: format!("http.{}", pending.method),
                        arguments: ToolArgs {
                            url: &pending.url,
                            host: &pending.host,
                            method: &pending.method,
                            request_body_preview: &pending.req_body_preview,
                            response_body_preview: resp_preview,
                        },
                    },
                    response_summary: ResponseSummary {
                        http_status: status,
                        latency_ms: elapsed_ms,
                    },
                    source: "system-proxy",
                    ts: chrono::Utc::now().to_rfc3339(),
                    llm: pending.llm.as_ref(),
                };

                let url = format!("{}/api/v1/traces", self.config.gateway_url);
                let client = self.http.clone();
                let payload = serde_json::to_vec(&envelope).unwrap_or_default();
                tokio::spawn(async move {
                    if let Err(err) = client
                        .post(&url)
                        .header("content-type", "application/json")
                        .body(payload)
                        .send()
                        .await
                    {
                        tracing::warn!(target: "aegis-proxy", %url, error = %err, "gateway trace post failed");
                    }
                });
            }
        }

        Response::from_parts(parts, body_from_bytes(bytes))
    }
}

fn body_from_bytes(bytes: Bytes) -> Body {
    // Body doesn't impl From<Bytes>; go via a Full<Bytes> stream.
    use futures::stream;
    Body::from_stream(stream::once(async move { Ok::<_, std::io::Error>(bytes) }))
}

enum CheckOutcome {
    Allow,
    Block(String),
}

/// Build a synthetic 403 response for a blocked request. Body is JSON
/// so LLM-agent HTTP clients that parse errors get a structured signal
/// instead of a wall of text.
fn synthetic_403(reason: &str) -> Response<Body> {
    let body = serde_json::json!({
        "error": {
            "type": "aegis_policy_block",
            "message": reason,
            "guardrail": "aegis-proxy",
        }
    })
    .to_string();
    let bytes = Bytes::from(body);
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header("content-type", "application/json")
        .header("x-aegis-block", "1")
        .header("x-aegis-block-reason", reason)
        .body(body_from_bytes(bytes))
        .expect("valid response")
}

fn preview_of(bytes: &[u8]) -> String {
    let slice = if bytes.len() > MAX_BODY_PREVIEW {
        &bytes[..MAX_BODY_PREVIEW]
    } else {
        bytes
    };
    match std::str::from_utf8(slice) {
        Ok(s) => s.to_string(),
        Err(_) => format!("<{} bytes non-utf8>", bytes.len()),
    }
}


// Silence unused warning — kept for signature parity with future Full<Bytes> body path.
#[allow(dead_code)]
fn _unused_full() -> Full<Bytes> {
    Full::new(Bytes::new())
}
