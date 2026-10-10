#!/usr/bin/env bash
# One-time switch from "prisma db push" to real migrations, WITHOUT touching existing data.
#   bash scripts/db-baseline.sh            (run inside apps/api, with .env pointing at the DB)
# After this:  local changes → npx prisma migrate dev --name <change>
#              server deploy → npx prisma migrate deploy   (deploy/deploy.sh does this)
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="0_baseline"
DIR="prisma/migrations/$NAME"

if [ -f "$DIR/migration.sql" ]; then
  echo "Baseline already exists: $DIR"
else
  mkdir -p "$DIR"
  npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script -o "$DIR/migration.sql"
  echo "Created $DIR/migration.sql (full schema). Commit it to git."
fi

echo
echo "Checking what your existing database is missing compared with the schema…"
DRIFT=$(npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script)
if echo "$DRIFT" | grep -qiE "CREATE|ALTER|DROP"; then
  echo "Your database differs from the schema. Review this SQL carefully:"
  echo "------------------------------------------------------------------"
  echo "$DRIFT"
  echo "------------------------------------------------------------------"
  if echo "$DRIFT" | grep -qi "DROP"; then
    echo "It contains DROP statements. NOT applying automatically — back up and review first."
    exit 1
  fi
  read -r -p "Apply these additive changes now? (yes/no) " ok
  [ "$ok" = "yes" ] || { echo "Stopped. Nothing changed."; exit 1; }
  echo "$DRIFT" > /tmp/tacksharp-drift.sql
  npx prisma db execute --file /tmp/tacksharp-drift.sql
fi

npx prisma migrate resolve --applied "$NAME"
npx prisma migrate status
echo "Done. Existing data untouched; future changes use migrations."
