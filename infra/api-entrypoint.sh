#!/bin/sh
set -e

# Migrations run here, before the API accepts a request.
#
# Not as a separate step in the runbook, because the failure mode of forgetting
# is an app that starts fine and then throws column-does-not-exist at whichever
# screen touches the new table, which reads like a bug rather than a missed
# command. `migrate deploy` only applies what is pending and is a no-op when
# there is nothing to do, so it is safe on every boot.
#
# This is sound because exactly one API container runs. Two would race, and
# then this belongs in a one-shot job instead.
echo "[api] applying database migrations"
pnpm --filter @toreroflow/db exec prisma migrate deploy

echo "[api] starting"
exec pnpm --filter @toreroflow/api start
