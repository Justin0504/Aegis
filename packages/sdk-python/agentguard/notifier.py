"""
Cross-platform desktop notifications for AEGIS block events.
- macOS : osascript (built-in, zero deps)
- Linux : notify-send (libnotify)
- Windows: PowerShell toast
"""

import subprocess
import sys
import threading


def _notify_macos(title: str, subtitle: str, message: str) -> None:
    script = (
        f'display notification "{_esc(message)}" '
        f'with title "{_esc(title)}" '
        f'subtitle "{_esc(subtitle)}"'
    )
    subprocess.Popen(
        ["osascript", "-e", script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _notify_linux(title: str, subtitle: str, message: str) -> None:
    subprocess.Popen(
        ["notify-send", "-u", "critical", f"{title} — {subtitle}", message],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _notify_windows(title: str, subtitle: str, message: str) -> None:
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$n = New-Object System.Windows.Forms.NotifyIcon; "
        "$n.Icon = [System.Drawing.SystemIcons]::Warning; "
        "$n.Visible = $true; "
        f'$n.ShowBalloonTip(5000, "{_esc(title)}: {_esc(subtitle)}", "{_esc(message)}", '
        "[System.Windows.Forms.ToolTipIcon]::Warning)"
    )
    subprocess.Popen(
        ["powershell", "-Command", ps],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _esc(s: str) -> str:
    """Escape double-quotes and backslashes for shell embedding."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def notify_block(tool_name: str, risk_level: str, reason: str = "") -> None:
    """
    Fire a non-blocking desktop notification when a tool call is blocked.
    Runs in a daemon thread so it never delays the agent.
    """
    title    = "AEGIS — Tool Blocked"
    subtitle = f"{tool_name}  [{risk_level}]"
    message  = reason or "Policy violation — check the AEGIS dashboard."

    def _fire():
        try:
            if sys.platform == "darwin":
                _notify_macos(title, subtitle, message)
            elif sys.platform.startswith("linux"):
                _notify_linux(title, subtitle, message)
            elif sys.platform == "win32":
                _notify_windows(title, subtitle, message)
        except Exception:
            pass  # notifications are best-effort

    t = threading.Thread(target=_fire, daemon=True)
    t.start()


def notify_pending(tool_name: str, risk_level: str) -> None:
    """Fire a notification when a tool call is pending human approval."""
    title    = "AEGIS — Approval Required"
    subtitle = f"{tool_name}  [{risk_level}]"
    message  = "A tool call is awaiting your approval in the AEGIS dashboard."

    def _fire():
        try:
            if sys.platform == "darwin":
                _notify_macos(title, subtitle, message)
            elif sys.platform.startswith("linux"):
                _notify_linux(title, subtitle, message)
            elif sys.platform == "win32":
                _notify_windows(title, subtitle, message)
        except Exception:
            pass

    t = threading.Thread(target=_fire, daemon=True)
    t.start()
