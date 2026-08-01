// In debug builds the sidecar entry points are not invoked (the user
// runs gateway + cockpit themselves), which trips the dead-code
// lint on every function in this module. Suppress at the module
// boundary rather than scattering #[allow] on each item.
#![allow(dead_code)]

//! Spawn the embedded gateway + cockpit Node servers in release builds.
//!
//! Dev (`cargo tauri dev`) skips this entirely — the user runs both
//! servers themselves and Tauri loads the Cockpit dev URL.
//!
//! Release (`cargo tauri build`) needs the app to be self-contained:
//!   1. resolve resource paths to the staged bundles
//!   2. spawn `node gateway-bin/server.js`  on port 18080
//!   3. spawn `node cockpit-static/server.js` on port 13001
//!   4. wait for both to bind
//!   5. expose their URLs so lib.rs can point the WebView at the Cockpit
//!
//! On exit the spawned children are killed via [`Sidecars::kill_all`].
//! Non-standard ports (18080 / 13001) keep the desktop app from
//! conflicting with a Docker / dev gateway someone might already have
//! running on 8080 / 3000.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// Ports the embedded servers listen on. Kept off the well-known
/// AEGIS dev ports so a parallel `docker compose up` keeps working.
const GATEWAY_PORT: u16 = 18080;
const COCKPIT_PORT: u16 = 13001;
const PROXY_PORT: u16 = 18081;

pub const COCKPIT_URL: &str = "http://127.0.0.1:13001/welcome";
pub const GATEWAY_URL: &str = "http://127.0.0.1:18080";

#[derive(Debug)]
pub struct Sidecars {
    children: Mutex<Vec<Child>>,
    /// Slot for the transparent proxy — spawned on demand from the
    /// /proxy wizard, not at app boot. Held in its own Mutex so
    /// start/stop don't have to lock all the other sidecars.
    proxy_child: Mutex<Option<Child>>,
}

impl Sidecars {
    pub fn spawn_all(app: &AppHandle) -> Result<Self, String> {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {e}"))?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?;
        std::fs::create_dir_all(&app_data)
            .map_err(|e| format!("create app data dir: {e}"))?;

        let node_bin = resource_dir.join("node-runtime/bin/node");
        let gateway_script = resource_dir.join("gateway-bin/server.js");
        // Next.js standalone in a monorepo nests the entry under the
        // package path. Don't flatten — server.js references its own
        // .next/server tree by that exact relative path.
        let cockpit_script =
            resource_dir.join("cockpit-static/apps/compliance-cockpit/server.js");

        for path in [&node_bin, &gateway_script, &cockpit_script] {
            if !path.exists() {
                return Err(format!("missing sidecar resource: {}", path.display()));
            }
        }

        let db_path = app_data.join("aegis.db");

        let gateway_child = spawn_node(
            &node_bin,
            &gateway_script,
            &[
                ("PORT", GATEWAY_PORT.to_string()),
                ("HOST", "127.0.0.1".into()),
                ("DB_PATH", db_path.to_string_lossy().to_string()),
                ("LOG_LEVEL", "warn".into()),
                ("NODE_ENV", "production".into()),
            ],
        )
        .map_err(|e| format!("spawn gateway: {e}"))?;

        wait_for_port(GATEWAY_PORT, Duration::from_secs(20))
            .map_err(|e| format!("gateway readiness: {e}"))?;

        let cockpit_child = spawn_node(
            &node_bin,
            &cockpit_script,
            &[
                ("PORT", COCKPIT_PORT.to_string()),
                ("HOSTNAME", "127.0.0.1".into()),
                ("NODE_ENV", "production".into()),
                ("GATEWAY_URL", GATEWAY_URL.into()),
            ],
        )
        .map_err(|e| format!("spawn cockpit: {e}"))?;

        wait_for_port(COCKPIT_PORT, Duration::from_secs(20))
            .map_err(|e| format!("cockpit readiness: {e}"))?;

        Ok(Self {
            children: Mutex::new(vec![gateway_child, cockpit_child]),
            proxy_child: Mutex::new(None),
        })
    }

    /// Spawn the transparent-proxy binary (bundled at
    /// `<resources>/proxy-bin/aegis-proxy`). Idempotent: if the proxy
    /// is already running, returns Ok(()) with no side effect.
    pub fn spawn_proxy(&self, app: &AppHandle) -> Result<(), String> {
        {
            // Fast path — already running.
            if let Ok(guard) = self.proxy_child.lock() {
                if guard.is_some() {
                    return Ok(());
                }
            }
        }

        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {e}"))?;
        let bin_name = if cfg!(windows) { "aegis-proxy.exe" } else { "aegis-proxy" };
        let proxy_bin = resource_dir.join("proxy-bin").join(bin_name);
        if !proxy_bin.exists() {
            return Err(format!(
                "proxy binary not bundled at {}. Build with `cargo build --release -p aegis-proxy` and copy into sidecar-stage/proxy-bin/ (see prepare-sidecars.mjs).",
                proxy_bin.display(),
            ));
        }

        let mut cmd = Command::new(&proxy_bin);
        cmd.env("AEGIS_PROXY_GATEWAY_URL", GATEWAY_URL);
        cmd.env("RUST_LOG", "info");
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn proxy: {e}"))?;

        wait_for_port(PROXY_PORT, Duration::from_secs(10))
            .map_err(|e| format!("proxy readiness: {e}"))?;

        if let Ok(mut guard) = self.proxy_child.lock() {
            *guard = Some(child);
        }
        Ok(())
    }

    /// SIGTERM the proxy if it's running. Idempotent.
    pub fn kill_proxy(&self) {
        if let Ok(mut guard) = self.proxy_child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    }

    /// Is the proxy currently spawned by us?
    pub fn is_proxy_running(&self) -> bool {
        self.proxy_child
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    /// Best-effort SIGTERM to every spawned child. Called on app exit.
    pub fn kill_all(&self) {
        if let Ok(mut children) = self.children.lock() {
            for child in children.iter_mut() {
                let _ = child.kill();
            }
            children.clear();
        }
        self.kill_proxy();
    }
}

impl Drop for Sidecars {
    fn drop(&mut self) {
        self.kill_all();
    }
}

fn spawn_node(
    node_bin: &PathBuf,
    script: &PathBuf,
    env: &[(&str, String)],
) -> std::io::Result<Child> {
    let mut cmd = Command::new(node_bin);
    cmd.arg(script);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn()
}

fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        if start.elapsed() > timeout {
            return Err(format!("port {port} not responsive after {timeout:?}"));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
