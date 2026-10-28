#!/usr/bin/env bash
# Read-only smoke test of a deployed Tacksharp API (+ optional web), for staging and production.
# Sends NO WhatsApp message, places NO call, writes NO data. Never prints secrets.
#
#   API=https://platform-api.tacksharp.in WEB=https://platform.tacksharp.in EXPECT_RELEASE=<short sha> \
#   bash apps/api/scripts/smoke-deploy.sh
#
# Optional login check (credentials from the environment, never on the command line or in history):
#   read -rs SMOKE_PASSWORD; export SMOKE_EMAIL=you@example.com SMOKE_PASSWORD
set -uo pipefail
API="${API:?set API=https://<api host>}"
WEB="${WEB:-}"
pass=0; fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1${2:+  — $2}"; fail=$((fail+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

# 1. Health + release
h=$(curl -s --max-time 15 "$API/health" || true)
echo "$h" | grep -q '"status":"ok"' && ok "health ok" || bad "health" "$(echo "$h" | head -c 160)"
rel=$(echo "$h" | sed -n 's/.*"release":{"id":"\{0,1\}\([^",}]*\).*/\1/p')
if [ -n "${EXPECT_RELEASE:-}" ]; then [ "$rel" = "$EXPECT_RELEASE" ] && ok "release.id = $rel" || bad "release.id" "got '${rel:-none}', expected $EXPECT_RELEASE"; else echo "INFO  release.id = ${rel:-none}"; fi
echo "$h" | grep -q '"dryRun":true' && echo "INFO  DRY_RUN is on (nothing is sent)" || echo "INFO  DRY_RUN is OFF on this server"
echo "$h" | grep -q '"database":{"ok":true' && ok "database ok" || bad "database"
echo "$h" | grep -q '"redis":{"ok":true' && ok "redis ok" || bad "redis"

# 2. Authentication required
[ "$(code "$API/customers")" = "401" ] && ok "API refuses unauthenticated requests (401)" || bad "unauthenticated /customers not 401"
[ "$(code "$API/team")" = "401" ] && ok "team API refuses unauthenticated requests (401)" || bad "unauthenticated /team not 401"
[ "$(code -X POST -H 'content-type: application/json' -d '{"token":"x"}' "$API/team/links/inspect")" = "400" ] && ok "bogus invitation token refused (400)" || bad "bogus invitation token not refused"

# 3. WhatsApp webhook verification + signature
[ "$(code "$API/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-$RANDOM&hub.challenge=123")" = "403" ] && ok "WhatsApp verify with a wrong token refused (403)" || bad "WhatsApp verify token check"
body='{"object":"whatsapp_business_account","entry":[]}'
c=$(code -X POST -H 'content-type: application/json' -d "$body" "$API/webhooks/whatsapp")
[ "$c" = "401" ] && ok "unsigned WhatsApp webhook refused (401: META_APP_SECRET enforced)" || bad "unsigned WhatsApp webhook" "HTTP $c (200 means signatures are NOT verified)"
c=$(code -X POST -H 'content-type: application/json' -H 'x-hub-signature-256: sha256=00' -d "$body" "$API/webhooks/whatsapp")
[ "$c" = "401" ] && ok "badly signed WhatsApp webhook refused (401)" || bad "badly signed WhatsApp webhook" "HTTP $c"

# 4. Plivo signature (no call is created: rejected before any processing)
c=$(code -X POST -d 'CallUUID=smoke-test&From=910000000000&To=910000000001' "$API/voice/answer")
[ "$c" = "403" ] && ok "unsigned Plivo callback refused (403: PLIVO_VALIDATE_SIGNATURE enforced)" || bad "unsigned Plivo callback" "HTTP $c (not 403 means Plivo signatures are NOT verified)"

# 5. Web
if [ -n "$WEB" ]; then
  [ "$(code "$WEB/login")" = "200" ] && ok "web /login 200" || bad "web /login"
  wr=$(curl -s --max-time 15 "$WEB/login" | grep -o 'tacksharp-release" content="[^"]*' | sed 's/.*content="//' | head -1)
  if [ -n "${EXPECT_RELEASE:-}" ]; then [ "$wr" = "$EXPECT_RELEASE" ] && ok "web release = $wr" || bad "web release" "got '${wr:-none}'"; else echo "INFO  web release = ${wr:-none}"; fi
  [ "$(code "$WEB/invite")" = "200" ] && ok "web /invite 200" || bad "web /invite"
fi

# 6. Optional: login, workspaces, tenant scoping
if [ -n "${SMOKE_EMAIL:-}" ] && [ -n "${SMOKE_PASSWORD:-}" ]; then
  jar=$(mktemp); trap 'rm -f "$jar"' EXIT
  c=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -H 'content-type: application/json' --data-binary @- "$API/auth/login" <<EOF
{"email":"$SMOKE_EMAIL","password":"$SMOKE_PASSWORD"}
EOF
)
  [ "$c" = "200" ] || [ "$c" = "201" ] && ok "login" || bad "login" "HTTP $c"
  ws=$(curl -s -b "$jar" "$API/auth/workspaces")
  n=$(echo "$ws" | grep -o '"organizationId"' | wc -l); echo "INFO  workspaces visible to this account: $n"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -H 'content-type: application/json' -d '{"organizationId":"org_does_not_exist"}' "$API/auth/workspace")" = "403" ] && ok "switching to a workspace you do not belong to is refused (403)" || bad "unauthorized workspace switch not refused"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$API/industry/workspace")" = "200" ] && ok "current workspace loads" || bad "current workspace"
fi

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
