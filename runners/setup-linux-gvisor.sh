#!/usr/bin/env bash
# Dedicated Ubuntu 24.04 host. Run from this checkout; never from an application container.
set -euo pipefail
test "${1:-}" = --dedicated-runner
test "$(id -u)" = 0
test ! -e /.dockerenv
test ! -e /mnt/mac
test -z "${SSH_AUTH_SOCK:-}"
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
if command -v docker >/dev/null; then
  test -z "$(docker ps -q)"
fi
export DEBIAN_FRONTEND=noninteractive
apt_opts=(-o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
apt-get "${apt_opts[@]}" update
apt-get "${apt_opts[@]}" install -y --no-install-recommends ca-certificates curl gnupg docker.io python3-minimal openssl
# Official signed packages, verified against https://gvisor.dev/docs/user_guide/install/.
curl --fail --silent --show-error --location --max-time 30 https://gvisor.dev/archive.key \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
printf 'deb [arch=%s signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n' \
  "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/gvisor.list
apt-get "${apt_opts[@]}" update
apt-get "${apt_opts[@]}" install -y --no-install-recommends runsc
runsc install --clobber=false --download-sidecars=NEVER --require-sidecars=ALWAYS
systemctl enable --now docker
install -m 600 /dev/null /etc/trialoom-runner-host
TRIALOOM_RUNNER_SETUP=linux bash runners/setup-preview-runtime.sh
# Keep the host's storage driver intact. Pin the downloaded base by digest during the build.
docker pull node:24-bookworm-slim
TRIALOOM_RUNNER_HOST=linux node scripts/check-gvisor-browser.ts
TRIALOOM_RUNNER_HOST=linux node --input-type=module -e 'const {buildPreviewImage}=await import("./scripts/preview-host.ts"); await buildPreviewImage();'
printf '%s\n' 'Sandbox checks passed. Configure /etc/trialoom/runner.env and install the systemd service before accepting jobs.'
