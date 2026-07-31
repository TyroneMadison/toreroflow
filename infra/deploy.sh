#!/usr/bin/env bash
# One command, from the laptop, to build the server.
#
#   ./infra/deploy.sh 66.94.99.120
#
# Asks for the server's root password exactly once, to install the SSH key.
# Everything after that is key-authenticated and unattended.
#
# Safe to re-run. The key install is skipped once the key works, and the remote
# setup checks every step before it acts, so a run interrupted during the ten
# minute Docker build can just be started again.

set -euo pipefail

SERVER_IP="${1:?usage: deploy.sh SERVER_IP}"
KEY="${HOME}/.ssh/toreroflow"
HERE="$(cd "$(dirname "$0")" && pwd)"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i "$KEY")

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

[ -f "$KEY" ]     || { echo "no SSH key at $KEY; generate one with ssh-keygen -t ed25519 -f $KEY" >&2; exit 1; }
[ -s "$HERE/.env" ] || { echo "infra/.env is missing or empty; it holds the server's secrets" >&2; exit 1; }

say "Checking whether the key is already installed"
if ssh "${SSH_OPTS[@]}" -o BatchMode=yes "root@${SERVER_IP}" true 2>/dev/null; then
  echo "it is, no password needed"
else
  echo "not yet. This is the ONE time you have to type the root password"
  echo "you chose during checkout:"
  echo ""
  ssh-copy-id -i "${KEY}.pub" -o StrictHostKeyChecking=accept-new "root@${SERVER_IP}"
  ssh "${SSH_OPTS[@]}" -o BatchMode=yes "root@${SERVER_IP}" true \
    || { echo "the key still does not work; check the password and try again" >&2; exit 1; }
  echo "key installed"
fi

say "Copying the setup script and the secrets up"
# The secrets go straight to /root rather than into the repo directory, because
# the repo does not exist yet on a first run. remote-setup.sh moves it into
# place once the clone is there.
scp "${SSH_OPTS[@]}" -q "$HERE/remote-setup.sh" "root@${SERVER_IP}:/root/remote-setup.sh"
scp "${SSH_OPTS[@]}" -q "$HERE/.env" "root@${SERVER_IP}:/root/toreroflow.env"
ssh "${SSH_OPTS[@]}" "root@${SERVER_IP}" "chmod 700 /root/remote-setup.sh && chmod 600 /root/toreroflow.env"
echo "copied"

say "Running the build on the server (about ten minutes the first time)"
# -t so the remote output streams here as it happens rather than arriving in
# one lump at the end, which on a ten minute build looks like a hang.
ssh "${SSH_OPTS[@]}" -t "root@${SERVER_IP}" '
  set -e
  # Clone via a temporary directory, then copy in.
  #
  # The obvious order is wrong and fails on the second line: creating
  # /opt/toreroflow/infra first so the secrets have somewhere to land leaves
  # git cloning into a directory that already exists and is not empty, which it
  # refuses to do. Cloning somewhere else and copying works whether the target
  # exists or not, and never deletes anything that might have been there.
  if [ ! -d /opt/toreroflow/.git ]; then
    command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
    rm -rf /tmp/toreroflow-clone
    git clone --quiet https://github.com/TyroneMadison/toreroflow.git /tmp/toreroflow-clone
    mkdir -p /opt/toreroflow
    cp -a /tmp/toreroflow-clone/. /opt/toreroflow/
    rm -rf /tmp/toreroflow-clone
  fi
  mkdir -p /opt/toreroflow/infra
  cp /root/toreroflow.env /opt/toreroflow/infra/.env
  chmod 600 /opt/toreroflow/infra/.env
  /root/remote-setup.sh
'

say "Server is built"
cat <<DONE

  API:     http://${SERVER_IP}:  reachable only through Caddy, which needs DNS
  health:  once api.torerone.com resolves here, https://api.torerone.com/health

Next, and both need a browser login:
  1. Add an A record at Squarespace:  api  ->  ${SERVER_IP}
     Caddy issues the certificate automatically once that resolves.
  2. Move the data up when you are ready:  ./infra/cutover.sh root@${SERVER_IP}
DONE
