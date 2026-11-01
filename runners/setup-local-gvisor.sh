#!/usr/bin/env bash
# Development bootstrap for the dedicated, isolated OrbStack machine only.
# Invoke from macOS with:
# orb -m trialoom-runner -u root -w /root bash -s < runners/setup-local-gvisor.sh
set -euo pipefail
test "$(id -u)" = 0
test "$(hostname)" = trialoom-runner
test ! -e /mnt/mac
test -z "${SSH_AUTH_SOCK:-}"
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04
export DEBIAN_FRONTEND=noninteractive
apt_opts=(-o Acquire::Retries=1 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
apt-get "${apt_opts[@]}" update
apt-get "${apt_opts[@]}" install -y --no-install-recommends ca-certificates curl gnupg docker.io python3-minimal

# Official signed repository from https://gvisor.dev/docs/user_guide/install/.
# Key installation never falls back to an unsigned/insecure repository.
curl --fail --silent --show-error --location --max-time 30 https://gvisor.dev/archive.key \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
printf 'deb [arch=%s signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n' \
  "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/gvisor.list
apt-get "${apt_opts[@]}" update
apt-get "${apt_opts[@]}" install -y --no-install-recommends runsc
runsc install --clobber=false --download-sidecars=NEVER --require-sidecars=ALWAYS
systemctl enable --now docker
# The default nested overlayfs rejected dpkg directory renames in this local
# machine. VFS is a development compatibility choice, not a production default.
# Refuse to hide existing images if called on a previously used overlay store.
python3 - <<'PY'
import json, pathlib, subprocess
driver = subprocess.check_output(['docker', 'info', '--format', '{{.Driver}}'], text=True).strip()
images = subprocess.check_output(['docker', 'image', 'ls', '-q'], text=True).strip()
if driver != 'vfs' and images:
    raise SystemExit('Preserve/migrate the dedicated machine images before changing storage to VFS.')
config = pathlib.Path('/etc/docker/daemon.json')
data = json.loads(config.read_text())
data['storage-driver'] = 'vfs'
data.setdefault('features', {})['containerd-snapshotter'] = False
config.write_text(json.dumps(data, indent=2) + '\n')
PY
systemctl restart docker
runsc --version
docker info --format '{{range $name, $runtime := .Runtimes}}{{$name}} {{end}}'
