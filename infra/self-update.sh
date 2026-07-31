#!/bin/sh
# Pull main and rebuild. Started detached by the API's /deploy endpoint, and it
# outlives the process that started it because restarting that process is part
# of the job.

set -eu

APP_DIR=/opt/toreroflow
STATE=/tmp/toreroflow-deploy.json
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
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

trap - EXIT INT TERM
finish failed "The API did not come back healthy within three minutes. Check: docker compose -f $COMPOSE logs api"
exit 1
