#!/bin/sh
# Runs the deploy the API asked for. Lives on the HOST, not in a container.
#
# The API is containerised: no git, no docker, no /opt/toreroflow. It cannot
# rebuild the stack itself and it should not be able to. The obvious shortcut
# is to mount the docker socket into the API container, which works and also
# hands that container root-equivalent control of the host. For a process that
# already holds a bank credential and answers the public internet, that is a
# bad trade.
#
# So the container's only power is to drop a file in a shared directory. This
# watches for it. Worst case if the API were ever compromised: an attacker can
# make the server redeploy the code that is already on the repository's main
# branch, which is what it is running anyway.

set -eu

APP_DIR=/opt/toreroflow
SHARED="$APP_DIR/deploy"
REQUEST="$SHARED/request"
STATE="$SHARED/state.json"

mkdir -p "$SHARED"

while true; do
  if [ -f "$REQUEST" ]; then
    rm -f "$REQUEST"
    echo "[watcher] deploy requested at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    # The state file is written by self-update.sh, which knows how the deploy
    # actually went. The watcher only decides when to start one.
    STATE_FILE="$STATE" sh "$APP_DIR/infra/self-update.sh" || true
    echo "[watcher] finished"
  fi
  sleep 3
done
