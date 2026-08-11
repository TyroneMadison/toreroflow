#!/bin/sh
# Sends one test reminder email, to prove the Resend key, the verified domain
# and the from-address all work before a client ever waits on one.
#   ./check-reminder-email.sh you@example.com
set -eu
[ $# -eq 1 ] || { echo "usage: $0 recipient@example.com"; exit 2; }
ENVF=/opt/toreroflow/infra/.env
KEY=$(grep -E "^RESEND_API_KEY=" "$ENVF" | cut -d= -f2- | tr -d "\r")
FROM=$(grep -E "^REMINDER_FROM=" "$ENVF" | cut -d= -f2- | tr -d "\r")
case "$FROM" in *"<"*) ;; *) FROM="Torerone <$FROM>" ;; esac
[ -n "$KEY" ] || { echo "RESEND_API_KEY is not set in $ENVF"; exit 1; }
echo "from: $FROM"
echo "to:   $1"
code=$(curl -s -o /tmp/rsend.json -w "%{http_code}" -m 30 -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  --data "{\"from\":\"$FROM\",\"to\":[\"$1\"],\"subject\":\"Toreroflow reminder test\",\"html\":\"<p>If you can read this, reminder emails work.</p>\"}")
echo "http $code"
cat /tmp/rsend.json; echo
rm -f /tmp/rsend.json
[ "$code" = "200" ] && echo "OK: delivery is configured" || echo "NOT working, see the message above"
