//! LLM-aware request/response body enrichment.
//!
//! For known LLM API endpoints (Anthropic, OpenAI, Gemini, Mistral)
//! we heuristically parse the JSON body and pull out the fields that
//! matter for downstream analytics: model name, message counts,
//! token usage. Everything is best-effort — a body that fails to
//! parse just returns None and the trace still records the raw
//! preview.
//!
//! Enrichment is attached to the trace envelope as an `llm` field,
//! so the Cockpit can render "gpt-4o-mini · 340 out, 1,240 in" etc.
//! without knowing about the individual providers.
//!
//! ## Zero side effects
//!
//! - Parsing is non-panicking (uses `serde_json::from_slice` with
//!   ok().and_then chains).
//! - Failed parse = None = the enrichment field simply isn't
//!   emitted. Downstream code MUST tolerate absence.
//! - Body preview truncation happens BEFORE parsing, so a body
//!   that's cut off mid-JSON also returns None instead of a
//!   half-parsed lie.
//! - No allocations for non-LLM hosts (host check first).

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct LlmEnrichment {
    pub provider: &'static str,
    /// Model identifier as reported by the API (e.g. "claude-opus-4-7",
    /// "gpt-4o-mini", "gemini-1.5-pro"). Never inferred — if the
    /// field isn't in the body, we leave it None.
    pub model: Option<String>,
    /// Message count in the request. Chat-turn depth heuristic.
    pub messages: Option<usize>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// True when the caller explicitly asked for streaming. Streamed
    /// responses have different accounting (no total tokens until
    /// the SSE `[DONE]` frame) and downstream code should treat
    /// missing token counts as expected, not as parse failure.
    pub stream: Option<bool>,
    /// The `max_tokens` cap the caller requested. Useful for
    /// runaway-cost detectors.
    pub max_tokens: Option<u64>,
}

/// Parse the request body of a known LLM API endpoint. Returns None
/// for non-LLM hosts, unparseable JSON, or bodies missing the
/// provider-shape fingerprint.
pub fn enrich_request(host: &str, path: &str, body: &[u8]) -> Option<LlmEnrichment> {
    let provider = provider_for(host, path)?;
    let json: serde_json::Value = serde_json::from_slice(body).ok()?;
    let obj = json.as_object()?;

    let model = obj.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let stream = obj.get("stream").and_then(|v| v.as_bool());
    let max_tokens = obj.get("max_tokens").and_then(|v| v.as_u64())
        .or_else(|| obj.get("maxOutputTokens").and_then(|v| v.as_u64()));  // Gemini casing

    let messages = match provider {
        "gemini" => obj.get("contents").and_then(|v| v.as_array()).map(|a| a.len()),
        _        => obj.get("messages").and_then(|v| v.as_array()).map(|a| a.len()),
    };

    Some(LlmEnrichment {
        provider,
        model,
        messages,
        input_tokens: None,
        output_tokens: None,
        stream,
        max_tokens,
    })
}

/// Merge response-side signals (token usage) into an already-built
/// enrichment. Called from the response handler after the request-
/// side enrichment has been attached to the pending trace.
pub fn enrich_response(host: &str, path: &str, body: &[u8], into: &mut LlmEnrichment) {
    if provider_for(host, path).is_none() { return; }
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(body) else { return; };
    let Some(obj) = json.as_object() else { return; };

    // Anthropic / OpenAI / Mistral: { "usage": { "input_tokens": N, ... } } or
    // OpenAI-legacy: { "usage": { "prompt_tokens": N, "completion_tokens": M } }
    if let Some(usage) = obj.get("usage").and_then(|v| v.as_object()) {
        into.input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64())
            .or_else(|| usage.get("prompt_tokens").and_then(|v| v.as_u64()));
        into.output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64())
            .or_else(|| usage.get("completion_tokens").and_then(|v| v.as_u64()));
    }

    // Gemini: usageMetadata: { promptTokenCount, candidatesTokenCount }
    if let Some(um) = obj.get("usageMetadata").and_then(|v| v.as_object()) {
        into.input_tokens = um.get("promptTokenCount").and_then(|v| v.as_u64());
        into.output_tokens = um.get("candidatesTokenCount").and_then(|v| v.as_u64());
    }

    // If the request didn't declare the model but the response does
    // (some legacy OpenAI-compatibles echo it back), fill it in.
    if into.model.is_none() {
        if let Some(m) = obj.get("model").and_then(|v| v.as_str()) {
            into.model = Some(m.to_string());
        }
    }
}

fn provider_for(host: &str, path: &str) -> Option<&'static str> {
    // Match on both host AND path — /v1/messages vs /v1/chat/completions
    // is the distinguishing signal between Anthropic and OpenAI-shape
    // (Mistral, Together, Groq all speak the OpenAI shape).
    match host {
        "api.anthropic.com" if path.contains("/messages") => Some("anthropic"),
        "api.openai.com"    if path.contains("/chat/completions") || path.contains("/responses") => Some("openai"),
        "api.mistral.ai"    if path.contains("/chat/completions") => Some("mistral"),
        h if h.contains("generativelanguage.googleapis.com") && path.contains("generateContent") => Some("gemini"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_request() {
        let body = br#"{"model":"claude-opus-4-7","messages":[{"role":"user","content":"hi"}],"max_tokens":1024,"stream":false}"#;
        let e = enrich_request("api.anthropic.com", "/v1/messages", body).unwrap();
        assert_eq!(e.provider, "anthropic");
        assert_eq!(e.model.as_deref(), Some("claude-opus-4-7"));
        assert_eq!(e.messages, Some(1));
        assert_eq!(e.max_tokens, Some(1024));
        assert_eq!(e.stream, Some(false));
    }

    #[test]
    fn openai_request_and_response() {
        let req = br#"{"model":"gpt-4o-mini","messages":[{"role":"user","content":"x"},{"role":"assistant","content":"y"}]}"#;
        let mut e = enrich_request("api.openai.com", "/v1/chat/completions", req).unwrap();
        assert_eq!(e.provider, "openai");
        assert_eq!(e.messages, Some(2));
        let res = br#"{"usage":{"prompt_tokens":40,"completion_tokens":10}}"#;
        enrich_response("api.openai.com", "/v1/chat/completions", res, &mut e);
        assert_eq!(e.input_tokens, Some(40));
        assert_eq!(e.output_tokens, Some(10));
    }

    #[test]
    fn gemini_request_and_response() {
        let req = br#"{"contents":[{"parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":100}}"#;
        let mut e = enrich_request(
            "generativelanguage.googleapis.com",
            "/v1beta/models/gemini-1.5-pro:generateContent",
            req,
        )
        .unwrap();
        assert_eq!(e.provider, "gemini");
        assert_eq!(e.messages, Some(1));
        let res = br#"{"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":25},"model":"gemini-1.5-pro"}"#;
        enrich_response(
            "generativelanguage.googleapis.com",
            "/v1beta/models/gemini-1.5-pro:generateContent",
            res,
            &mut e,
        );
        assert_eq!(e.input_tokens, Some(50));
        assert_eq!(e.output_tokens, Some(25));
        assert_eq!(e.model.as_deref(), Some("gemini-1.5-pro"));
    }

    #[test]
    fn unknown_host_returns_none() {
        let body = br#"{"model":"anything"}"#;
        assert!(enrich_request("api.stripe.com", "/v1/refunds", body).is_none());
    }

    #[test]
    fn truncated_body_returns_none_gracefully() {
        // Partially-truncated JSON (missing closing brace) must not
        // panic and must return None so the trace still emits.
        let body = b"{\"model\":\"claude-opus-4-7\",\"messages\":[{";
        assert!(enrich_request("api.anthropic.com", "/v1/messages", body).is_none());
    }
}
