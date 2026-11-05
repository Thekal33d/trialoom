#!/bin/sh
# Never serve as root, and never accept evidence writes that silently vanish.
#
# Railway mounts volumes as root and documents RAILWAY_RUN_UID=0 for images
# that run as a non-root user. Taken literally that makes the internet-facing
# process root for the sake of one directory. This script accepts the
# privilege, fixes the mount point, then re-executes itself unprivileged, so
# the application itself never runs as root on any host.
set -eu

uid=1000
gid=1000
dir="${TRIALOOM_EVIDENCE_DIR:-}"
storage=local
if [ -n "${TRIALOOM_S3_ENDPOINT:-}${TRIALOOM_S3_BUCKET:-}${TRIALOOM_S3_ACCESS_KEY_ID:-}${TRIALOOM_S3_SECRET_ACCESS_KEY:-}" ]; then
  if [ -z "${TRIALOOM_S3_ENDPOINT:-}" ] || [ -z "${TRIALOOM_S3_BUCKET:-}" ] || [ -z "${TRIALOOM_S3_ACCESS_KEY_ID:-}" ] || [ -z "${TRIALOOM_S3_SECRET_ACCESS_KEY:-}" ]; then
    echo '{"event":"container.evidence_incomplete","detail":"Configure every required S3 setting before starting shared storage"}' >&2
    exit 1
  fi
  storage=s3
  dir=
fi

if [ "$(id -u)" = 0 ]; then
  if [ -n "$dir" ]; then
    mkdir -p "$dir"
    chown "$uid:$gid" "$dir"
    chmod 700 "$dir"
  fi
  echo '{"event":"container.dropping_privileges","to":"1000:1000"}'
  # Re-exec this script, not the command, so the checks below run as the
  # unprivileged user that will actually do the writing.
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all -- "$0" "$@"
fi

if [ -n "$dir" ]; then
  mkdir -p "$dir" 2>/dev/null || true
  # `touch`, not a shell redirection: a redirection failure on a special
  # builtin kills a POSIX shell outright, which loses the message below and
  # reports a status nobody can interpret.
  if ! touch "$dir/.writable" 2>/dev/null; then
    # Failing here is the point. Discovering it on the first stored artifact
    # would lose private evidence that cannot be regenerated.
    echo '{"event":"container.evidence_unwritable","detail":"TRIALOOM_EVIDENCE_DIR is set but this process cannot write to it"}' >&2
    exit 1
  fi
  rm -f "$dir/.writable"
elif [ "$storage" = s3 ]; then
  echo '{"event":"container.evidence_shared","detail":"Private S3-compatible storage is configured; connectivity is checked when evidence is stored or read"}'
else
  # Said out loud rather than looking like a working private store.
  echo '{"event":"container.evidence_ephemeral","detail":"TRIALOOM_EVIDENCE_DIR is unset, so stored artifacts live in the container filesystem and are lost on redeploy"}'
fi

exec "$@"
