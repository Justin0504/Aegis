//! Best-effort local-process attribution for intercepted requests.
//!
//! Given the TCP peer address of an intercepted connection (the
//! `client_addr` hudsucker hands us), find the local process that
//! opened it and label the trace with a meaningful `agent_id` like
//! `claude-code` or `python3 refund_bot.py` instead of the generic
//! `no-code-proxy`.
//!
//! ## Approach
//!
//! Cross-platform TCP-owner lookup is thorny. We use the highest-
//! signal cheap tool per platform:
//!
//! - macOS:   shell out to `lsof -nP -iTCP@127.0.0.1:<local_port>
//!            -sTCP:ESTABLISHED -Fpc`. Returns owner PIDs + the
//!            process short name. Pre-installed on every Mac.
//! - Linux:   parse `/proc/net/tcp` for the socket inode owning the
//!            matching remote endpoint, then walk `/proc/*/fd/*`
//!            symlinks to find the PID whose fd points at that
//!            inode, then read `/proc/<pid>/comm` for the name.
//! - Windows: (not implemented — falls back to configured
//!            agent_id. GetExtendedTcpTable is the correct call
//!            but bringing in `winapi` for one function isn't
//!            worth the dep weight right now; deferred.)
//!
//! Cache: per-peer-address entries live for 30s so we don't
//! re-invoke lsof / re-parse /proc every request. Long-lived
//! connections use the cached attribution for their full lifetime.
//!
//! ## Safety
//!
//! - Fully best-effort. Every resolution path returns Option and
//!   the ladder falls back to the config-level agent_id on any
//!   failure. Never panics, never errors up the call stack.
//! - No cross-user attribution — the resolvers only see sockets
//!   owned by the current UID (`lsof` behaviour, `/proc` perms).
//! - `lsof` shell-out uses a fixed argv (no shell interpolation)
//!   so peer.port() being controlled by remote traffic never
//!   turns into command injection.

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

    fn resolve_uncached(&self, peer: SocketAddr) -> Option<String> {
        // Skip immediately if the peer isn't loopback — traffic from
        // the LAN shouldn't reach us in a well-configured install,
        // but if it does we don't try to attribute a remote host.
        if !peer.ip().is_loopback() {
            return None;
        }
        #[cfg(target_os = "macos")]
        { return macos_owner(peer.port()).map(pretty_name); }
        #[cfg(target_os = "linux")]
        { return linux_owner(peer).map(pretty_name); }
        #[cfg(target_os = "windows")]
        { return windows_owner(peer.port()).map(pretty_name); }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        { let _ = peer; None }
    }
}

/// Prettify a raw command name. Trims arguments to the argv[0] base
/// name so `python3 /path/to/refund_bot.py --foo` becomes
/// `python3 refund_bot.py`. Long names get truncated.
fn pretty_name(raw: String) -> String {
    let trimmed = raw.trim();
    // Grab argv[0] + a shortened argv[1] if present.
    let mut parts = trimmed.split_whitespace();
    let head = parts.next().unwrap_or(trimmed);
    let head_base = std::path::Path::new(head)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(head);
    let tail = parts.next().unwrap_or("");
    let tail_base = std::path::Path::new(tail)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(tail);
    let combined = if tail_base.is_empty() {
        head_base.to_string()
    } else {
        format!("{} {}", head_base, tail_base)
    };
    if combined.len() > 64 { combined.chars().take(64).collect() } else { combined }
}

// ── macOS: lsof shell-out ──────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn macos_owner(local_port: u16) -> Option<String> {
    use std::process::Command;
    // -nP: no name/port resolution (faster + deterministic output).
    // -iTCP@127.0.0.1:<port>: filter to loopback TCP.
    // -sTCP:ESTABLISHED: only connected sockets (not LISTEN).
    // -Fpc: field output — one line per attribute, prefixed by field
    //   code. 'p' = pid, 'c' = command name.
    let out = Command::new("lsof")
        .args([
            "-nP",
            "-iTCP@127.0.0.1",
            "-sTCP:ESTABLISHED",
            "-Fpc",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    // Format is grouped: "p<pid>\nc<cmd>\n..." — we want the record
    // whose subsequent tokens include the local port. But -Fpc alone
    // doesn't emit the local port; we'd need -Fpcn. Simpler: filter
    // by port via a second pass with -a AND -iTCP:port.
    let out2 = Command::new("lsof")
        .args([
            "-nP",
            "-a",
            "-iTCP",
            &format!(":{}", local_port),
            "-sTCP:ESTABLISHED",
            "-Fpc",
        ])
        .output()
        .ok()?;
    if !out2.status.success() {
        let _ = stdout;
        return None;
    }
    let s2 = String::from_utf8_lossy(&out2.stdout);
    let mut cur_pid: Option<String> = None;
    for line in s2.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            cur_pid = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix('c') {
            if cur_pid.is_some() {
                // Return the first command we see for this port —
                // typically there's only one owning process.
                return Some(rest.to_string());
            }
        }
    }
    None
}

// ── Windows: GetExtendedTcpTable + QueryFullProcessImageNameW ──────────
//
// Two-step lookup:
//   1. GetExtendedTcpTable(TCP_TABLE_OWNER_PID_ALL) yields a table
//      whose rows carry (localAddr, localPort, remoteAddr, remotePort,
//      state, owningPid) for every TCP socket on the machine.
//   2. For the matching row we OpenProcess + QueryFullProcessImageNameW
//      to get the image file name; the caller then trims via
//      pretty_name().
//
// Loopback-only guard already applied by the caller. Both steps are
// user-scoped (no elevation required for sockets in the current user's
// session).

#[cfg(target_os = "windows")]
fn windows_owner(local_port: u16) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::AF_INET;
    use windows::Win32::System::ProcessStatus::GetProcessImageFileNameW;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        // Pass NULL + 0 first to learn the required buffer size, then
        // allocate and pass again. Standard Win32 dance.
        let mut size: u32 = 0;
        let _ = GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if size == 0 {
            return None;
        }
        let mut buf: Vec<u8> = vec![0; size as usize];
        let rc = GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if rc != 0 {
            return None;
        }

        // Reinterpret buf as MIB_TCPTABLE_OWNER_PID (dwNumEntries + row[0]).
        let table_ptr = buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
        let n = (*table_ptr).dwNumEntries as usize;
        let rows_ptr = (*table_ptr).table.as_ptr();

        // Look for a row where the local port matches AND state is
        // ESTABLISHED (5). The port is stored in network byte order,
        // shifted into the low 16 bits.
        const MIB_TCP_STATE_ESTAB: u32 = 5;
        let want_be = (local_port as u32).swap_bytes() >> 16;
        for i in 0..n {
            let row: &MIB_TCPROW_OWNER_PID = &*rows_ptr.add(i);
            let row_port = row.dwLocalPort & 0xffff;  // low 16 bits, BE
            if row_port != want_be {
                continue;
            }
            if row.dwState != MIB_TCP_STATE_ESTAB {
                continue;
            }

            let pid = row.dwOwningPid;
            let handle_result = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            let Ok(handle) = handle_result else { return None };
            if handle.is_invalid() {
                return None;
            }

            let mut wbuf: [u16; 1024] = [0; 1024];
            let len = GetProcessImageFileNameW(handle, &mut wbuf);
            let _ = CloseHandle(handle);
            if len == 0 {
                return None;
            }
            let full = String::from_utf16_lossy(&wbuf[..len as usize]);
            // pretty_name later trims argv[0] to a basename; hand it the
            // full NT path (\Device\HarddiskVolumeN\...\claude-code.exe)
            // and let the shared code do that trimming.
            return Some(full);
        }
        None
    }
}

// ── Linux: /proc/net/tcp + /proc/*/fd/* ────────────────────────────────

#[cfg(target_os = "linux")]
fn linux_owner(peer: SocketAddr) -> Option<String> {
    // Parse /proc/net/tcp for the socket whose local_address matches
    // 127.0.0.1:<peer.port()> AND state = ESTABLISHED (0A hex).
    let contents = std::fs::read_to_string("/proc/net/tcp").ok()?;
    let target_port_hex = format!("{:04X}", peer.port());
    let inode = contents
        .lines()
        .skip(1)
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let _sl        = fields.next()?;
            let local      = fields.next()?;   // "0100007F:1234"
            let _remote    = fields.next()?;
            let state      = fields.next()?;   // "01" = ESTABLISHED
            if state != "01" { return None; }
            let local_port = local.rsplit(':').next()?;
            if local_port.eq_ignore_ascii_case(&target_port_hex) {
                // Skip through: tx_queue rx_queue, tr:tm->when, retrnsmt,
                // uid, timeout — 5 fields — to get to inode.
                for _ in 0..5 { fields.next(); }
                fields.next().map(|s| s.to_string())
            } else {
                None
            }
        })?;

    // Walk /proc/<pid>/fd/* symlinks looking for socket:[<inode>].
    let expected_link = format!("socket:[{}]", inode);
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        let pid_name = entry.file_name();
        let pid_str  = pid_name.to_string_lossy();
        if !pid_str.chars().all(|c| c.is_ascii_digit()) { continue; }
        let fd_dir = entry.path().join("fd");
        let Ok(fds) = std::fs::read_dir(&fd_dir) else { continue };
        for fd in fds.flatten() {
            let Ok(link) = std::fs::read_link(fd.path()) else { continue };
            if link.to_string_lossy() == expected_link {
                let comm = std::fs::read_to_string(entry.path().join("comm")).ok()?;
                return Some(comm);
            }
        }
    }
    None
}
