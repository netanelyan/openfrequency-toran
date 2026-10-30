#!/usr/bin/env bash
# deploy/rollback.sh [<release folder or commit>] [--force]
#
# Run an earlier release again: by default the one deploys.log switched to before the one that runs. Root on the VPS.
#
# It first asks whether that build knows every migration the database holds. A database the newer build migrated
# holds one it does not: the older build would run on a schema it does not know (and refuses to start on it,
# src/db/index.ts), so the rollback is refused. The way back is then a forward fix, or the dump deploy.sh took before
# the migrations (docs/restore.md). --force skips the question.
set -euo pipefail
cd "$(dirname "$0")"
source ./common.sh

TARGET=
FORCE=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    -*) die "unknown option $a" ;;
    *) TARGET=$a ;;
  esac
done
[ "$(id -u)" = 0 ] || die "run as root"

CUR=$(readlink -f "$BASE/current" 2>/dev/null || true)
[ -n "$CUR" ] || die "no current release"
if [ -z "$TARGET" ]; then
  CUR_SHA=$(basename "$CUR")
  TARGET=$(awk -v cur="$CUR_SHA" '$2 != cur { last = $2 } END { print last }' "$LOG" 2>/dev/null || true)
  [ -n "$TARGET" ] || die "deploys.log names no release before $CUR_SHA"
fi
[ -d "$TARGET" ] || TARGET=$RELEASES/$TARGET
[ -f "$TARGET/.ready" ] || die "$TARGET is not a built release"
SHA=$(cat "$TARGET/REVISION")
[ "$TARGET" != "$CUR" ] || die "${SHA:0:12} is the release that runs"

if [ "$FORCE" = 0 ]; then
  set +e
  schema_against "$CUR" "$TARGET"
  code=$?
  set -e
  case "$code" in
    0) ;;
    3) die "the database holds migrations ${SHA:0:12} does not know: rolling back would run it on a schema it does not know. Forward-fix, or restore the dump taken before the deploy (docs/restore.md). --force to go anyway" ;;
    2) die "${SHA:0:12} expects migrations the database lacks: deploy it with deploy.sh instead" ;;
    *) die "the schema check failed (exit $code)" ;;
  esac
fi

say "rolling back to ${SHA:0:12}"
switch_to "$TARGET"
systemctl restart "$SERVICE"
wait_ready "$SHA" || die "${SHA:0:12} is not ready either: journalctl -u $SERVICE"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $SHA rollback" >> "$LOG"
say "running ${SHA:0:12}"
