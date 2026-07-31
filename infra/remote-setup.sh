#!/usr/bin/env bash
# The entire server build. Runs ON the server; deploy.sh puts it there.
#
# Idempotent on purpose: every step checks before it acts, so a run that dies
# halfway through a 10 minute Docker build can simply be run again rather than
# needing someone to work out how far it got.

set -euo pipefail

REPO_URL="https://github.com/TyroneMadison/toreroflow.git"
APP_DIR="/opt/toreroflow"
COMPOSE="docker compose -f ${APP_DIR}/infra/docker-compose.prod.yml"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

say "1/7  System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq docker.io docker-compose-v2 git ufw curl
systemctl enable --now docker
docker --version

say "2/7  Firewall"
# The single most important step. Nothing in the compose file publishes a port
# to the internet, and this makes sure nothing else on the box does either.
# SSH only: the API is reached through Tailscale, which needs no inbound port
# because it makes an outbound connection and keeps it open. Ordered so SSH is
# allowed BEFORE the default-deny lands, or this locks itself out.
ufw allow OpenSSH
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
ufw status verbose | head -12

say "3/7  Code"
if [ -d "${APP_DIR}/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" reset --hard --quiet origin/main
  echo "updated to $(git -C "$APP_DIR" rev-parse --short HEAD)"
else
  git clone --quiet "$REPO_URL" "$APP_DIR"
  echo "cloned at $(git -C "$APP_DIR" rev-parse --short HEAD)"
fi

say "4/7  Secrets"
# deploy.sh copied this up before running us. Refuse rather than start a stack
# that would come up with no database password and no encryption key.
if [ ! -s "${APP_DIR}/infra/.env" ]; then
  echo "FAILED: ${APP_DIR}/infra/.env is missing or empty." >&2
  echo "It is copied up by infra/deploy.sh; run that rather than this script directly." >&2
  exit 1
fi
chmod 600 "${APP_DIR}/infra/.env"
echo "present, $(grep -c '^[A-Z]' "${APP_DIR}/infra/.env") values, permissions $(stat -c '%a' "${APP_DIR}/infra/.env")"

say "5/7  Build and start"
# Up to ten minutes the first time: Chromium and ffmpeg are most of it.
$COMPOSE up -d --build

say "6/7  Waiting for the stack to come up"
# The API applies migrations before it reports healthy, so this waits for the
# schema too. Two minutes is generous; a first boot is usually under thirty
# seconds once the images are built.
ok=""
for i in $(seq 1 60); do
  if $COMPOSE ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep -q '^api .*healthy'; then ok=yes; break; fi
  sleep 2
done
$COMPOSE ps
if [ -z "$ok" ]; then
  echo ""
  echo "The API did not report healthy. Its log:" >&2
  $COMPOSE logs api --tail 40 >&2
  exit 1
fi

echo ""
echo "health, from inside the network:"
$COMPOSE exec -T api node -e "fetch('http://127.0.0.1:4700/health').then(r=>r.text()).then(t=>console.log('  '+t))"

say "7/7  Nightly backups"
chmod +x "${APP_DIR}/infra/backup.sh"
CRON_LINE="17 3 * * * ${APP_DIR}/infra/backup.sh >> /var/log/toreroflow-backup.log 2>&1"
# Replace any previous entry rather than stacking a second one on a re-run.
( crontab -l 2>/dev/null | grep -v 'toreroflow/infra/backup.sh' || true; echo "$CRON_LINE" ) | crontab -
echo "scheduled:"
crontab -l | grep backup.sh | sed 's/^/  /'

echo ""
echo "proving the backup works rather than trusting it:"
"${APP_DIR}/infra/backup.sh" 2>&1 | sed 's/^/  /'

say "Done"
cat <<'DONE'
The stack is up and the database is backed up.

Still to do:
  - tailscale funnel, which gives this box its public HTTPS address. No DNS
    record and no certificate to manage: Tailscale issues and renews it.
  - the cutover of the laptop's data, when you decide to commit.
DONE
