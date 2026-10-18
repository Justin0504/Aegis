#!/usr/bin/env bash
# Screenshot the Cockpit on real agent runs.   bash shoot_replay.sh [out-dir] [pages]
#
# Starts a fresh gateway with the instruction-provenance pack, replays real
# AgentDojo transcripts through it the way the SDK reports a live agent
# (replay_agentdojo.py: context spans, blocking checks, hash-chained
# traces), starts the Cockpit against it, and captures the pages. The last
# three runs keep their holds pending, so the approval queue shows them
# with their evidence. Transcripts: qwen3:8b, final configuration
# (research/agentdojo/results/logs/local-qwen3-8b-aegis_v3_audit).
set -euo pipefail
# Browsers live inside js/node_modules (installed with PLAYWRIGHT_BROWSERS_PATH=0),
# so a cache clean-up cannot remove them between captures.
export PLAYWRIGHT_BROWSERS_PATH=0
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT=${1:-$REPO/research/paper-arxiv/images/ui}
PAGES=${2:-/,/approvals,/traces,/coverage}
L=$REPO/research/agentdojo/results/logs/local-qwen3-8b-aegis_v3_audit
DB=$(mktemp -d)/shoot.db
GW_PORT=18085
CK_PORT=13003

if lsof -iTCP:$GW_PORT -sTCP:LISTEN >/dev/null 2>&1 || lsof -iTCP:$CK_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $GW_PORT or $CK_PORT is in use; stop that process first" >&2; exit 1
fi
PORT=$GW_PORT DB_PATH=$DB AEGIS_LICENSE_TIER=enterprise RATE_LIMIT_MAX=1000000 LOG_LEVEL=warn \
  node "$REPO/packages/gateway-mcp/dist/server.js" > "$HERE/results/shoot-gateway.log" 2>&1 &
GW=$!
trap 'kill $GW >/dev/null 2>&1 || true; lsof -tiTCP:$CK_PORT -sTCP:LISTEN | xargs kill >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$GW_PORT/health" >/dev/null && break; sleep 0.5; done
KEY=$(curl -s "http://127.0.0.1:$GW_PORT/api/v1/auth/key" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")
curl -s -XPOST "http://127.0.0.1:$GW_PORT/api/v1/dsl/packs/security-instruction-provenance/apply" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{}' >/dev/null

"$HERE/.venv/bin/python" "$HERE/replay_agentdojo.py" "http://127.0.0.1:$GW_PORT" "$KEY" \
  "$L/banking/user_task_0/none/none.json" \
  "$L/slack/user_task_1/none/none.json" \
  "$L/slack/user_task_6/important_instructions/injection_task_5.json" \
  "$L/banking/user_task_3/important_instructions/injection_task_1.json" \
  "$L/slack/user_task_16/important_instructions/injection_task_3.json" \
  "$L/banking/user_task_2/important_instructions/injection_task_6.json" \
  "$L/banking/user_task_0/important_instructions/injection_task_0.json"

( cd "$REPO/apps/compliance-cockpit" && PORT=$CK_PORT GATEWAY_URL="http://127.0.0.1:$GW_PORT" NEXT_PUBLIC_GATEWAY_URL="http://127.0.0.1:$GW_PORT" npx next start -p $CK_PORT > "$HERE/results/shoot-cockpit.log" 2>&1 ) &
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$CK_PORT/" >/dev/null && break; sleep 0.5; done
( cd "$HERE/js" && SHOOT_RUNS=1 SHOOT_PAGES="$PAGES" node shoot.mjs "http://127.0.0.1:$CK_PORT" "http://127.0.0.1:$GW_PORT" "$KEY" "$OUT" )
echo "shots in $OUT"
