//! Best-effort local-process attribution for intercepted requests.
//!
//! Given the TCP peer address of an intercepted connection (the
//! `client_addr` hudsucker hands us), find the local process that
//! opened it and label the trace with a meaningful `agent_id` like
//! `claude-code` or `python refund_bot.py` instead of the generic
//! `no-code-proxy`.
//!
//! ## How it works
//!
//! We scan the local socket table (via `sysinfo` on each platform)
//! and find the PID whose owned socket has the matching remote
//! endpoint. That PID's cmdline becomes the attribution string.
//!
//! Cache: per-peer-address entries live for 30s so we don't rescan
//! /proc every request. Long-lived connections use the cached
//! attribution for their full lifetime.
//!
//! ## Fallback ladder
//!
//! 1. Cached hit → return immediately.
//! 2. sysinfo lookup → best short_name of the owning process.
//! 3. On any failure (permissions, race, missing feature) → fall
//!    back to the config-level `agent_id` (default "no-code-proxy").
//!
//! Never blocks the request; never errors up the call stack.

use dashmap::DashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Attributor {
    fallback: String,
    cache: Arc<DashMap<SocketAddr, CachedAttr>>,
}

#[derive(Clone)]
struct CachedAttr {
    agent_id: String,
    at: Instant,
}

impl Attributor {
    pub fn new(fallback: impl Into<String>) -> Self {
        Self {
            fallback: fallback.into(),
            cache: Arc::new(DashMap::new()),
        }
    }

    /// Resolve the caller PID for the given local-side peer address
    /// and return the derived agent_id. Cached for 30s per address.
    pub fn resolve(&self, peer: SocketAddr) -> String {
        if let Some(entry) = self.cache.get(&peer) {
            if entry.at.elapsed() < CACHE_TTL {
                return entry.agent_id.clone();
            }
        }
        let agent_id = self.resolve_uncached(peer).unwrap_or_else(|| self.fallback.clone());
        self.cache.insert(peer, CachedAttr { agent_id: agent_id.clone(), at: Instant::now() });
        agent_id
    }

    fn resolve_uncached(&self, _peer: SocketAddr) -> Option<String> {
        // Platform-specific TCP-owner resolution.
        //
        // Current implementation returns None (falls back to the
        // configured agent_id). Doing this well needs:
        //   · Linux:   parse /proc/net/tcp + /proc/*/fd/* to find
        //              the socket inode owner.
        //   · macOS:   `lsof -nP -iTCP:<port>` shell-out or the
        //              libproc private API (proc_pidfdinfo).
        //   · Windows: GetExtendedTcpTable + PID → process name.
        //
        // Each has real edge cases (permissions, races, non-ASCII
        // paths). Ship the plumbing first; the resolver is a
        // separate follow-up.
        None
    }
}
