#!/usr/bin/env bash
# HOST-01 step 5. systemd units for the web process and the payment worker, each
# as its own unprivileged user with its own restricted database role, behind a
# reverse proxy. Run as root on the host:
#   ssh -i ~/.ssh/trialoom_hetzner root@<host> 'bash /opt/trialoom/runners/setup-services.sh'
#
# Pre-cutover on purpose: the proxy listens on 127.0.0.1:8080 only, so nothing is
# publicly reachable while trialoom.xyz still points at the old deployment. Step 8
# replaces that block with the real hostname, and Caddy then obtains the
# certificate automatically once DNS resolves here.
#
# Idempotent. It prints no secret. Generated values go to /etc/trialoom/*.env,
# mode 0600 root; systemd reads them before dropping privileges, so the service
# users never need read access to the file.
set -euo pipefail
test "$(id -u)" = 0
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04

APP_DIR="${APP_DIR:-/opt/trialoom}"
SECRET_DIR=/etc/trialoom
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://trialoom.xyz}"
test -f "$SECRET_DIR/db.env"
test -f "$SECRET_DIR/s3.env"

export DEBIAN_FRONTEND=noninteractive
apt_opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
if ! command -v caddy >/dev/null; then
  curl --fail --silent --show-error --location --max-time 60 \
    https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable.gpg
  chmod 644 /usr/share/keyrings/caddy-stable.gpg
  printf 'deb [signed-by=/usr/share/keyrings/caddy-stable.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get "${apt_opts[@]}" update
  apt-get "${apt_opts[@]}" install -y caddy
fi

for service in web worker; do
  user="trialoom-$service"
  if ! id "$user" >/dev/null 2>&1; then
    adduser --system --group --no-create-home --home "/var/lib/$user" --shell /usr/sbin/nologin "$user"
  fi
  install -d -m 700 -o "$user" -g "$user" "/var/lib/$user"
done
# next.config.ts sets output: 'standalone', so `next start` is the wrong
# entrypoint and serves a build whose server actions the browser cannot resolve.
# Assemble the layout the Dockerfile uses and run server.js from it.
RUN_DIR="$APP_DIR/.next/standalone"
test -f "$RUN_DIR/server.js"
install -d -m 755 "$RUN_DIR/.next"
cp -a "$APP_DIR/.next/static" "$RUN_DIR/.next/static.new"
rm -rf "$RUN_DIR/.next/static" && mv "$RUN_DIR/.next/static.new" "$RUN_DIR/.next/static"
cp -a "$APP_DIR/public" "$RUN_DIR/public.new"
rm -rf "$RUN_DIR/public" && mv "$RUN_DIR/public.new" "$RUN_DIR/public"
install -d -m 755 -o trialoom-web -g trialoom-web "$RUN_DIR/.next/cache"

set -a; . "$SECRET_DIR/db.env"; set +a

shared="$SECRET_DIR/shared.env"
if [ ! -f "$shared" ]; then
  umask 077
  cat > "$shared" <<EOF
# HOST-01 step 5. Generated on the host; never copied into the repository.
BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
TRIALOOM_RUNNER_DISPATCH_KEY=$(openssl rand -hex 32)
EOF
fi
chmod 600 "$shared"
set -a; . "$shared"; set +a
set -a; . "$SECRET_DIR/s3.env"; set +a

umask 077
# The web process is the only one reachable from outside and holds no signing key.
cat > "$SECRET_DIR/web.env" <<EOF
NODE_ENV=production
PORT=3000
HOSTNAME=127.0.0.1
DATABASE_URL=$DATABASE_URL_WEB
BETTER_AUTH_URL=$PUBLIC_ORIGIN
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
TRIALOOM_URL=$PUBLIC_ORIGIN
TRIALOOM_WALLET_LOGIN=true
TRIALOOM_PUBLIC_WALLET_SIGNUP=true
# The websites and free-checks surface only renders when this is true.
TRIALOOM_FREE_TESTS=true
TRIALOOM_S3_ENDPOINT=$TRIALOOM_S3_ENDPOINT
TRIALOOM_S3_BUCKET=$TRIALOOM_S3_BUCKET
TRIALOOM_S3_REGION=$TRIALOOM_S3_REGION
TRIALOOM_S3_ACCESS_KEY_ID=$TRIALOOM_S3_ACCESS_KEY_ID
TRIALOOM_S3_SECRET_ACCESS_KEY=$TRIALOOM_S3_SECRET_ACCESS_KEY
TRIALOOM_RUNNER_DISPATCH_KEY=$TRIALOOM_RUNNER_DISPATCH_KEY
TRIALOOM_RUNNER_API_ORIGIN=$PUBLIC_ORIGIN
EOF
# The payment worker reaches the database and, later, a signing key. It is never
# reachable from the internet and never shares a process with a browser.
cat > "$SECRET_DIR/worker.env" <<EOF
NODE_ENV=production
DATABASE_URL=$DATABASE_URL_WORKER
BETTER_AUTH_URL=$PUBLIC_ORIGIN
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
TRIALOOM_URL=$PUBLIC_ORIGIN
TRIALOOM_S3_ENDPOINT=$TRIALOOM_S3_ENDPOINT
TRIALOOM_S3_BUCKET=$TRIALOOM_S3_BUCKET
TRIALOOM_S3_REGION=$TRIALOOM_S3_REGION
TRIALOOM_S3_ACCESS_KEY_ID=$TRIALOOM_S3_ACCESS_KEY_ID
TRIALOOM_S3_SECRET_ACCESS_KEY=$TRIALOOM_S3_SECRET_ACCESS_KEY
EOF
chmod 600 "$SECRET_DIR/web.env" "$SECRET_DIR/worker.env"

cat > /etc/systemd/system/trialoom-web.service <<EOF
[Unit]
Description=Trialoom web
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=trialoom-web
Group=trialoom-web
WorkingDirectory=$RUN_DIR
EnvironmentFile=$SECRET_DIR/web.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
ReadWritePaths=$RUN_DIR/.next/cache /var/lib/trialoom-web
# No signing key and no Docker socket. The browser controller is a separate unit.

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/trialoom-worker.service <<EOF
[Unit]
Description=Trialoom payment and job worker
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=trialoom-worker
Group=trialoom-worker
WorkingDirectory=$APP_DIR
EnvironmentFile=$SECRET_DIR/worker.env
ExecStart=/usr/bin/node workers/main.ts
Restart=on-failure
RestartSec=10
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
ReadWritePaths=/var/lib/trialoom-worker

[Install]
WantedBy=multi-user.target
EOF

# Loopback only until the cutover, and only when there is nothing to preserve.
# Re-running this script after the cutover must never put the live site back
# behind loopback: that is an outage, not a reset.
if [ -f /etc/caddy/Caddyfile ] && ! grep -q '^http://127\.0\.0\.1:8080 {' /etc/caddy/Caddyfile; then
  printf 'Keeping the existing /etc/caddy/Caddyfile; it is not the pre-cutover loopback config.\n'
else
  cat > /etc/caddy/Caddyfile <<'EOF'
{
	admin off
}

http://127.0.0.1:8080 {
	# Caddy matches the site address by Host header but would still listen on
	# every interface, so bind the socket itself. The firewall is not the only
	# thing keeping an unfinished deployment off the internet.
	bind 127.0.0.1
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
fi
caddy validate --config /etc/caddy/Caddyfile >/dev/null
# `admin off` closes the API that `caddy reload` and `systemctl reload caddy`
# use, so changing this file later needs a restart, not a reload.

# The owner URL used for migrations must not stay where a service could read it.
rm -f "$APP_DIR/.env"

systemctl daemon-reload
systemctl enable trialoom-web trialoom-worker
# Restart rather than `enable --now`: on a re-run after a rebuild the services
# are already up, and `--now` would leave them serving the previous build.
systemctl restart trialoom-web trialoom-worker
systemctl restart caddy
systemctl enable caddy

printf '\n== services ==\n'
systemctl is-active trialoom-web trialoom-worker caddy postgresql@18-main || true
ps -o user:16,args -C node --no-headers | cut -c1-110 || true
