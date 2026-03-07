# AEGIS Deployment Guide

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Compliance    │────▶│   MCP Gateway   │
│    Cockpit      │     │   (Port 8080)   │
│  (Port 3000)    │     └────────┬────────┘
└─────────────────┘              │
                                 └──────▶ SQLite (embedded)
```

Two containers. No external databases.

## Quick Start

```bash
./setup.sh
```

Or manually:

```bash
cp .env.example .env
docker compose up -d
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_PORT` | `8080` | Gateway HTTP port |
| `DB_PATH` | `./agentguard.db` | SQLite database path |
| `DEFAULT_RISK_THRESHOLD` | `MEDIUM` | Default risk threshold |
| `AUTO_APPROVE_BELOW` | `LOW` | Auto-approve below this risk |
| `NEXT_PUBLIC_GATEWAY_URL` | `http://localhost:8080` | Gateway URL for dashboard |

## Development Mode

```bash
make dev
```

Volume-mounts source directories for hot-reload.

## Database

SQLite, stored in a Docker named volume (`gateway-data`).

### Backup
```bash
docker compose exec gateway sqlite3 /data/agentguard.db ".backup '/data/backup.db'"
docker cp "$(docker compose ps -q gateway)":/data/backup.db ./backup.db
```

## Production Notes

- Add a reverse proxy (nginx/Caddy) in front for TLS
- Set resource limits in docker-compose override
- Back up the SQLite volume regularly
- Monitor via the built-in OpenTelemetry integration (`OTEL_ENABLED=true`)

## Troubleshooting

**Container won't start:**
```bash
docker compose logs gateway
docker compose build --no-cache gateway
```

**Port conflict:**
```bash
lsof -ti:8080 | xargs kill -9
docker compose up -d
```

**Database locked:**
```bash
docker compose restart gateway
```
