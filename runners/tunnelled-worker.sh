#!/usr/bin/env bash
# Entry point for the worker when it runs away from the database — today, on
# Railway. It opens an SSH tunnel to the dedicated host's loopback-only
# PostgreSQL and then runs the ordinary worker against it.
#
# Why this exists: the dedicated host executes untrusted browser workloads, so
# it must not hold a signing key. Running the worker somewhere that holds no
# untrusted code keeps the key off that machine while still being always on,
# which a laptop is not.
#
# The SSH key is accepted only for forwarding to 5432: it is installed on the
# host with restrict, no-pty and permitopen="127.0.0.1:5432", so a stolen copy
# is a database connection and not a shell. Verified 2026-11-08 — forwarding to
# port 22 through it is reset by the server.
#
# Required: TUNNEL_SSH_KEY, TUNNEL_HOST, DATABASE_URL (pointing at 127.0.0.1
# and the local port below), plus whatever keys the worker itself needs.
set -euo pipefail
: "${TUNNEL_SSH_KEY:?Set TUNNEL_SSH_KEY to the private key, newlines included}"
: "${TUNNEL_HOST:?Set TUNNEL_HOST to the database host}"
: "${DATABASE_URL:?Set DATABASE_URL to reach 127.0.0.1 through the tunnel}"
TUNNEL_USER="${TUNNEL_USER:-tunnel}"
LOCAL_PORT="${LOCAL_PORT:-55432}"

key="$(mktemp)"
chmod 600 "$key"
printf '%s\n' "$TUNNEL_SSH_KEY" > "$key"
trap 'rm -f "$key"' EXIT

ssh-keyscan -T 10 -t ed25519 "$TUNNEL_HOST" > /tmp/known_hosts 2>/dev/null
# Autossh is not installed: a tunnel that dies takes the process with it, and
# the platform restarts the service. That is simpler than supervising it here
# and it fails loudly rather than running without a database.
ssh -i "$key" -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -o UserKnownHostsFile=/tmp/known_hosts -o StrictHostKeyChecking=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -N -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:5432" "$TUNNEL_USER@$TUNNEL_HOST" &
tunnel=$!
trap 'kill "$tunnel" 2>/dev/null; rm -f "$key"' EXIT INT TERM

for _ in $(seq 1 30); do
  if node -e "require('node:net').connect($LOCAL_PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 1
done
printf '{"event":"tunnel.ready","port":%s}\n' "$LOCAL_PORT"

node workers/main.ts &
worker=$!
# If either half stops, stop the service so the platform restarts both.
wait -n "$tunnel" "$worker"
kill "$tunnel" "$worker" 2>/dev/null || true
exit 1
