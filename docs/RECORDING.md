# Recording the Demo GIF

## Quick setup

```bash
# Install vhs (terminal GIF recorder)
brew install vhs        # macOS
# or
go install github.com/charmbracelet/vhs@latest

# Make sure AEGIS is running
docker compose up -d

# Record
vhs demo/record.tape
# → writes docs/demo.gif and docs/demo.mp4
```

## What the recording shows

1. Gateway health check
2. `python demo/blocking_demo.py` — safe calls allowed, dangerous calls blocked
3. `curl /api/v1/check/pending` — shows the pending blocking-mode check
4. Points to the dashboard

## Updating README after recording

Replace this line in `README.md`:

```html
<!-- ![AEGIS Demo](docs/demo.gif) -->
```

with:

```html
![AEGIS Demo](docs/demo.gif)
```

## Manual recording alternative (QuickTime)

1. Open Terminal, set font size to 16pt, window ~120×36
2. Run `python demo/blocking_demo.py`
3. Record with QuickTime → File → New Screen Recording
4. Convert to GIF: `ffmpeg -i demo.mov -vf "fps=15,scale=960:-1" docs/demo.gif`
