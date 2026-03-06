# AEGIS demo — record with: vhs demo/record.tape
# Install vhs:  brew install vhs   (or  go install github.com/charmbracelet/vhs@latest)
# Output: docs/demo.gif

Output docs/demo.gif
Output docs/demo.mp4

Set Shell "zsh"
Set FontSize 14
Set Width 1000
Set Height 560
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 40ms

# ── Title ──────────────────────────────────────────────────────────────────
Type "# AEGIS — pre-execution blocking for AI agents"
Sleep 800ms
Enter
Sleep 400ms

# ── Start gateway ──────────────────────────────────────────────────────────
Type "# Start AEGIS (already running via docker compose up -d)"
Sleep 500ms
Enter
Type "curl -s http://localhost:8080/health | python3 -m json.tool"
Sleep 200ms
Enter
Sleep 1.5s

# ── Run demo ───────────────────────────────────────────────────────────────
Type "python demo/blocking_demo.py"
Sleep 300ms
Enter
Sleep 6s

# ── Show pending checks ────────────────────────────────────────────────────
Type "# Check pending approvals in the gateway:"
Sleep 400ms
Enter
Type "curl -s http://localhost:8080/api/v1/check/pending | python3 -m json.tool | head -40"
Sleep 200ms
Enter
Sleep 2s

# ── Point to dashboard ─────────────────────────────────────────────────────
Type "# Open dashboard → http://localhost:3000  (Approvals tab)"
Sleep 500ms
Enter
Sleep 1.5s

Type "echo 'github.com/Justin0504/Aegis'"
Enter
Sleep 2s
