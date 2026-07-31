#!/bin/sh
# Nightly backup of everything that cannot be rebuilt.
#
#   crontab -e
#   17 3 * * * /opt/toreroflow/infra/backup.sh >> /var/log/toreroflow-backup.log 2>&1
#
# 3:17 rather than 3:00 on purpose: every cron on every VPS fires on the hour,
# and a backup that competes with the rest of the internet's cron jobs for the
# same disk is a slower backup.
#
# What is backed up and what is not:
#
#   the database   yes, it is the whole business and it is small
#   infra/.env     yes, the encryption key is in it and losing that orphans the
#                  bank connection permanently
#   storage/       no, deliberately. It is dominated by source videos that the
#                  retention sweep deletes a week after posting anyway, and the
#                  rendered PDFs can be regenerated from the database. Backing
#                  it up would turn a 15MB nightly into gigabytes.

set -eu

STACK_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${TOREROFLOW_BACKUP_DIR:-/var/backups/toreroflow}"
KEEP_DAYS="${TOREROFLOW_BACKUP_KEEP_DAYS:-14}"
COMPOSE="docker compose -f ${STACK_DIR}/docker-compose.prod.yml"
STAMP="$(date +%Y-%m-%d_%H%M)"

mkdir -p "$BACKUP_DIR"

# --- database -------------------------------------------------------------
# Written to a temporary name and moved into place only on success, so an
# interrupted dump can never be mistaken for a good one by the restore.
DUMP="${BACKUP_DIR}/toreroflow_${STAMP}.sql.gz"
TMP="${DUMP}.partial"

echo "[backup] dumping database"
$COMPOSE exec -T postgres pg_dump -U toreroflow -d toreroflow --clean --if-exists \
  | gzip -9 > "$TMP"

# A dump of an empty or broken database still gzips to something. This is the
# smallest sanity check that catches it: a real dump of this schema is tens of
# kilobytes at minimum.
SIZE=$(wc -c < "$TMP")
if [ "$SIZE" -lt 10000 ]; then
  echo "[backup] FAILED: dump is only ${SIZE} bytes, refusing to keep it"
  rm -f "$TMP"
  exit 1
fi
mv "$TMP" "$DUMP"
echo "[backup] wrote $(basename "$DUMP") (${SIZE} bytes)"

# --- the secrets that cannot be regenerated -------------------------------
# TOKEN_ENCRYPTION_KEY in particular: without it the stored bank credential is
# undecryptable and the connection has to be made again from scratch.
if [ -f "${STACK_DIR}/.env" ]; then
  cp "${STACK_DIR}/.env" "${BACKUP_DIR}/env_${STAMP}"
  chmod 600 "${BACKUP_DIR}/env_${STAMP}"
fi

# --- retention ------------------------------------------------------------
find "$BACKUP_DIR" -name 'toreroflow_*.sql.gz' -mtime "+${KEEP_DAYS}" -delete
find "$BACKUP_DIR" -name 'env_*' -mtime "+${KEEP_DAYS}" -delete

echo "[backup] done, $(find "$BACKUP_DIR" -name 'toreroflow_*.sql.gz' | wc -l) dump(s) kept"

# A backup nobody has ever restored is a hope, not a backup. To test one:
#
#   gunzip -c /var/backups/toreroflow/toreroflow_YYYY-MM-DD_HHMM.sql.gz \
#     | docker compose -f infra/docker-compose.prod.yml exec -T postgres \
#         psql -U toreroflow -d toreroflow
#
# --clean --if-exists means it drops and recreates as it goes, so it restores
# over a live database rather than needing an empty one.
