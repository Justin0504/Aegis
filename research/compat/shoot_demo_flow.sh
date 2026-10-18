#!/usr/bin/env bash
# The paper's three demonstration scenarios, run live and photographed.
#   bash shoot_demo_flow.sh [out-dir]
#
# Starts a fresh gateway and Cockpit, then the demo agent from
# demo/live-agent (Claude Haiku, two-line AEGIS integration), and drives
# the agent's own chat page exactly as an attendee would (js/shoot_demo.mjs):
#   S1  a benign database query        → allowed, ~1 ms
#   S2  curl … | sh install             → blocked at L1, refusal in-band
#   S3  kubectl delete pod in prod      → held; this script plays the second
#       attendee: it photographs the Approvals card while the agent is
#       suspended, then presses Allow, and the agent resumes.
# Afterwards it photographs the Cockpit's Activity (the demo session as a
# run), Overview and Violations. Nothing is mocked or edited; the agent's
# model does not emit the S2 call on every turn, and the shooter retries a
# turn that produced no tool call (see shoot_demo.mjs).
set -euo pipefail
# Browsers live inside js/node_modules (installed with PLAYWRIGHT_BROWSERS_PATH=0),
# so a cache clean-up cannot remove them between captures.
export PLAYWRIGHT_BROWSERS_PATH=0
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT=${1:-$REPO/research/paper-arxiv/images/demo}
mkdir -p "$OUT"
DB=$(mktemp -d)/demo.db
GW_PORT=18090; CK_PORT=13004; AG_PORT=18501
PY=$HERE/.venv/bin/python

ANTHROPIC_API_KEY=$(grep -E '^(export )?ANTHROPIC_API_KEY=' "$HOME/.anthropic.env" | head -1 | sed -e 's/^export //' -e 's/^ANTHROPIC_API_KEY=//' -e 's/^"//' -e 's/"$//' | tr -d '\r')
export ANTHROPIC_API_KEY
[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "no ANTHROPIC_API_KEY" >&2; exit 1; }
for p in $GW_PORT $CK_PORT $AG_PORT; do
  lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $p in use" >&2; exit 1; }
done

PORT=$GW_PORT DB_PATH=$DB AEGIS_LICENSE_TIER=enterprise RATE_LIMIT_MAX=1000000 LOG_LEVEL=warn \
  node "$REPO/packages/gateway-mcp/dist/server.js" > "$HERE/results/demo-gateway.log" 2>&1 &
GW=$!
cleanup() { kill $GW >/dev/null 2>&1 || true; for p in $CK_PORT $AG_PORT; do lsof -tiTCP:$p -sTCP:LISTEN | xargs kill >/dev/null 2>&1 || true; done; }
trap cleanup EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$GW_PORT/health" >/dev/null && break; sleep 0.5; done
KEY=$(curl -s "http://127.0.0.1:$GW_PORT/api/v1/auth/key" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")
curl -s -XPOST "http://127.0.0.1:$GW_PORT/api/v1/dsl/packs/security-instruction-provenance/apply" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{}' >/dev/null

( cd "$REPO/apps/compliance-cockpit" && PORT=$CK_PORT GATEWAY_URL="http://127.0.0.1:$GW_PORT" NEXT_PUBLIC_GATEWAY_URL="http://127.0.0.1:$GW_PORT" npx next start -p $CK_PORT > "$HERE/results/demo-cockpit.log" 2>&1 ) &
( cd "$REPO/demo/live-agent" && AEGIS_API_KEY=$KEY "$PY" app.py --port $AG_PORT --gateway "http://127.0.0.1:$GW_PORT" > "$HERE/results/demo-agent.log" 2>&1 ) &
for i in $(seq 1 90); do curl -sf "http://127.0.0.1:$CK_PORT/" >/dev/null && curl -sf "http://127.0.0.1:$AG_PORT/" >/dev/null && break; sleep 1; done

cd "$HERE/js"
node shoot_demo.mjs "http://127.0.0.1:$AG_PORT" "$OUT" S1
node shoot_demo.mjs "http://127.0.0.1:$AG_PORT" "$OUT" S2

# S3: the agent suspends on the hold; the second attendee photographs the
# card and presses Allow. The shooter resets and retries a turn that did
# not produce the call, so keep answering holds until it is done; only the
# first is photographed.
node shoot_demo.mjs "http://127.0.0.1:$AG_PORT" "$OUT" S3 &
S3PID=$!
SHOT=0
while kill -0 $S3PID 2>/dev/null; do
  CHECK=$(curl -s "http://127.0.0.1:$GW_PORT/api/v1/check/pending" -H "x-api-key: $KEY" \
    | python3 -c "import sys,json; c=[x for x in json.load(sys.stdin)['checks'] if 'kubectl' in json.dumps(x.get('arguments'))]; print(c[0]['check_id'] if c else '')" 2>/dev/null || true)
  if [ -n "$CHECK" ]; then
    if [ "$SHOT" = 0 ]; then
      SHOOT_PAGES=/approvals node shoot.mjs "http://127.0.0.1:$CK_PORT" "http://127.0.0.1:$GW_PORT" "$KEY" "$OUT/cockpit-s3"
      mv "$OUT/cockpit-s3/approvals.png" "$OUT/approvals-s3.png"; rmdir "$OUT/cockpit-s3" 2>/dev/null || true
      SHOT=1
    fi
    curl -s -XPATCH "http://127.0.0.1:$GW_PORT/api/v1/check/$CHECK" -H "x-api-key: $KEY" -H 'content-type: application/json' \
      -d '{"decision":"allow","decided_by":"second-attendee"}' >/dev/null
    echo "S3 hold $CHECK allowed"
  fi
  sleep 1
done
wait $S3PID || true
[ "$SHOT" = 1 ] || echo "S3: no kubectl hold appeared" >&2

SHOOT_RUNS=1 SHOOT_PAGES=/traces,/,/violations node shoot.mjs "http://127.0.0.1:$CK_PORT" "http://127.0.0.1:$GW_PORT" "$KEY" "$OUT/cockpit"
echo "demo shots in $OUT"
