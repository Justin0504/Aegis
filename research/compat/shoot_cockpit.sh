#!/usr/bin/env bash
# Screenshot the Cockpit against the gateway database the compatibility
# matrix produced.   bash shoot_cockpit.sh [matrix-db] [out-dir]
#
# The matrix gateway writes SQLite in WAL mode, so the database is copied
# with `.backup`, never `cp` (a cp leaves the WAL behind and the copy is
# missing the last minutes of rows). The gateway is started on that copy
# with the model keys loaded, so the alignment auditor can answer; the
# Cockpit is started fresh after the gateway, because a Cockpit that
# outlives a gateway restart comes back with empty panels.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
SRC=${1:-$(ls -t /tmp/aegis-compat-main-*.db | head -1)}
OUT=${2:-$REPO/research/paper-arxiv/images/ui}
DB=/tmp/aegis-cockpit-shoot.db
GW_PORT=18085
CK_PORT=13003

rm -f "$DB" "$DB-wal" "$DB-shm"
sqlite3 "$SRC" ".backup '$DB'"
echo "db: $SRC → $DB ($(sqlite3 "$DB" 'select count(*) from traces') traces)"

# model keys, as the matrix loads them
set -a
for f in "$HOME/.anthropic.env" "$HOME/chronoception/.env" "$HOME/Dynabridge/backend/.env"; do
  [ -f "$f" ] && . <(grep -E '^(export )?[A-Z_]+=' "$f" | sed 's/^export //') || true
done
set +a

# never pkill here: the compatibility matrix may be running its own gateways
if lsof -iTCP:$GW_PORT -sTCP:LISTEN >/dev/null 2>&1 || lsof -iTCP:$CK_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $GW_PORT or $CK_PORT is in use; stop that process first" >&2; exit 1
fi
# The alignment auditor needs a model. Cloud credit is not something a
# screenshot should depend on, so prefer the local Ollama endpoint when it
# is up (the gateway tries a local OpenAI-compatible URL first).
if curl -sf localhost:11434/api/tags >/dev/null 2>&1; then
  export AEGIS_LOCAL_LLM_URL=http://127.0.0.1:11434/v1 AEGIS_LOCAL_LLM_MODEL=${AEGIS_LOCAL_LLM_MODEL:-qwen2.5:7b} AEGIS_LOCAL_LLM_TIMEOUT_MS=60000
fi
PORT=$GW_PORT DB_PATH=$DB AEGIS_LICENSE_TIER=enterprise RATE_LIMIT_MAX=1000000 \
  node "$REPO/packages/gateway-mcp/dist/server.js" > "$HERE/results/shoot-gateway.log" 2>&1 &
GW=$!
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$GW_PORT/health" >/dev/null && break; sleep 0.5; done
KEY=$(curl -s "http://127.0.0.1:$GW_PORT/api/v1/auth/key" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")

( cd "$REPO/apps/compliance-cockpit" && PORT=$CK_PORT GATEWAY_URL="http://127.0.0.1:$GW_PORT" NEXT_PUBLIC_GATEWAY_URL="http://127.0.0.1:$GW_PORT" npx next start -p $CK_PORT > "$HERE/results/shoot-cockpit.log" 2>&1 ) &
CK=$!
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$CK_PORT/" >/dev/null && break; sleep 0.5; done

( cd "$HERE/js" && node shoot.mjs "http://127.0.0.1:$CK_PORT" "http://127.0.0.1:$GW_PORT" "$KEY" "$OUT" )

kill $CK $GW >/dev/null 2>&1 || true
# next start forks a server child; take it down by port
lsof -tiTCP:$CK_PORT -sTCP:LISTEN | xargs kill >/dev/null 2>&1 || true
echo "shots in $OUT"
