#!/usr/bin/env bash
# HOST-01 step 2, prerequisite. Node 24 on the dedicated Ubuntu 24.04 host, from
# NodeSource's official signed apt repository. Ubuntu 24.04 ships Node 18, which
# runners/setup-linux-gvisor.sh refuses. Run as root on the host:
#   ssh -i ~/.ssh/trialoom_hetzner root@<host> 'bash /opt/trialoom/runners/install-node24.sh'
# The repository is added with its own keyring rather than by piping a remote
# installer into a shell, so what runs is an apt package with a verifiable signature.
set -euo pipefail
test "$(id -u)" = 0
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04

export DEBIAN_FRONTEND=noninteractive
apt_opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
apt-get "${apt_opts[@]}" install -y --no-install-recommends ca-certificates curl gnupg

curl --fail --silent --show-error --location --max-time 60 \
  https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/nodesource.gpg
chmod 644 /usr/share/keyrings/nodesource.gpg
printf 'deb [arch=%s signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\n' \
  "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/nodesource.list
apt-get "${apt_opts[@]}" update
apt-get "${apt_opts[@]}" install -y nodejs

node --version
npm --version
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("node 24 or newer required"); process.exit(1) }'
printf 'node 24 ready\n'
