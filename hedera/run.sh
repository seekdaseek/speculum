#!/bin/bash
# speculum — one command to run a real paid check on Hedera
#
#   ./hedera/run.sh
#
# Starts the service, waits for it, runs the paying agent against it, then
# shuts the service down. The private key is read at a prompt and lives only in
# this shell, never in an argument and never in history.

set -u
cd "$(dirname "$0")/.." || exit 1

PORT="${PORT:-4021}"
# BSD and GNU mktemp disagree about -t, so give an explicit template that both accept.
LOG=$(mktemp "${TMPDIR:-/tmp}/speculum-service.XXXXXX")

cleanup() {
  if [ -n "${SRV_PID:-}" ] && kill -0 "$SRV_PID" 2>/dev/null; then
    kill "$SRV_PID" 2>/dev/null
    wait "$SRV_PID" 2>/dev/null
  fi
  unset AGENT_KEY
}
trap cleanup EXIT INT TERM

printf 'service account id (receives payment, e.g. 0.0.12345): '
read -r SERVICE_ID
printf 'agent account id   (pays,   e.g. 0.0.10386821):        '
read -r AGENT_ID
printf 'agent private key  (hidden, ECDSA hex):                '
read -rs AGENT_KEY
echo

if [ -z "$SERVICE_ID" ] || [ -z "$AGENT_ID" ] || [ -z "$AGENT_KEY" ]; then
  echo "all three are required"
  exit 1
fi
if [ "$SERVICE_ID" = "$AGENT_ID" ]; then
  echo "the payer and the recipient must differ, or the transfer nets to nothing"
  exit 1
fi

echo
echo "starting the service on port $PORT"
HEDERA_ACCOUNT_ID="$SERVICE_ID" PORT="$PORT" node hedera/server.js > "$LOG" 2>&1 &
SRV_PID=$!

# Wait for it to actually answer rather than sleeping a guessed number of
# seconds. If it died on startup, say so and show why.
for i in $(seq 1 25); do
  if curl -fs --max-time 2 "http://localhost:$PORT/" > /dev/null 2>&1; then
    echo "service is up"
    break
  fi
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "the service exited before it was ready:"
    cat "$LOG"
    exit 1
  fi
  sleep 0.4
  if [ "$i" = 25 ]; then
    echo "the service did not answer within 10s:"
    cat "$LOG"
    exit 1
  fi
done

echo
echo "════════════════════════════════════════════════════════════"
SERVICE="http://localhost:$PORT" \
HEDERA_ACCOUNT_ID="$AGENT_ID" \
HEDERA_PRIVATE_KEY="$AGENT_KEY" \
  node hedera/agent.js
STATUS=$?
echo "════════════════════════════════════════════════════════════"

if [ "$STATUS" != 0 ]; then
  echo
  echo "the agent exited $STATUS. service log:"
  cat "$LOG"
fi

exit "$STATUS"
