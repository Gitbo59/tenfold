#!/usr/bin/env bash
# Runs every test suite against a local copy of the app (no Cloudflare login, no AI spend).
# The AI binding is swapped for a local fake AI server via wrangler.test.jsonc.
cd "$(dirname "$0")/.." || exit 1
FAILED=0
WPID=""; MPID=""

stop_all() {
  [ -n "$WPID" ] && kill -- "-$WPID" 2>/dev/null
  [ -n "$MPID" ] && kill "$MPID" 2>/dev/null
  WPID=""; MPID=""; sleep 2
}
trap stop_all EXIT

start() { # port inspector-port [extra wrangler args]
  local port=$1 insp=$2; shift 2
  node test/mock-ai.mjs >/tmp/tenfold-mock.log 2>&1 & MPID=$!
  local state; state=$(mktemp -d)
  setsid npx wrangler dev -c wrangler.test.jsonc --port "$port" --inspector-port "$insp" --persist-to "$state" "$@" >"/tmp/tenfold-wrangler-$port.log" 2>&1 & WPID=$!
  for _ in $(seq 1 60); do grep -q "Ready on" "/tmp/tenfold-wrangler-$port.log" 2>/dev/null && return 0; sleep 1; done
  echo "wrangler did not start; see /tmp/tenfold-wrangler-$port.log"; exit 1
}

run() { echo; echo "== $1"; shift; "$@" || FAILED=1; }

start 8787 9229; run "Game rules (turns, lives, timers, scoring)" node test/game.test.mjs; stop_all
start 8787 9229; run "Features (hints, reports, difficulty, cache, budget caps)" node test/features.test.mjs; stop_all
start 8787 9229; run "Browser UI (simulated)" node test/ui.test.mjs; stop_all
start 8788 9230 --var IDLE_MINUTES:0.05 --var IDLE_CHECK_SECONDS:1; run "Idle disconnect" node test/idle.test.mjs; stop_all
run "AI module (Workers AI path, providers, parsing)" npx tsx test/ai.test.mts

echo; [ "$FAILED" = 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED"
exit "$FAILED"
