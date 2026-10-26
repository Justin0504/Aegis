#!/usr/bin/env bash
# The MCP rug pull, recorded and photographed.   bash shoot_mcp.sh [ui-out-dir]
#
# Starts a fresh gateway, runs mcp_rugpull_demo.py through the shipping
# proxy (card G9's data → paper-arxiv/figdata/captures/g9_*), then starts
# the Cockpit on that gateway and captures Settings → MCP tools with one
# tool in each state (view U1 → images/ui/mcp-tools.png). Stops only the
# two processes it started.
set -euo pipefail
export PLAYWRIGHT_BROWSERS_PATH=0
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT=${1:-$REPO/research/paper-arxiv/images/ui}
DB=$(mktemp -d)/mcp.db
GW_PORT=18087
CK_PORT=13004

if lsof -iTCP:$GW_PORT -sTCP:LISTEN >/dev/null 2>&1 || lsof -iTCP:$CK_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $GW_PORT or $CK_PORT is in use; stop that process first" >&2; exit 1
fi
PORT=$GW_PORT DB_PATH=$DB AEGIS_LICENSE_TIER=enterprise RATE_LIMIT_MAX=1000000 LOG_LEVEL=warn \
  node "$REPO/packages/gateway-mcp/dist/server.js" > "$HERE/results/shoot-mcp-gateway.log" 2>&1 &
GW=$!
CK=
trap 'kill $GW >/dev/null 2>&1 || true; [ -n "$CK" ] && kill $CK >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$GW_PORT/health" >/dev/null && break; sleep 0.5; done
KEY=$(curl -s "http://127.0.0.1:$GW_PORT/api/v1/auth/key" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")

"$HERE/.venv/bin/python" "$HERE/mcp_rugpull_demo.py" run "http://127.0.0.1:$GW_PORT" "$KEY"

( cd "$REPO/apps/compliance-cockpit" && PORT=$CK_PORT GATEWAY_URL="http://127.0.0.1:$GW_PORT" \
    NEXT_PUBLIC_GATEWAY_URL="http://127.0.0.1:$GW_PORT" exec npx next start -p $CK_PORT ) \
  > "$HERE/results/shoot-mcp-cockpit.log" 2>&1 &
CK=$!
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$CK_PORT/" >/dev/null && break; sleep 0.5; done
( cd "$HERE/js" && SHOOT_PAGES="/settings#mcp=mcp-tools" node shoot.mjs "http://127.0.0.1:$CK_PORT" "http://127.0.0.1:$GW_PORT" "$KEY" "$OUT" )
echo "G9 data in research/paper-arxiv/figdata/captures/, U1 in $OUT/mcp-tools.png"
