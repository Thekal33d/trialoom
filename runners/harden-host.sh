#!/usr/bin/env bash
# HOST-01 step 1. Baseline hardening for the dedicated Ubuntu 24.04 host.
# Run as root on the host itself, before any application, database or runner work:
#   ssh -i ~/.ssh/trialoom_hetzner root@<host> 'bash -s' < runners/harden-host.sh
# It is idempotent and makes no application change. It does not install Node,
# Docker or gVisor; runners/setup-linux-gvisor.sh does that in step 2.
set -euo pipefail
test "$(id -u)" = 0
test ! -e /.dockerenv
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04

ADMIN_USER="${ADMIN_USER:-ops}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
HOST_NAME="${HOST_NAME:-trialoom}"

export DEBIAN_FRONTEND=noninteractive
apt_opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
apt-get "${apt_opts[@]}" update
apt-get "${apt_opts[@]}" -y upgrade
apt-get "${apt_opts[@]}" -y install --no-install-recommends \
  ufw unattended-upgrades ca-certificates curl gnupg fail2ban

hostnamectl set-hostname "$HOST_NAME"

# An administrative account, so routine work does not log in as root. It carries
# the same key already authorized for root and has no password, so sudo is
# NOPASSWD: with password authentication disabled this is equivalent to the key
# access that already exists, and it keeps later bootstrap steps non-interactive.
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$ADMIN_USER"
fi
usermod -aG sudo "$ADMIN_USER"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" \
  /root/.ssh/authorized_keys "/home/$ADMIN_USER/.ssh/authorized_keys"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$ADMIN_USER" > "/etc/sudoers.d/90-$ADMIN_USER"
chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"
visudo -c -q

# Keys only. Root keeps key access deliberately, as a recovery path that does not
# depend on the administrative account or on sudo. Local forwarding stays allowed
# so an administrator can reach a loopback-only service, such as PostgreSQL during
# the data move, over SSH instead of exposing its port.
cat > /etc/ssh/sshd_config.d/10-trialoom.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
AllowAgentForwarding no
AllowTcpForwarding local
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
# Ubuntu 24.04 activates sshd through ssh.socket, so the privilege separation
# directory may not exist yet and `sshd -t` would fail on that alone.
install -d -m 0755 /run/sshd
sshd -t
systemctl reload ssh 2>/dev/null || systemctl restart ssh.socket

# The published surface is SSH and the eventual reverse proxy, nothing else.
# Note for later steps: Docker writes its own iptables rules and a published
# container port bypasses this firewall, so runner containers must publish none.
ufw --force disable
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http'
ufw allow 443/tcp comment 'https'
ufw --force enable

systemctl enable --now fail2ban

if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  fallocate -l "$SWAP_SIZE" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
grep -q '^/swapfile' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
printf 'vm.swappiness=10\nvm.vfs_cache_pressure=50\n' > /etc/sysctl.d/99-trialoom.conf
sysctl --quiet --system

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades

printf '\n== hardening applied ==\n'
printf 'hostname: %s\n' "$(hostname)"
printf 'admin user: %s (groups: %s)\n' "$ADMIN_USER" "$(id -nG "$ADMIN_USER")"
sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|allowagentforwarding|allowtcpforwarding|maxauthtries) ' || true
ufw status verbose | head -12
swapon --show
systemctl is-enabled unattended-upgrades fail2ban || true
test -f /var/run/reboot-required && printf 'reboot required: yes\n' || printf 'reboot required: no\n'
