//! Proxy runtime configuration.
//!
//! Loaded from a TOML file at a well-known path, editable from the
//! Cockpit `/proxy` wizard. Falls back to a hard-coded sensible
//! default when the file doesn't exist yet, so first-launch works
//! without any operator input.
//!
//! The config is intentionally small — an allowlist of hosts, the
//! bind address, and the gateway trace endpoint. All the rich policy
//! (rate limits, per-agent caps, DSL rules) lives on the gateway; the
//! proxy is a dumb intercept-and-forward pipe.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Bind address for the proxy. Localhost only — the proxy is a
/// single-user desktop feature; exposing it beyond loopback would be
/// a genuine security bug (any LAN peer could route traffic through
/// this user's OpenAI/Anthropic key implicitly).
pub const DEFAULT_BIND: &str = "127.0.0.1:18081";

/// Gateway trace ingestion endpoint. Sidecars.rs already binds the
/// gateway on this port for release builds; dev users can override
/// via env var `AEGIS_PROXY_GATEWAY_URL`.
pub const DEFAULT_GATEWAY: &str = "http://127.0.0.1:18080";

/// Hosts we decrypt + trace by default. Everything else passes
/// through as an opaque TCP tunnel — proxy sees SNI, byte count, and
/// destination but not the payload. This is the corporate-MITM
/// posture that security review boards will actually sign off on.
pub const DEFAULT_ALLOWLIST: &[&str] = &[
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "api.mistral.ai",
    "api.stripe.com",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub bind: String,
    pub gateway_url: String,
    pub allowlist: Vec<String>,
    /// Optional agent_id label attached to every synthesized trace.
    /// Users can override per host from the wizard eventually; for
    /// now a single global label makes the "which agent?" question
    /// answerable at all.
    pub agent_id: String,

    /// When true, every intercepted request is submitted to the
    /// gateway's /api/v1/check endpoint BEFORE being forwarded
    /// upstream. `decision: block` → the proxy returns 403 to the
    /// calling agent, upstream never sees the call. `decision:
    /// pending` → the proxy holds the request up to
    /// `enforce_pending_timeout_secs` seconds, polling for the
    /// human decision.
    ///
    /// Default false. Off means the proxy is observability-only —
    /// safe default for first-time users who don't want their
    /// agents to suddenly start failing.
    #[serde(default)]
    pub enforce: bool,

    /// Max seconds to hold a `pending` request before failing open
    /// (allow with a warning). Only meaningful when `enforce: true`.
    /// 60s = typical human-review SLA; longer risks agent time-
    /// outs propagating back to the user.
    #[serde(default = "default_pending_timeout")]
    pub enforce_pending_timeout_secs: u64,
}

fn default_pending_timeout() -> u64 { 60 }

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            bind: DEFAULT_BIND.to_string(),
            gateway_url: std::env::var("AEGIS_PROXY_GATEWAY_URL")
                .unwrap_or_else(|_| DEFAULT_GATEWAY.to_string()),
            allowlist: DEFAULT_ALLOWLIST.iter().map(|s| s.to_string()).collect(),
            agent_id: "no-code-proxy".to_string(),
            enforce: false,
            enforce_pending_timeout_secs: 60,
        }
    }
}

impl ProxyConfig {
    /// Load from disk, falling back to defaults on any error. Non-
    /// fatal by design — a corrupt config shouldn't lock the user out
    /// of the intercept path.
    pub fn load_or_default(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| toml::from_str::<Self>(&s).ok())
            .unwrap_or_default()
    }

    /// Return the set of hosts we should MITM. Anything else = tunnel.
    pub fn should_mitm(&self, host: &str) -> bool {
        // Exact match — no wildcards for now. Simpler audit story.
        self.allowlist.iter().any(|h| h == host)
    }
}

/// Well-known path for the config file — `~/.config/aegis/proxy.toml`
/// (Linux), `~/Library/Application Support/AEGIS/proxy.toml` (macOS),
/// `%APPDATA%\AEGIS\proxy.toml` (Windows).
pub fn config_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join("Library/Application Support/AEGIS/proxy.toml")
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(base).join("AEGIS/proxy.toml")
    }
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".config/aegis/proxy.toml")
    }
}
