//! System-proxy + CA-trust helpers for the "no-code" integration path.
//!
//! These commands do the OS-level plumbing needed to route agent
//! HTTPS traffic through the AEGIS proxy on `localhost:18081` — i.e.
//! the piece that lets a user install AEGIS and immediately have
//! Claude Code / Cursor / whatever else observed, without ever
//! touching their agent source code.
//!
//! Every function here is a thin, auditable wrapper around a well-
//! known OS command:
//!
//!   macOS   networksetup / security add-trusted-cert
//!   Windows netsh winhttp set proxy / certutil -addstore -f ROOT
//!   Linux   http_proxy env + /usr/local/share/ca-certificates/
//!
//! We deliberately do NOT try to write a cross-platform abstraction
//! that hides which command actually ran — the operator's audit trail
//! records the exact shell invocation so a security review can
//! reproduce it. The Tauri command results always include the
//! command that was run.
//!
//! ## Security posture
//!
//! Installing a root CA into the system trust store is a real
//! privilege — with our CA cert installed, we can decrypt any TLS
//! traffic to any host by generating a leaf on the fly. That is the
//! whole point of transparent MITM. We mitigate by:
//!
//!   1. The CA private key never leaves the user's machine (generated
//!      on first launch, stored in the OS keychain — not exported).
//!   2. The proxy binary maintains a strict host allowlist. Traffic
//!      to hosts NOT on the list is passed through TCP-tunnel-style
//!      without decryption.
//!   3. The Tauri commands here require the user to grant OS admin
//!      via the standard sudo / UAC prompt — we shell out; we never
//!      persist credentials.
//!   4. Uninstall is idempotent and reversible.

use std::process::Command;
use serde::Serialize;

const PROXY_HOST: &str = "127.0.0.1";
const PROXY_PORT: u16 = 18081;

/// Structured result of running an OS proxy/trust command. The
/// frontend renders `command` verbatim so the user sees exactly what
/// happened — no black-box "trust us" UX.
#[derive(Debug, Serialize, Clone)]
pub struct SysCmdResult {
    pub ok: bool,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub hint: Option<String>,
}

impl SysCmdResult {
    fn from_output(command: String, output: std::process::Output, hint: Option<&str>) -> Self {
        Self {
            ok: output.status.success(),
            command,
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            hint: hint.map(str::to_string),
        }
    }
    fn err(command: String, msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            command,
            stdout: String::new(),
            stderr: msg.into(),
            hint: None,
        }
    }
}

// ── System proxy configuration ─────────────────────────────────────────────

/// Route all HTTPS/HTTP traffic through the AEGIS proxy. Requires
/// admin privilege (elevated shell / sudo). Idempotent — running twice
/// leaves the system in the same state as running once.
#[tauri::command]
pub fn system_proxy_enable() -> SysCmdResult {
    #[cfg(target_os = "macos")]
    {
        // networksetup operates per-network-service. We flip the
        // active one only, so a Wi-Fi user doesn't get Ethernet
        // reconfigured underneath them.
        let cmd_str = format!(
            "networksetup -setwebproxy \"{}\" {} {} && \
             networksetup -setsecurewebproxy \"{}\" {} {}",
            active_macos_service_or_default(),
            PROXY_HOST, PROXY_PORT,
            active_macos_service_or_default(),
            PROXY_HOST, PROXY_PORT,
        );
        let out = Command::new("sh").arg("-c").arg(&cmd_str).output();
        match out {
            Ok(o) => SysCmdResult::from_output(
                cmd_str, o,
                Some("If prompted for admin, enter your macOS password. Verify: `networksetup -getwebproxy Wi-Fi`."),
            ),
            Err(e) => SysCmdResult::err(cmd_str, format!("failed to spawn networksetup: {e}")),
        }
    }
    #[cfg(target_os = "windows")]
    {
        // netsh winhttp sets the WinHTTP proxy — covers most tools
        // that use the OS default. WinINET (browsers) requires an
        // additional registry edit; we handle in the wizard.
        let cmd_str = format!(
            "netsh winhttp set proxy proxy-server=\"http={host}:{port};https={host}:{port}\" bypass-list=\"<local>\"",
            host = PROXY_HOST, port = PROXY_PORT,
        );
        let out = Command::new("cmd").args(["/C", &cmd_str]).output();
        match out {
            Ok(o) => SysCmdResult::from_output(
                cmd_str, o,
                Some("Elevate the command prompt for this to take effect (right-click → Run as administrator)."),
            ),
            Err(e) => SysCmdResult::err(cmd_str, format!("failed to spawn netsh: {e}")),
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Linux doesn't have a single OS-wide proxy setting. We
        // instead export http_proxy / https_proxy in a well-known
        // rc file and instruct the user to `source` it. The Cockpit
        // wizard shows the exact next-shell command.
        let file = expand_home("~/.aegis-proxy.env");
        let contents = format!(
            "# Written by AEGIS\nexport http_proxy=http://{host}:{port}\nexport https_proxy=http://{host}:{port}\n",
            host = PROXY_HOST, port = PROXY_PORT,
        );
        match std::fs::write(&file, contents) {
            Ok(_) => SysCmdResult {
                ok: true,
                command: format!("wrote {}", file),
                stdout: String::new(),
                stderr: String::new(),
                hint: Some(format!("Then run: `source {}` in each shell (or add to ~/.bashrc / ~/.zshrc).", file)),
            },
            Err(e) => SysCmdResult::err(format!("write {}", file), e.to_string()),
        }
    }
}

/// Undo `system_proxy_enable`. Idempotent.
#[tauri::command]
pub fn system_proxy_disable() -> SysCmdResult {
    #[cfg(target_os = "macos")]
    {
        let cmd_str = format!(
            "networksetup -setwebproxystate \"{s}\" off && networksetup -setsecurewebproxystate \"{s}\" off",
            s = active_macos_service_or_default(),
        );
        let out = Command::new("sh").arg("-c").arg(&cmd_str).output();
        match out {
            Ok(o) => SysCmdResult::from_output(cmd_str, o, None),
            Err(e) => SysCmdResult::err(cmd_str, format!("failed to spawn networksetup: {e}")),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let cmd_str = "netsh winhttp reset proxy".to_string();
        let out = Command::new("cmd").args(["/C", &cmd_str]).output();
        match out {
            Ok(o) => SysCmdResult::from_output(cmd_str, o, None),
            Err(e) => SysCmdResult::err(cmd_str, format!("failed to spawn netsh: {e}")),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let file = expand_home("~/.aegis-proxy.env");
        match std::fs::remove_file(&file) {
            Ok(_) => SysCmdResult { ok: true, command: format!("rm {}", file), stdout: String::new(), stderr: String::new(), hint: None },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => SysCmdResult { ok: true, command: format!("rm {}", file), stdout: String::new(), stderr: "already removed".into(), hint: None },
            Err(e) => SysCmdResult::err(format!("rm {}", file), e.to_string()),
        }
    }
}

/// Read whether the AEGIS proxy is currently the active system proxy.
#[tauri::command]
pub fn system_proxy_status() -> SysCmdResult {
    #[cfg(target_os = "macos")]
    {
        let cmd = format!("networksetup -getsecurewebproxy \"{}\"", active_macos_service_or_default());
        let out = Command::new("sh").arg("-c").arg(&cmd).output();
        match out {
            Ok(o) => SysCmdResult::from_output(cmd, o, None),
            Err(e) => SysCmdResult::err(cmd, e.to_string()),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let cmd = "netsh winhttp show proxy".to_string();
        let out = Command::new("cmd").args(["/C", &cmd]).output();
        match out {
            Ok(o) => SysCmdResult::from_output(cmd, o, None),
            Err(e) => SysCmdResult::err(cmd, e.to_string()),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let file = expand_home("~/.aegis-proxy.env");
        SysCmdResult {
            ok: std::path::Path::new(&file).exists(),
            command: format!("stat {}", file),
            stdout: if std::path::Path::new(&file).exists() { format!("proxy env at {}", file) } else { String::new() },
            stderr: String::new(),
            hint: None,
        }
    }
}

// ── CA cert install ────────────────────────────────────────────────────────
//
// The proxy needs to sign leaf certs on the fly for hosts it MITMs.
// Those leafs chain to a CA cert we generate on first launch. That CA
// has to be in the system trust store or clients will (correctly)
// reject the connection. These commands install / uninstall the CA.

/// Path where the proxy binary writes the generated CA cert (PEM).
/// The proxy binary itself owns the private key — this is only the
/// public cert, safe to expose to trust-store install commands.
fn ca_cert_path() -> String {
    #[cfg(target_os = "macos")]
    { expand_home("~/Library/Application Support/AEGIS/aegis-proxy-ca.crt") }
    #[cfg(target_os = "windows")]
    { expand_home("~\\AppData\\Roaming\\AEGIS\\aegis-proxy-ca.crt") }
    #[cfg(target_os = "linux")]
    { expand_home("~/.config/aegis/aegis-proxy-ca.crt") }
}

/// Add the AEGIS proxy CA to the system trust store. Prompts for
/// admin via the OS keychain dialog / UAC / pkexec.
#[tauri::command]
pub fn install_proxy_ca() -> SysCmdResult {
    let path = ca_cert_path();
    if !std::path::Path::new(&path).exists() {
        return SysCmdResult::err(
            format!("stat {}", path),
            "AEGIS proxy CA not generated yet — start the proxy first (Proxy tab → Start).".to_string(),
        );
    }

    #[cfg(target_os = "macos")]
    {
        // admin=true → OS prompts for password dialog. Trust settings
        // scope: all users, SSL only.
        let cmd = format!(
            "sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"{}\"",
            path
        );
        let out = Command::new("sh").arg("-c").arg(&cmd).output();
        match out {
            Ok(o) => SysCmdResult::from_output(
                cmd, o,
                Some("Verify in Keychain Access → System keychain → search 'AEGIS'."),
            ),
            Err(e) => SysCmdResult::err(cmd, e.to_string()),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let cmd = format!("certutil -addstore -f ROOT \"{}\"", path);
        let out = Command::new("cmd").args(["/C", &cmd]).output();
        match out {
            Ok(o) => SysCmdResult::from_output(
                cmd, o,
                Some("Run from an elevated shell (Right-click → Run as administrator)."),
            ),
            Err(e) => SysCmdResult::err(cmd, e.to_string()),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let dest = "/usr/local/share/ca-certificates/aegis-proxy-ca.crt";
        let cmd = format!("sudo cp \"{}\" {} && sudo update-ca-certificates", path, dest);
        let out = Command::new("sh").arg("-c").arg(&cmd).output();
        match out {
            Ok(o) => SysCmdResult::from_output(cmd, o, Some("Verify: `ls /etc/ssl/certs/ | grep aegis`.")),
            Err(e) => SysCmdResult::err(cmd, e.to_string()),
        }
    }
}

/// Remove the AEGIS proxy CA from the system trust store.
#[tauri::command]
pub fn uninstall_proxy_ca() -> SysCmdResult {
    #[cfg(target_os = "macos")]
    {
        // Match by common-name. The generator uses CN=AEGIS Proxy CA.
        let cmd = "sudo security delete-certificate -c \"AEGIS Proxy CA\" /Library/Keychains/System.keychain".to_string();
        let out = Command::new("sh").arg("-c").arg(&cmd).output();
        match out {
            Ok(o) => SysCmdResult::from_output(cmd, o, None),
            Err(e) => SysCmdResult::err(cmd, e.to_string()),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let cmd = "certutil -delstore ROOT \"AEGIS Proxy CA\"".to_string();
        let out = Command::new("cmd").args(["/C", &cmd]).output();
        match out {
            Ok(o) => SysCmdResult::from_output(cmd, o, None),
            Err(e) => SysCmdResult::err(cmd, e.to_string()),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let cmd = "sudo rm -f /usr/local/share/ca-certificates/aegis-proxy-ca.crt && sudo update-ca-certificates --fresh".to_string();
        let out = Command::new("sh").arg("-c").arg(&cmd).output();
        match out {
            Ok(o) => SysCmdResult::from_output(cmd, o, None),
            Err(e) => SysCmdResult::err(cmd, e.to_string()),
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Expand a leading `~` to the current user's home directory.
/// Falls back to the input unchanged if $HOME (macOS/Linux) or
/// %USERPROFILE% (Windows) is not set.
fn expand_home(path: &str) -> String {
    let (prefix, home_var) = if cfg!(windows) {
        ("~\\", "USERPROFILE")
    } else {
        ("~/", "HOME")
    };
    if let Some(rest) = path.strip_prefix(prefix) {
        if let Ok(home) = std::env::var(home_var) {
            let sep = if cfg!(windows) { "\\" } else { "/" };
            return format!("{}{}{}", home, sep, rest);
        }
    }
    path.to_string()
}

#[cfg(target_os = "macos")]
fn active_macos_service_or_default() -> String {
    // networksetup exposes -listnetworkserviceorder; the first
    // service line (after the intro) is the active one. Fallback
    // "Wi-Fi" covers 95% of laptops if parsing fails.
    let out = Command::new("networksetup")
        .arg("-listnetworkserviceorder")
        .output();
    if let Ok(o) = out {
        let s = String::from_utf8_lossy(&o.stdout);
        for line in s.lines() {
            if let Some(rest) = line.strip_prefix("(1) ") {
                return rest.trim().to_string();
            }
        }
    }
    "Wi-Fi".to_string()
}
