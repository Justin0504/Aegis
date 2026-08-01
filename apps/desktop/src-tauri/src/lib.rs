//! AEGIS Desktop — Tauri shell over the Cockpit.
//!
//! Dev (`cargo tauri dev`): WebView loads `http://localhost:3000` (the
//! Cockpit dev server) — user runs the gateway and cockpit themselves.
//!
//! Release (`cargo tauri build`): spawn the embedded gateway + cockpit
//! Node servers from sidecar-stage/, wait for both ports to bind, then
//! redirect the WebView at `http://127.0.0.1:13001` and reveal the
//! window. Killed via Drop on app exit.

mod repo_tools;
mod scanner;
mod sidecars;
mod system_proxy;
#[cfg(not(debug_assertions))]
use sidecars::{Sidecars, COCKPIT_URL};
#[cfg(debug_assertions)]
use sidecars::Sidecars;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// Most-recent scan summary, shared between the background scanner
/// and the tray click handler. The tray click reads `top_pid` to
/// build a deep link like `/welcome?pid=12345`, which the Cockpit
/// uses to scroll/highlight the specific unprotected process.
#[derive(Default, Clone, Copy)]
struct ScanSummary {
    top_pid: Option<u32>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // ── Spawn the embedded gateway + cockpit in release builds.
            //    In dev we let the user run them — devUrl in tauri.conf.json
            //    already points at the Cockpit dev server (:3000).
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle();
                let sidecars = Sidecars::spawn_all(handle)
                    .map_err(|e| format!("failed to start AEGIS sidecars: {e}"))?;

                // Redirect the auto-opened (placeholder) window at the
                // spawned Cockpit, then reveal it.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval(&format!(
                        "window.location.replace('{COCKPIT_URL}')",
                    ));
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                app.manage(sidecars);
            }

            // ── System tray ──────────────────────────────────────────────
            // `label_status` is kept around in a shared handle so the
            // background scanner task can rewrite it every 30 s with a live
            // count of unprotected agent processes.
            let open_item = MenuItem::with_id(app, "open", "Open AEGIS", true, None::<&str>)?;
            // Shared scan summary — updated by the background scanner,
            // read by the tray click handler to pick a deep-link target.
            let scan_summary: Arc<Mutex<ScanSummary>> =
                Arc::new(Mutex::new(ScanSummary::default()));

            let separator_label = Arc::new(MenuItem::with_id(
                app,
                "label_status",
                "Scanning for agents…",
                false,
                None::<&str>,
            )?);
            let quit_item = MenuItem::with_id(app, "quit", "Quit AEGIS", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[separator_label.as_ref(), &open_item, &quit_item],
            )?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("AEGIS — runtime safety layer")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event({
                    let scan_summary = Arc::clone(&scan_summary);
                    move |tray, event| {
                        if let TrayIconEvent::Click { .. } = event {
                            if let Some(window) =
                                tray.app_handle().get_webview_window("main")
                            {
                                let _ = window.show();
                                let _ = window.set_focus();
                                // Jump straight to /welcome — the panel that
                                // surfaces the unprotected-agent list and the
                                // SDK snippets. If the background scanner has
                                // found at least one unprotected agent, append
                                // `?pid=<first>` so the page can scroll/highlight
                                // the specific process.
                                let summary = scan_summary
                                    .lock()
                                    .map(|s| *s)
                                    .unwrap_or_default();
                                let mut href = welcome_url().to_string();
                                if let Some(pid) = summary.top_pid {
                                    href.push_str(&format!("?pid={pid}"));
                                }
                                let _ = window.eval(&format!(
                                    "window.location.href = '{href}'"
                                ));
                            }
                        }
                    }
                })
                .build(app)?;

            // ── Background scanner: refresh tray badge every 30 s ──────────
            // Three signals composed: text label in the menu, the numeric
            // badge next to the icon (macOS only, via set_title), and the
            // icon itself — swapped to a warning variant with a small red
            // dot when any unprotected agent is detected.
            // Both icons embedded at compile time so the spawned async task
            // doesn't need to share a reference back to the App handle.
            let icon_normal: Image<'static> = tauri::include_image!("./icons/icon.png");
            let icon_warning: Image<'static> =
                tauri::include_image!("./icons/icon-warning.png");

            let handle = app.handle().clone();
            let status_item = Arc::clone(&separator_label);
            let scan_summary_writer = Arc::clone(&scan_summary);
            tauri::async_runtime::spawn(async move {
                let mut last_warning_state: Option<bool> = None;
                loop {
                    let candidates = scanner::scan();
                    let count = candidates.len();
                    let top_pid = candidates.first().map(|c| c.pid);
                    if let Ok(mut s) = scan_summary_writer.lock() {
                        *s = ScanSummary { top_pid };
                    }
                    let label = if count == 0 {
                        "No unprotected agents detected".to_string()
                    } else if count == 1 {
                        "1 unprotected agent detected".to_string()
                    } else {
                        format!("{count} unprotected agents detected")
                    };
                    let _ = status_item.set_text(&label);
                    if let Some(tray) = handle.tray_by_id("main-tray") {
                        // macOS-only: empty title clears the badge.
                        let badge = if count == 0 {
                            None
                        } else {
                            Some(count.to_string())
                        };
                        let _ = tray.set_title(badge.as_deref());

                        // Only set_icon when the state actually flipped —
                        // some platforms repaint the menu bar on every call.
                        let want_warning = count > 0;
                        if last_warning_state != Some(want_warning) {
                            let img = if want_warning {
                                icon_warning.clone()
                            } else {
                                icon_normal.clone()
                            };
                            let _ = tray.set_icon(Some(img));
                            last_warning_state = Some(want_warning);
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Kill spawned sidecars when the user closes the main window.
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.app_handle().try_state::<Sidecars>() {
                    state.kill_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            gateway_url,
            list_candidate_agents,
            repo_tools::aegis_runtime_check,
            repo_tools::aegis_scan_repo,
            repo_tools::aegis_inject_repo,
            system_proxy::system_proxy_enable,
            system_proxy::system_proxy_disable,
            system_proxy::system_proxy_status,
            system_proxy::install_proxy_ca,
            system_proxy::uninstall_proxy_ca,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── IPC commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! AEGIS desktop is running.")
}

/// Resolve the welcome-page URL for the embedded (release) or external
/// dev Cockpit. Used by the tray click handler.
fn welcome_url() -> &'static str {
    #[cfg(debug_assertions)]
    {
        "http://localhost:3000/welcome"
    }
    #[cfg(not(debug_assertions))]
    {
        sidecars::COCKPIT_URL
    }
}

/// Scan running processes for agent-shaped candidates that are NOT
/// already wired through AEGIS. Heuristic — see scanner.rs.
#[tauri::command]
fn list_candidate_agents() -> Vec<scanner::CandidateAgent> {
    scanner::scan()
}

/// Tell the WebView which URL the embedded gateway is reachable at.
/// Cockpit code can call this via `window.__TAURI__.core.invoke('gateway_url')`
/// instead of hard-coding 8080 vs 18080 vs whatever the dev value is.
#[tauri::command]
fn gateway_url() -> String {
    #[cfg(debug_assertions)]
    {
        "http://localhost:8080".into()
    }
    #[cfg(not(debug_assertions))]
    {
        sidecars::GATEWAY_URL.into()
    }
}
