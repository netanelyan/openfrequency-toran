# Shared by deploy/deploy.sh and deploy/rollback.sh (sourced, not run). Root on the VPS.
#
# The layout (docs/deploy.md, "Release folders"):
#   /opt/toran/repo.git        a bare mirror of the repository, fetched by each deploy
#   /opt/toran/releases/<sha>  one folder per build: the code at that commit, its REVISION, its node_modules;
#                              root's, read-only to the service
#   /opt/toran/current         a link to the release that runs (toran.service's WorkingDirectory)
#   /opt/toran/private         the service's own: .env, files, models, logs. Never inside a release
#   /opt/toran/deploys.log     one line per release switched to: "<time> <sha> <deploy|rollback>"

BASE=${TORAN_BASE:-/opt/toran}
REPO=$BASE/repo.git
RELEASES=$BASE/releases
PRIVATE=$BASE/private
LOG=$BASE/deploys.log
SERVICE=${TORAN_SERVICE:-toran}
SERVICE_USER=${TORAN_USER:-toran}
URL=${TORAN_URL:-http://127.0.0.1:4710}
NODE_BIN=${TORAN_NODE_BIN:-/opt/node24/bin}
KEEP=${TORAN_KEEP_RELEASES:-5}
LOCK=${TORAN_DEPLOY_LOCK:-/run/toran-deploy.lock}
export PATH="$NODE_BIN:$PATH"

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { say "STOP: $*" >&2; exit 1; }

# A command as the service's user, from a release folder, with the service's private folder and settings.
as_service() {
  local dir=$1
  shift
  (cd "$dir" && runuser -u "$SERVICE_USER" -- env TORAN_HOME="$PRIVATE" TORAN_ENV=prod NODE_ENV=production "$@")
}

# The migrations a release knows, against the database: 0 the same, 2 the database lacks some, 3 it holds one the
# release does not know. Run with the current release's script, which may be newer than the release checked.
schema_against() {
  local checker=$1 release=$2
  as_service "$checker" "$NODE_BIN/node" scripts/migrate.ts --files "$release/src/db/migrations"
}

# Point `current` at a release, atomically.
switch_to() {
  ln -sfn "$1" "$BASE/current.next"
  mv -Tf "$BASE/current.next" "$BASE/current"
}

# Wait up to 60 seconds for /readyz to say the database answers and a worker loop runs, from the build `sha`. A queue
# still late from the restart does not fail a deploy: that is not the build's fault. A build from before /readyz
# (a rollback to one) can only say /healthz "ok".
wait_ready() {
  local sha=$1 i=0 body=
  while [ "$i" -lt 30 ]; do
    body=$(curl -s --max-time 3 "$URL/readyz" || true)
    case "$body" in
      *'"db":true,"worker":true'*"\"revision\":\"$sha\""*)
        say "ready: $body"
        return 0
        ;;
      *'"revision"'*) ;;
      *)
        if [ ! -f "$RELEASES/$sha/src/health.ts" ] && [ "$(curl -s --max-time 3 "$URL/healthz" || true)" = ok ]; then
          say "up (a build from before /readyz: /healthz only)"
          return 0
        fi
        ;;
    esac
    sleep 2
    i=$((i + 1))
  done
  say "not ready after 60 s: ${body:-no answer}"
  return 1
}
