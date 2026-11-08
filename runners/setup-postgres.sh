#!/usr/bin/env bash
# HOST-01 step 3. PostgreSQL 18 on the dedicated Ubuntu 24.04 host, loopback only,
# with one owner role and a restricted login role per application process.
# Run as root on the host:
#   ssh -i ~/.ssh/trialoom_hetzner root@<host> 'bash /opt/trialoom/runners/setup-postgres.sh'
# Idempotent. It prints no password: generated credentials are written to
# /etc/trialoom/db.env (0600 root) and the owner URL to /opt/trialoom/.env, both
# outside the repository. The major version matches compose.yaml's postgres:18.
set -euo pipefail
test "$(id -u)" = 0
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04

PG_MAJOR="${PG_MAJOR:-18}"
APP_DIR="${APP_DIR:-/opt/trialoom}"
SECRET_DIR=/etc/trialoom
SECRET_FILE="$SECRET_DIR/db.env"

export DEBIAN_FRONTEND=noninteractive
apt_opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)

if ! command -v psql >/dev/null; then
  curl --fail --silent --show-error --location --max-time 60 \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/postgresql.gpg
  chmod 644 /usr/share/keyrings/postgresql.gpg
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' \
    "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/pgdg.list
  apt-get "${apt_opts[@]}" update
fi
apt-get "${apt_opts[@]}" install -y --no-install-recommends "postgresql-$PG_MAJOR"

# Loopback only. Nothing in this deployment reaches the database over a network,
# and ufw would not protect a port Docker later republished.
conf="/etc/postgresql/$PG_MAJOR/main/conf.d/10-trialoom.conf"
install -d -m 755 "$(dirname "$conf")"
cat > "$conf" <<EOF
listen_addresses = 'localhost'
password_encryption = 'scram-sha-256'
max_connections = 50
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 8MB
maintenance_work_mem = 96MB
random_page_cost = 1.1
log_min_duration_statement = 2000
EOF
systemctl enable --now "postgresql@$PG_MAJOR-main"
systemctl restart "postgresql@$PG_MAJOR-main"

install -d -m 700 "$SECRET_DIR"
if [ ! -f "$SECRET_FILE" ]; then
  owner_pw="$(openssl rand -hex 24)"
  web_pw="$(openssl rand -hex 24)"
  worker_pw="$(openssl rand -hex 24)"
  umask 077
  cat > "$SECRET_FILE" <<EOF
# HOST-01 step 3. Generated on the host; never copied into the repository.
TRIALOOM_DB_OWNER_PASSWORD=$owner_pw
TRIALOOM_DB_WEB_PASSWORD=$web_pw
TRIALOOM_DB_WORKER_PASSWORD=$worker_pw
DATABASE_URL=postgres://trialoom:$owner_pw@127.0.0.1:5432/trialoom
DATABASE_URL_WEB=postgres://trialoom_web:$web_pw@127.0.0.1:5432/trialoom
DATABASE_URL_WORKER=postgres://trialoom_worker:$worker_pw@127.0.0.1:5432/trialoom
DATABASE_URL_DEV=postgres://trialoom:$owner_pw@127.0.0.1:5432/trialoom_dev
EOF
fi
chmod 600 "$SECRET_FILE"
# shellcheck disable=SC1090
set -a; . "$SECRET_FILE"; set +a

# CREATEDB belongs to the owner because the project's checks build disposable
# databases; the two runtime roles get no schema rights of their own. The
# statements go through a private file rather than a command line, so no
# password is ever visible in the process list.
roles_sql="$(mktemp /tmp/trialoom-roles.XXXXXX.sql)"
chmod 600 "$roles_sql"
cat > "$roles_sql" <<EOF
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'trialoom') THEN
    CREATE ROLE trialoom LOGIN CREATEDB PASSWORD '$TRIALOOM_DB_OWNER_PASSWORD';
  ELSE
    ALTER ROLE trialoom LOGIN CREATEDB PASSWORD '$TRIALOOM_DB_OWNER_PASSWORD';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'trialoom_web') THEN
    CREATE ROLE trialoom_web LOGIN PASSWORD '$TRIALOOM_DB_WEB_PASSWORD';
  ELSE
    ALTER ROLE trialoom_web LOGIN PASSWORD '$TRIALOOM_DB_WEB_PASSWORD';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'trialoom_worker') THEN
    CREATE ROLE trialoom_worker LOGIN PASSWORD '$TRIALOOM_DB_WORKER_PASSWORD';
  ELSE
    ALTER ROLE trialoom_worker LOGIN PASSWORD '$TRIALOOM_DB_WORKER_PASSWORD';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE trialoom OWNER trialoom'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'trialoom') \gexec
SELECT 'CREATE DATABASE trialoom_dev OWNER trialoom'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'trialoom_dev') \gexec
EOF
chown postgres:postgres "$roles_sql"
su postgres -c "psql --quiet --no-psqlrc --set=ON_ERROR_STOP=1 --file=$roles_sql"
rm -f "$roles_sql"

for database in trialoom trialoom_dev; do
  su postgres -c "psql --quiet --no-psqlrc --set=ON_ERROR_STOP=1 --dbname=$database" <<EOF
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE $database FROM PUBLIC;
ALTER SCHEMA public OWNER TO trialoom;
GRANT CONNECT ON DATABASE $database TO trialoom_web, trialoom_worker;
GRANT USAGE ON SCHEMA public TO trialoom_web, trialoom_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO trialoom_web, trialoom_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trialoom_web, trialoom_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE trialoom IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO trialoom_web, trialoom_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE trialoom IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO trialoom_web, trialoom_worker;
EOF
done

# The application reads DATABASE_URL from this file. Step 5 replaces it with a
# per-service environment file so the web and worker use their own roles.
umask 077
printf 'DATABASE_URL=%s\n' "$DATABASE_URL" > "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

printf '\n== postgres ready ==\n'
su postgres -c "psql --quiet --no-psqlrc --tuples-only --command \"SELECT version()\"" | head -1
ss -ltnp 2>/dev/null | grep -E '5432' || true
su postgres -c "psql --quiet --no-psqlrc --tuples-only --command \"SELECT rolname, rolcreatedb, rolsuper FROM pg_roles WHERE rolname LIKE 'trialoom%' ORDER BY rolname\""
su postgres -c "psql --quiet --no-psqlrc --tuples-only --command \"SELECT datname FROM pg_database WHERE datname LIKE 'trialoom%' ORDER BY datname\""
