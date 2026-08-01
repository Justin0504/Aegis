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
    hyper::{Request, Response},
    Body, HttpContext, HttpHandler, RequestOrResponse,
};
use http_body_util::{BodyExt, Full};
use hudsucker::hyper::body::Bytes;
use serde::Serialize;
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use crate::config::ProxyConfig;

const MAX_BODY_PREVIEW: usize = 8 * 1024;

#[derive(Clone)]
pub struct Handler {
    pub config: Arc<ProxyConfig>,
    pub http: reqwest::Client,
    /// One entry per in-flight request keyed by the client's socket
    /// address + a monotonic per-connection counter. Since hudsucker
    /// serialises request/response pairs per connection in HTTP/1.1
    /// mode, popping the min-started entry per connection correlates
    /// correctly for the common case.
    pub pending: Arc<dashmap::DashMap<u64, Pending>>,
}

pub struct Pending {
    pub trace_id: String,
    pub method: String,
    pub url: String,
    pub host: String,
    pub started_at: Instant,
    pub req_body_preview: String,
}

#[derive(Serialize)]
struct TraceEnvelope<'a> {
    trace_id: &'a str,
    agent_id: &'a str,
    tool_call: ToolCall<'a>,
    response_summary: ResponseSummary,
    source: &'static str,
    ts: String,
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
        _ctx: &HttpContext,
        req: Request<Body>,
    ) -> impl Future<Output = RequestOrResponse> + Send {
        let handler = self.clone();
        async move { handler.on_request(req).await }
    }

    fn handle_response(
        &mut self,
        _ctx: &HttpContext,
        res: Response<Body>,
    ) -> impl Future<Output = Response<Body>> + Send {
        let handler = self.clone();
        async move { handler.on_response(res).await }
    }
}

impl Handler {
    async fn on_request(&self, req: Request<Body>) -> RequestOrResponse {
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

        let trace_id = uuid::Uuid::new_v4().to_string();
        let key = ctx_key(&parts);
        self.pending.insert(
            key,
            Pending {
                trace_id,
                method: method.clone(),
                url: url.clone(),
                host,
                started_at: Instant::now(),
                req_body_preview: preview,
            },
        );

        let new_req = Request::from_parts(parts, body_from_bytes(bytes));
        new_req.into()
    }

    async fn on_response(&self, res: Response<Body>) -> Response<Body> {
        let (parts, body) = res.into_parts();
        let bytes = match body.collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(_) => Bytes::new(),
        };

        // Coarse correlation: pop the min-started pending entry.
        // Works for single-in-flight-per-connection HTTP/1.1.
        // HTTP/2 multiplexing is documented as a v0.4 improvement.
        let pending_key = self
            .pending
            .iter()
            .min_by_key(|e| e.started_at)
            .map(|e| *e.key());

        if let Some(k) = pending_key {
            if let Some((_, pending)) = self.pending.remove(&k) {
                let elapsed_ms = pending.started_at.elapsed().as_millis();
                let status = parts.status.as_u16();
                let resp_preview = preview_of(&bytes);

                let envelope = TraceEnvelope {
                    trace_id: &pending.trace_id,
                    agent_id: &self.config.agent_id,
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

fn ctx_key(parts: &http::request::Parts) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    parts.method.hash(&mut h);
    parts.uri.hash(&mut h);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .hash(&mut h);
    h.finish()
}

// Silence unused warning — kept for signature parity with future Full<Bytes> body path.
#[allow(dead_code)]
fn _unused_full() -> Full<Bytes> {
    Full::new(Bytes::new())
}
