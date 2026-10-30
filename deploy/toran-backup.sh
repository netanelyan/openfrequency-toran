#!/bin/sh
# Toran's backup: its Postgres (the docker container toran-db-1) as one pg_dump in the custom format, checked before it
# counts, and the customers' files (private/files, outside the database) beside it. Run as root: nightly by
# toran-backup.timer, and by deploy/deploy.sh before every migration (with a label, and without the files).
#
#   toran-backup.sh [<label>]          prints the dump's path on its last line
#
# Kept TORAN_BACKUP_KEEP_DAYS days (14) in TORAN_BACKUP_DIR (/var/backups/toran, mode 700). A dump counts only when
# pg_restore can list it and the list holds the main tables' data; anything less fails this script, so the service
# fails and its OnFailure alert goes out. Restoring one: docs/restore.md. Copying them off this machine is the
# server's off-site job, not this one.
#
# Installed as /usr/local/bin/toran-backup (docs/deploy.md); the timer's unit is deploy/toran-backup.service.
#
# It replaces the script installed there on 2026-10-29, which wrote `pg_dump --no-owner | gzip` as
# toran-YYYYMMDD-HHMM.sql.gz (plain SQL, unchecked). Those copies stay where they are, are pruned by the same 14 days,
# and restore with gunzip and psql (docs/restore.md covers both formats). private/files does not exist until a
# customer's first file: a missing folder is skipped.
set -eu

DIR=${TORAN_BACKUP_DIR:-/var/backups/toran}
CONTAINER=${TORAN_DB_CONTAINER:-toran-db-1}
FILES=${TORAN_FILES_DIR:-/opt/toran/private/files}
KEEP_DAYS=${TORAN_BACKUP_KEEP_DAYS:-14}
LABEL=${1:-}

case "$LABEL" in
  *[!A-Za-z0-9._-]*) echo "toran-backup: a label is letters, digits, dots, dashes and underscores" >&2; exit 2 ;;
esac

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/toran-$STAMP${LABEL:+-$LABEL}.dump"

# The dump: plain redirects, no pipe, so a failed pg_dump fails this script (sh has no pipefail).
docker exec "$CONTAINER" pg_dump -U toran -d toran -Fc --no-owner > "$OUT.part"

# The check: pg_restore reads the whole archive's table of contents, and the tables a restore cannot do without are in it.
docker exec -i "$CONTAINER" pg_restore --list < "$OUT.part" > "$OUT.list"
for t in schema_migrations stores conversations messages jobs channel_accounts; do
  if ! grep -Eq "TABLE DATA public $t( |\$)" "$OUT.list"; then
    echo "toran-backup: $OUT.part has no data for $t: not a usable backup" >&2
    rm -f "$OUT.part" "$OUT.list"
    exit 1
  fi
done
rm -f "$OUT.list"
mv "$OUT.part" "$OUT"

# The customers' files, nightly only (a deploy changes none of them).
if [ -z "$LABEL" ] && [ -d "$FILES" ]; then
  tar -czf "$DIR/toran-files-$STAMP.tar.gz.part" -C "$(dirname "$FILES")" "$(basename "$FILES")"
  mv "$DIR/toran-files-$STAMP.tar.gz.part" "$DIR/toran-files-$STAMP.tar.gz"
fi

# What is older than the days kept (the job before this one wrote toran-*.sql.gz: those go the same way).
find "$DIR" -maxdepth 1 -type f \( -name 'toran-*.dump' -o -name 'toran-*.sql.gz' -o -name 'toran-files-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
find "$DIR" -maxdepth 1 -type f \( -name '*.part' -o -name '*.list' \) -mmin +60 -delete

echo "$OUT"
