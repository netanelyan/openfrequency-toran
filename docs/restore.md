# Restoring Toran

What a restore needs, and every step, in order. Written before any restore was run: the first drill (below) is the
one that times it and corrects this page.

## What is backed up, and where

| What | How | Where |
|---|---|---|
| The database | `pg_dump -Fc` of the container `toran-db-1`, checked with `pg_restore --list` (the main tables must be in it) before it counts | `/var/backups/toran/toran-<date>-<time>.dump`, nightly at 03:45 (`toran-backup.timer`), and `…-pre-<commit>.dump` before each deploy's migrations. 14 days |
| The customers' files | `private/files` (what customers send and owners attach; the folder appears with the first file), a tar beside each nightly dump | `/var/backups/toran/toran-files-<date>-<time>.tar.gz`, 14 days |
| The keys | not in any backup on the server | the owner's password manager: a copy of `/opt/toran/private/.env`, or at least `TORAN_SECRETS_KEY` |
| The embedding model | not backed up: downloaded again | `private/models` |

The script is `deploy/toran-backup.sh` (installed as `/usr/local/bin/toran-backup`). A backup that fails or does not pass
its check fails `toran-backup.service`, and its `OnFailure` unit alerts the operator. The job it replaces (on the
server on 2026-10-29) wrote `toran-<date>-<time>.sql.gz`, plain SQL gzipped and unchecked: those copies stay until their
14 days are up, and restore with `gunzip | psql`, not `pg_restore` (step 3).

The copies are on the server's own disk. A copy off the server is the server's off-site job (openfrequency-ops); until
it runs, losing the server loses the backups with it.

**`TORAN_SECRETS_KEY` must be kept off the server.** It encrypts every store's WhatsApp, Messenger and Instagram token
and order-API key in the database. A restore with another key opens none of them: every store must connect its
channels again.

## What a restore loses

Everything after the dump: up to a day with the nightly one. Among it, the opt-outs customers sent in those hours.
**Keep the automatic messages (cart, payment, shipping, review) off after a restore until the operator has gone over
the opt-outs of the lost hours** (the stores' WhatsApp chats and the bounces and complaints Resend reported for email):
a customer who asked to stop must not be written to again.

## The steps

As root on the VPS, Toran stopped. `<dump>` is the file to restore.

1. **Stop Toran and keep what is there now.**
   ```sh
   systemctl stop toran
   /usr/local/bin/toran-backup before-restore      # the database as it is, in case the restore is the mistake
   ```
   (On a new server there is nothing to keep: skip the backup.)

2. **The database container, empty.** On a new server, install Docker and start it as in `docs/deploy.md`
   ("Installing from nothing", step 3), with the same `TORAN_DB_PASSWORD` the `.env`'s `DATABASE_URL` holds. On the
   same server, drop and recreate the database:
   ```sh
   docker exec toran-db-1 psql -U toran -d postgres -c "DROP DATABASE toran WITH (FORCE)"
   docker exec toran-db-1 psql -U toran -d postgres -c "CREATE DATABASE toran OWNER toran"
   ```

3. **Load the dump.**
   ```sh
   docker exec -i toran-db-1 pg_restore -U toran -d toran --no-owner --exit-on-error < <dump>
   # an old .sql.gz instead:  gunzip -c <dump> | docker exec -i toran-db-1 psql -U toran -d toran -v ON_ERROR_STOP=1
   ```
   pgvector's extension is in the dump; the image has it.

4. **Put back the private folder.** On the same server it is still there. On a new one: `/opt/toran/private/.env` from
   the owner's password manager (mode 600, owned by `toran`), and the customers' files:
   ```sh
   tar -xzf /var/backups/toran/toran-files-<date>-<time>.tar.gz -C /opt/toran/private
   chown -R toran:toran /opt/toran/private
   ```
   Then the model, once: `node scripts/ingest.ts embed` as `toran` from `/opt/toran/current` (docs/deploy.md, step 6).

5. **Turn the automatic messages off before Toran starts**, keeping which were on. Until step 7 is done:
   ```sh
   docker exec toran-db-1 psql -U toran -d toran -c "CREATE TABLE auto_settings_before_restore AS SELECT store_id, kind, whatsapp, email FROM auto_settings WHERE whatsapp OR email"
   docker exec toran-db-1 psql -U toran -d toran -c "UPDATE auto_settings SET whatsapp = false, email = false, updated_by = 'restore', updated_at = now() WHERE whatsapp OR email"
   ```

6. **Start Toran on the restored database, and check it.** The release that runs must know every migration in the
   dump (a newer dump on an older build refuses to start: `src/db/index.ts`), so restore onto the build that took it or
   a newer one.
   ```sh
   systemctl start toran
   curl -s http://127.0.0.1:4710/readyz            # {"ok":true,...}: the database, a worker loop, the queue
   ```
   Then on the dashboard: a known store, its last conversation, and a channel's state (a store whose channels say
   "connect again" is a `TORAN_SECRETS_KEY` that does not match).

7. **The opt-outs of the lost hours, then the automatic messages.** For each store in `auto_settings_before_restore`,
   read the conversations since the dump's time on its phone's WhatsApp, and Resend's suppressions for email. Each
   customer who asked to stop in those hours goes back in as an opt-out (`auto_consent`: channel, address, scope `all`,
   state `out`, source `restore:<what they wrote>`, `at` the time they wrote it). Then turn the store's automatic
   messages back on from its page as they were, and drop `auto_settings_before_restore`.

## Drills

A backup is known to work only once it has been restored. Each quarter, and after any change to the backup job:
restore the newest nightly dump into a scratch database on the server and check it, without touching the live one.

```sh
docker exec toran-db-1 psql -U toran -d postgres -c "CREATE DATABASE toran_drill OWNER toran"
time docker exec -i toran-db-1 pg_restore -U toran -d toran_drill --no-owner --exit-on-error < /var/backups/toran/<newest>.dump
docker exec toran-db-1 psql -U toran -d toran_drill -c "SELECT count(*) AS stores FROM stores" -c "SELECT max(at) AS last_message FROM messages" -c "SELECT count(*) AS migrations FROM schema_migrations"
docker exec toran-db-1 psql -U toran -d postgres -c "DROP DATABASE toran_drill"
```

Write each one down here: the date, the dump, how long the restore took, and what the counts said.

| Date | Dump | Restore time | Result |
|---|---|---|---|
| | | | not run yet |
