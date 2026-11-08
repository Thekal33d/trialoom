#!/usr/bin/env bash
# Runs the worker from a machine that holds the sponsor and settlement keys,
# against the production database over an SSH tunnel.
#
#   bash runners/sponsor-worker.sh            # runs until interrupted
#   SECONDS_TO_RUN=120 bash runners/sponsor-worker.sh
#
# Why a tunnel: the dedicated host is the browser host, and a standing rule
# keeps sponsor and settlement signing keys off it. Production therefore
# prepares reports but can never buy one. This runs the same worker where the
# keys already are, so a real test on the live site produces a real paid call.
#
# The host's PostgreSQL listens on loopback only; `AllowTcpForwarding local`
# was left enabled during hardening for exactly this.
set -euo pipefail
HOST="${HOST:-2.31.104.223}"
KEY="${KEY:-$HOME/.ssh/trialoom_hetzner}"
PORT="${PORT:-55433}"
CREDENTIAL="${CREDENTIAL:-$HOME/.trialoom-host-db.env}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@24/bin/node}"
test -f .env || { echo "Run from the checkout; .env must hold the sponsor key." >&2; exit 1; }
test -x "$NODE_BIN" || { echo "Node 24 not found at $NODE_BIN" >&2; exit 1; }

# The host's database password is fetched once into a private local file and
# never printed. Delete that file to rotate.
if [ ! -f "$CREDENTIAL" ]; then
  umask 077
  ssh -i "$KEY" -o BatchMode=yes "root@$HOST" \
    'grep "^DATABASE_URL_WORKER=" /etc/trialoom/db.env' > "$CREDENTIAL"
  chmod 600 "$CREDENTIAL"
fi
# shellcheck disable=SC1090
set -a; . "$CREDENTIAL"; set +a
test -n "${DATABASE_URL_WORKER:-}" || { echo "No worker URL in $CREDENTIAL" >&2; exit 1; }

ssh -i "$KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -fN -L "127.0.0.1:$PORT:127.0.0.1:5432" "root@$HOST"
tunnel=$(pgrep -f "127.0.0.1:$PORT:127.0.0.1:5432" | head -1)
cleanup() { [ -n "${tunnel:-}" ] && kill "$tunnel" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
printf 'tunnel up on 127.0.0.1:%s\n' "$PORT"

# Point the worker at the tunnel, keeping the host's own credentials intact.
export DATABASE_URL="${DATABASE_URL_WORKER/@127.0.0.1:5432/@127.0.0.1:$PORT}"
if [ -n "${SECONDS_TO_RUN:-}" ]; then
  "$NODE_BIN" --env-file-if-exists=.env --input-type=module -e "
    setTimeout(() => process.exit(0), ${SECONDS_TO_RUN} * 1000);
    await import('./workers/main.ts');
  "
else
  "$NODE_BIN" --env-file-if-exists=.env workers/main.ts
fi
