#!/bin/sh
# Pull main and rebuild. Started detached by the API's /deploy endpoint, and it
# outlives the process that started it because restarting that process is part
# of the job.

set -eu

APP_DIR=/opt/toreroflow
# Overridable so the watcher can put it in the directory shared with the API.
STATE="${STATE_FILE:-/opt/toreroflow/deploy/state.json}"
COMPOSE="$APP_DIR/infra/docker-compose.prod.yml"

FROM="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

finish() {
  # $1 status, $2 message. Written last thing so the status endpoint never
  # shows "success" for a build that is still going.
  cat > "$STATE" <<JSON
{"status":"$1","startedAt":"$STARTED","finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "fromCommit":"$FROM","toCommit":"$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)",
 "message":"$2"}
JSON
}

trap 'finish failed "The deploy stopped partway. The previous version is still running."' EXIT INT TERM

cd "$APP_DIR"
git fetch --quiet origin
git reset --hard --quiet origin/main

# --build because the point is to run the new code. Compose recreates only the
# containers whose image actually changed, so a docs-only commit is quick.
GIT_COMMIT="$(git -C "$APP_DIR" rev-parse --short HEAD)"
export GIT_COMMIT
docker compose -f "$COMPOSE" up -d --build --remove-orphans

# Wait for the API to come back before calling it a success, or the operator
# gets a green tick for a container that is crash-looping.
i=0
while [ "$i" -lt 90 ]; do
  if docker compose -f "$COMPOSE" ps --format '{{.Service}} {{.Status}}' | grep -q '^api .*healthy'; then
    trap - EXIT INT TERM
    finish success "Updated to $(git -C "$APP_DIR" rev-parse --short HEAD)."

    # Take out the rubbish, but only now.
    #
    # Every build retags api and worker, which leaves the previous 2.7GB pair
    # untagged and on disk forever. Six deploys of that outweigh everything the
    # app actually stores, and the app's own files are 438MB.
    #
    # After the health check, never before: while the new containers are still
    # proving themselves the old images are the way back.
    #
    # Some build cache is kept because dropping all of it makes the next deploy
    # a ten minute rebuild rather than a one minute one. Failures here are
    # ignored: a full disk is a problem, a deploy reported as failed because
    # housekeeping tripped is a worse one.
    docker image prune -f >/dev/null 2>&1 || true
    docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || true
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

trap - EXIT INT TERM
finish failed "The API did not come back healthy within three minutes. Check: docker compose -f $COMPOSE logs api"
exit 1
