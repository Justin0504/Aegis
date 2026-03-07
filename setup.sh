#!/usr/bin/env bash
set -e

# ── AEGIS One-Command Setup ──────────────────────────────────
# Usage: ./setup.sh
# ──────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${GREEN}$1${NC}"; }
error() { echo -e "${RED}$1${NC}"; }
dim()   { echo -e "${DIM}$1${NC}"; }

# ── 1. Check Docker ──────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  error "Docker is not installed."
  echo "Install it from https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker compose version &>/dev/null && ! command -v docker-compose &>/dev/null; then
  error "Docker Compose is not installed."
  exit 1
fi

# Determine compose command
if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi

# ── 2. Create .env if missing ────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  dim "Created .env from .env.example"
fi

# ── 3. Build & start ─────────────────────────────────────────
info "Building and starting AEGIS..."
$COMPOSE up -d --build

# ── 4. Wait for gateway health ───────────────────────────────
echo -n "Waiting for gateway"
for i in $(seq 1 30); do
  if curl -sf http://localhost:8080/health >/dev/null 2>&1; then
    echo ""
    info "Gateway is healthy."
    break
  fi
  echo -n "."
  sleep 2
done

if ! curl -sf http://localhost:8080/health >/dev/null 2>&1; then
  echo ""
  error "Gateway did not become healthy within 60s."
  echo "Check logs: $COMPOSE logs gateway"
  exit 1
fi

# ── 5. Done ──────────────────────────────────────────────────
echo ""
echo "================================================"
info "  AEGIS is running!"
echo "================================================"
echo ""
echo "  Dashboard  :  http://localhost:3000"
echo "  Gateway API:  http://localhost:8080"
echo ""
dim "  Stop:   $COMPOSE down"
dim "  Logs:   $COMPOSE logs -f"
echo ""
