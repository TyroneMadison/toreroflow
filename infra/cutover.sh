#!/usr/bin/env bash
# Move the laptop's database and storage up to the server, once.
#
#   ./infra/cutover.sh root@203.0.113.10
#
# Run this from the repo on the laptop, with the local dev stack running and
# the server stack already up and healthy. It is deliberately not part of the
# deploy: cutting over is a decision, not a step, and after it the laptop's
# database stops being the one that matters.
#
# What it does NOT do: delete anything locally. The local stack is left exactly
# as it was, so if the server turns out to be wrong you change the desktop's
# API address back and carry on as before.

set -euo pipefail

SERVER="${1:?usage: cutover.sh user@host [remote-dir]}"
REMOTE_DIR="${2:-/opt/toreroflow}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y-%m-%d_%H%M)"
DUMP="/tmp/toreroflow_cutover_${STAMP}.sql.gz"

# Local one is a function for the same reason backup.sh's is: a repo path with
# a space in it word-splits and reports itself as an unknown docker command.
# The remote one stays a string because it is sent through ssh as text, and the
# server path is ours to choose and has no spaces in it.
local_compose() { docker compose -f "${HERE}/infra/docker-compose.yml" "$@"; }
REMOTE_COMPOSE="docker compose -f ${REMOTE_DIR}/infra/docker-compose.prod.yml"

echo "==> checking the server is up before touching anything"
ssh "$SERVER" "${REMOTE_COMPOSE} ps --status running --services" | grep -q '^api$' \
  || { echo "the server's api service is not running; bring the stack up first"; exit 1; }

echo "==> dumping the local database"
local_compose exec -T postgres pg_dump -U toreroflow -d toreroflow --clean --if-exists \
  | gzip -9 > "$DUMP"
echo "    $(wc -c < "$DUMP") bytes"

# Restored before the files, because a row pointing at a video that has not
# arrived yet shows an empty thumbnail for a minute. A file with no row is
# invisible forever.
echo "==> restoring it on the server"
gunzip -c "$DUMP" | ssh "$SERVER" "${REMOTE_COMPOSE} exec -T postgres psql -U toreroflow -d toreroflow -q"

echo "==> copying storage"
# The storage volume is inside Docker, so this streams a tar through a
# throwaway container rather than needing a bind mount on either end.
# --numeric-owner keeps the uid/gid the container expects.
tar -C "${HERE}/storage" -cf - . \
  | ssh "$SERVER" "${REMOTE_COMPOSE} exec -T api tar -C /app/storage -xf - --numeric-owner"

echo "==> what landed"
ssh "$SERVER" "${REMOTE_COMPOSE} exec -T postgres psql -U toreroflow -d toreroflow -tAc \
  \"select 'clients: '||count(*) from \\\"Client\\\" union all
     select 'media: '||count(*) from \\\"MediaAsset\\\" union all
     select 'expenses: '||count(*) from \\\"Expense\\\"\""
ssh "$SERVER" "${REMOTE_COMPOSE} exec -T api sh -c 'du -sh /app/storage'"

rm -f "$DUMP"

cat <<'DONE'

==> moved.

Two things left, both on the laptop:

  1. Point the desktop app at the server. In the repo root .env:

       VITE_API_URL=https://toreroflow-server.tail0aa167.ts.net

     then rebuild and reinstall:

       pnpm --filter @toreroflow/desktop tauri build

  2. The bank. If you copied TOKEN_ENCRYPTION_KEY across from the laptop's
     .env, the connection already works and there is nothing to do. If you
     generated a new key for the server, the credential came across encrypted
     with the old one and cannot be read: generate a fresh setup token at
     SimpleFIN and paste it in.

The local stack is untouched. If the server turns out to be wrong, put the old
VITE_API_URL back and nothing was lost.
DONE
