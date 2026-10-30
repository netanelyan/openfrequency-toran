#!/usr/bin/env bash
# deploy/deploy.sh [<commit or branch, default main>] [--skip-tests]
#
# One Toran deploy, run as root on the VPS (from the release that runs: /opt/toran/current/deploy/deploy.sh):
#
#   1. fetch the repository into /opt/toran/repo.git and export the commit into a new release folder, with REVISION
#   2. npm ci there, run the whole suite (npm run release-check: nothing failed, nothing skipped), then drop the dev
#      dependencies. --skip-tests only for a commit CI already marked green (.github/workflows/test.yml)
#   3. a backup of the database (deploy/toran-backup.sh), checked, then the new build's migrations (scripts/migrate.ts,
#      which refuses without a backup under an hour old): their own step, before any restart. Migrations are additive
#      (expand first, contract in a later deploy), so the build still running keeps working on the new schema
#   4. switch `current` to the new release and restart toran
#   5. wait for /readyz from the new build (database, worker loop) for 60 seconds; if it does not come, roll back to
#      the release before (deploy/rollback.sh), which refuses when the new migrations would leave the old build on a
#      schema it does not know
#   6. keep the last 5 releases
#
# Nothing here runs on a laptop. The layout, and the one-time move to it: docs/deploy.md.
set -euo pipefail
cd "$(dirname "$0")"
source ./common.sh

REF=main
SKIP_TESTS=0
for a in "$@"; do
  case "$a" in
    --skip-tests) SKIP_TESTS=1 ;;
    -*) die "unknown option $a" ;;
    *) REF=$a ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root (it switches releases and restarts the service)"
[ -d "$REPO" ] || die "no $REPO: see docs/deploy.md, Release folders, for the one-time move"
[ -d "$PRIVATE" ] || die "no $PRIVATE"
exec 9>"$LOCK"
flock -n 9 || die "another deploy is running"

say "fetching"
git --git-dir="$REPO" fetch --prune --quiet origin '+refs/heads/*:refs/heads/*'
SHA=$(git --git-dir="$REPO" rev-parse --verify "$REF^{commit}")
SHORT=${SHA:0:12}
NEW=$RELEASES/$SHA
PREV=$(readlink -f "$BASE/current" 2>/dev/null || true)
[ "$PREV" != "$NEW" ] || die "$SHORT is already the release that runs"

if [ ! -f "$NEW/.ready" ]; then
  say "building $SHORT"
  mkdir -p "$RELEASES"
  BUILD=$RELEASES/.build-$SHA
  rm -rf "$BUILD"
  mkdir -p "$BUILD"
  git --git-dir="$REPO" archive "$SHA" | tar -x -C "$BUILD"
  echo "$SHA" > "$BUILD/REVISION"
  if [ "$SKIP_TESTS" = 1 ]; then
    say "npm ci --omit=dev (tests skipped: $SHORT must be green in CI)"
    (cd "$BUILD" && npm ci --omit=dev --no-audit --no-fund)
  else
    say "npm ci, then the whole suite (a few minutes)"
    (cd "$BUILD" && npm ci --no-audit --no-fund)
    (cd "$BUILD" && TORAN_HOME="$(mktemp -d)" npm run --silent release-check -- --tests-only) || die "the tests failed on $SHORT: nothing was changed"
    (cd "$BUILD" && npm prune --omit=dev --no-audit --no-fund)
  fi
  chown -R root:root "$BUILD"
  chmod -R go-w "$BUILD"
  touch "$BUILD/.ready"
  rm -rf "$NEW"
  mv "$BUILD" "$NEW"
fi

say "backup before the migrations"
DUMP=$("$NEW/deploy/toran-backup.sh" "pre-$SHORT" | tail -n 1)
TAKEN=$(date -u +%Y-%m-%dT%H:%M:%SZ)
say "backup: $DUMP"

say "migrations"
as_service "$NEW" TORAN_BACKUP_TAKEN_AT="$TAKEN" "$NODE_BIN/node" scripts/migrate.ts || die "the migrations failed: each is its own transaction, so the database is as the last one that passed left it (the backup before them: $DUMP). The build that runs was not touched"

say "switching to $SHORT and restarting $SERVICE"
switch_to "$NEW"
systemctl restart "$SERVICE"
if ! wait_ready "$SHA"; then
  say "the new build is not ready"
  if [ -n "$PREV" ] && [ -f "$PREV/.ready" ]; then
    "$NEW/deploy/rollback.sh" "$PREV" || say "the rollback was refused or failed: journalctl -u $SERVICE"
  fi
  exit 1
fi
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $SHA deploy" >> "$LOG"

# The newest KEEP releases stay, and always the one that runs and the one before it.
mapfile -t OLD < <(ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | tail -n +"$((KEEP + 1))")
for d in "${OLD[@]}"; do
  if [ "$d" != "$NEW" ] && [ "$d" != "$PREV" ]; then rm -rf "$d"; fi
done
say "deployed $SHORT"
