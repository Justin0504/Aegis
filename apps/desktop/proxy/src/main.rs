//! AEGIS transparent proxy — main entrypoint.
//!
//! Usage: `aegis-proxy` (no args). Config file at
//! `~/Library/Application Support/AEGIS/proxy.toml` (macOS) or
//! `~/.config/aegis/proxy.toml` (Linux) or `%APPDATA%\AEGIS\proxy.toml`
//! (Windows). Missing config = defaults.
//!
//! On start:
//!   1. Load (or generate) the AEGIS root CA.
//!   2. Bind hudsucker on `127.0.0.1:18081`, MITM'ing allowlisted
//!      hosts and tunneling everything else.
//!   3. Forward every intercepted call as a trace to the gateway.
//!
//! Exit codes:
//!   0 = graceful shutdown (SIGINT / Ctrl-C)
//!   non-zero = fatal config / CA / bind error

use hudsucker::{certificate_authority::RcgenAuthority, Proxy};
use std::sync::Arc;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

mod attribution;
mod ca;
mod config;
mod handler;
mod llm;

use crate::attribution::Attributor;
use crate::ca::{load_or_init, CaPaths};
use crate::config::{config_path, ProxyConfig};
use crate::handler::Handler;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer())
        .init();
    tracing::info!(target: "aegis-proxy", version = env!("CARGO_PKG_VERSION"), "starting");

    let cfg = Arc::new(ProxyConfig::load_or_default(&config_path()));
    tracing::info!(
        target: "aegis-proxy",
        bind = %cfg.bind,
        gateway = %cfg.gateway_url,
        allowlist_count = cfg.allowlist.len(),
        "config loaded",
    );

    let paths = CaPaths::platform_default();
    let (key_pair, ca_cert) = load_or_init(&paths)?;
    tracing::info!(
        target: "aegis-proxy",
        cert_pem = %paths.cert_pem.display(),
        "AEGIS root CA ready — install into OS trust store via the desktop wizard",
    );

    let ca = RcgenAuthority::new(key_pair, ca_cert, 1_000);

    let handler = Handler {
        config: cfg.clone(),
        http: reqwest::Client::builder()
            .no_proxy() // don't loop through ourselves
            .build()?,
        pending: Arc::new(dashmap::DashMap::new()),
        attributor: Attributor::new(cfg.agent_id.clone()),
    };

    let bind_addr: std::net::SocketAddr = cfg.bind.parse()?;
    let proxy = Proxy::builder()
        .with_addr(bind_addr)
        .with_rustls_client()
        .with_ca(ca)
        .with_http_handler(handler)
        .with_graceful_shutdown(shutdown_signal())
        .build();

    tracing::info!(target: "aegis-proxy", %bind_addr, "listening");
    proxy.start().await?;
    tracing::info!(target: "aegis-proxy", "shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!(target: "aegis-proxy", "SIGINT — shutting down");
}
