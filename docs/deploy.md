# Deploying Toran

## On the VPS

Toran runs on the host as the systemd service `toran` (`deploy/toran.service`, user `toran`), from a release folder
under `/opt/toran`; only Postgres runs in Docker. The host's Caddy (the one tiyul, brickdeal, accounts and Teder use)
is in front of it, and nothing of Toran's listens on 80, 443 or 0.0.0.0.

| Path | What |
|---|---|
| `/opt/toran/repo.git` | a bare mirror of the repository, fetched by each deploy |
| `/opt/toran/releases/<commit>` | one folder per build: the code, its `REVISION`, its `node_modules`. Root's, read-only to `toran` |
| `/opt/toran/current` | a link to the release that runs (the service's working directory) |
| `/opt/toran/private` | the service's own, never inside a release: `.env` (mode 600), `files/`, `models/`, `logs/` |
| `/opt/toran/deploys.log` | each release switched to, by `deploy.sh` or `rollback.sh` |
| `/var/backups/toran` | the nightly dumps and the one before each deploy's migrations, 14 days (`docs/restore.md`) |

### Updating: `deploy/deploy.sh`

As root, from the release that runs:
```sh
/opt/toran/current/deploy/deploy.sh            # main; or a commit or branch
```
It fetches the commit into a new release folder, runs `npm ci` and the whole suite there (`npm run release-check`:
nothing failed, nothing skipped; a few minutes), drops the dev dependencies, takes a backup and checks it, applies the
new migrations as their own step, switches `current`, restarts `toran` and waits up to 60 seconds for `/readyz` from
the new build. If it does not come, it rolls back. `--skip-tests` only for a commit that is green in CI (GitHub Actions,
`.github/workflows/test.yml`, runs the suite on PGlite and on Postgres on every push).

- **Rollback:** `/opt/toran/current/deploy/rollback.sh` runs the release before again (or the one named). It refuses
  when the database holds a migration that release does not know: the older build would run on a newer schema. Then the
  way back is a fix forward, or the dump taken before the deploy (`docs/restore.md`). `--force` goes anyway.
- **Migrations** run only in the deploy, after a backup under an hour old (`npm run migrate` refuses without one). The
  service runs with `TORAN_MIGRATE=check`: a restart on a schema that lacks a migration refuses to start, and so does
  every build on a schema that holds a migration it has no file for. Ship additive changes first (a new column, a new
  table) and the code that needs them in the same or a later deploy; drop or rewrite data only once a release that
  needed no rollback has run on it. A migration that rewrites data (like 020) is marked "no rollback" in its commit,
  with its way forward written down.
- **Order between repositories:** deploy the one that serves an internal API before the one that calls it. Today:
  accounts (`/internal/session`, `/internal/entitlement`) before Toran, and Toran (`/internal/setup`, `/internal/lead`,
  `/internal/ops`) before accounts starts asking for anything new of it.
- **Health:** `/healthz` is liveness (`ok` and the commit). `/readyz` is readiness: 200 when the database answers, a
  worker loop of this build ran in the last two minutes, and no customer's message has waited five minutes for a loop;
  503 with the same JSON otherwise. The uptime monitor watches `/readyz`.

### Release folders: the move, once

Until it is done the server runs from a plain checkout in `/opt/toran` (`git pull` and a restart). Moving takes one
restart; `private/` and the database stay where they are. Checked on the server on 2026-10-29: `toran.service` runs as
`toran` from `/opt/toran` with `/opt/node24/bin/node`, `TORAN_HOME=/opt/toran/private`, `PORT=4710` in `private/.env`,
`MemoryMax=1100M` and no `After=docker.service`; the dump job is `/usr/local/bin/toran-backup` (gzipped plain SQL) run
by `toran-backup.service` as root at 03:45. Checked on 2026-10-30:
- The tools `deploy.sh` needs are all there: `/usr/sbin/runuser`, `/usr/bin/flock`, `/usr/bin/git`, `/usr/bin/tar`
  and `/opt/node24/bin/npm`.
- The live unit, read in full, already has the same hardening lines and `ReadWritePaths=/opt/toran/private
  /var/lib/toran`. `/var/lib/toran` is the toran user's home, and the service writes there (its `.npm`). It stays
  writable.
- The new unit keeps `MemoryMax=1100M` until the owner decides. The proposal and the figures are in
  `deploy/toran.service`.

As root:

```sh
cd /opt/toran
git clone --mirror "$(git remote get-url origin)" /opt/toran/repo.git
install -m 755 deploy/toran-backup.sh /usr/local/bin/toran-backup       # the checked backup (replaces the old script)
cp deploy/toran-backup.service deploy/toran-backup.timer /etc/systemd/system/
diff /etc/systemd/system/toran.service deploy/toran.service             # read what changes: paths, memory, migrations
cp deploy/toran.service /etc/systemd/system/toran.service
systemctl daemon-reload && systemctl enable --now toran-backup.timer
# The first release: the checkout's commit, with its node_modules, so deploy.sh has a release to come back to.
mkdir -p releases && SHA=$(git rev-parse HEAD) && git archive "$SHA" | (mkdir "releases/$SHA" && tar -x -C "releases/$SHA")
cp -a node_modules "releases/$SHA/" && echo "$SHA" > "releases/$SHA/REVISION" && touch "releases/$SHA/.ready"
ln -sfn "/opt/toran/releases/$SHA" /opt/toran/current && echo "$(date -u +%FT%TZ) $SHA move" >> deploys.log
systemctl restart toran && curl -s http://127.0.0.1:4710/readyz
# From now on:
/opt/toran/current/deploy/deploy.sh
```

Until the first deploy from `releases/`, that release is today's build: `/readyz` answers only once a build that has
it runs. The compose file moves with the code: from now on `docker compose --env-file /opt/toran/private/db.env -p toran -f
/opt/toran/current/deploy/docker-compose.yml ...`, the same project, container and volume. Its new `mem_limit` (512 MB;
the database uses about 51 MB) takes effect at the next `up -d`, which recreates the container: a few seconds without a
database, in a quiet minute. The new unit's `OnFailure=of-alert@%n.service`, and the backup's, are the server's alert unit
(openfrequency-ops); until it is installed systemd notes a missing unit and nothing else changes. Once a deploy has run
from `releases/`, the old checkout's files at the top of `/opt/toran` (everything but `repo.git`, `releases`,
`current`, `private` and `deploys.log`) can go.

### Installing from nothing

1. **The user, the folders, the code.** Node 24 or later in `/opt/node24`.
   ```sh
   useradd --system --home-dir /var/lib/toran --create-home --shell /usr/sbin/nologin toran   # as on the live server
   mkdir -p /opt/toran/private && chown toran:toran /opt/toran/private && chmod 700 /opt/toran/private
   git clone --mirror https://github.com/netanelyan/openfrequency-toran /opt/toran/repo.git
   ```

2. **Fill in `/opt/toran/private/.env`** (mode 600, owned by `toran`). At least:

   | Variable | What it is |
   |---|---|
   | `TORAN_ENV` | `prod` |
   | `DATABASE_URL` | `postgres://toran:<the password>@127.0.0.1:5433/toran` (step 3) |
   | `ANTHROPIC_API_KEY` | the agent |
   | `TORAN_MONTHLY_CAP_USD` | a ceiling on API spend |
   | `PUBLIC_HOST` | `toran.openfrequency.co.il`, the dashboard's name |
   | `PUBLIC_BASE_URL` | `https://toran.openfrequency.co.il`: the pitch pages and the webhooks can share the name |
   | `SESSION_SECRET` | 32+ random characters (signs the CSRF tokens) |
   | `TORAN_SECRETS_KEY` | encrypts the stores' tokens and keys in the database. Keep a copy OFF the server (the owner's password manager): a restore without it means every store connects again (`docs/restore.md`) |
   | `OF_INTERNAL_TOKEN` | the same value as in openfrequency-accounts' `private/.env`: sign-in is accounts' (see below) |
   | `TORAN_OWNER_NAME`, `TORAN_OWNER_WHATSAPP`, `TORAN_OWNER_EMAIL` | your contact on pitch pages |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_WEBHOOK_URL` | the demo number (see below) |
   | `DEMO_WA_NUMBER` | the demo number in digits, for the pitch page buttons |
   | `TORAN_ASSISTANT_WA`, `TWILIO_TEMPLATES` | the owner line and its approved templates (see below) |
   | `OF_ASSISTANT_SECRET`, `TEDER_INTERNAL` | Teder on the owner line: the same secret in Teder's `.env` |
   | `BRAVE_API_KEY` | optional, for discovery by search |

3. **Start the database.** Postgres with pgvector, on 127.0.0.1:5433 (`TORAN_DB_PORT` changes it), with its memory
   ceiling (512 MB).
   ```sh
   echo "TORAN_DB_PASSWORD=<a long random password>" > /opt/toran/private/db.env && chmod 600 /opt/toran/private/db.env
   docker compose --env-file /opt/toran/private/db.env -p toran -f <a checkout>/deploy/docker-compose.yml up -d
   ```
   Use the same password in `DATABASE_URL`.

4. **The service, the backup, the first release.** On an empty database the first deploy stops at its backup (a dump
   with no tables does not pass the check). That once, create the schema from the release it built, then deploy again:
   `cd /opt/toran/releases/<commit> && runuser -u toran -- env TORAN_HOME=/opt/toran/private node scripts/migrate.ts
   --no-backup-check`.
   ```sh
   cp deploy/toran.service deploy/toran-backup.service deploy/toran-backup.timer /etc/systemd/system/
   install -m 755 deploy/toran-backup.sh /usr/local/bin/toran-backup
   systemctl daemon-reload && systemctl enable toran && systemctl enable --now toran-backup.timer
   <a checkout>/deploy/deploy.sh
   curl -s http://127.0.0.1:4710/readyz
   ```

5. **Add the name to Caddy.** Point `toran.openfrequency.co.il` at the VPS, append the block in
   `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile` without changing the other blocks, then:
   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
   ```

6. **Download the embedding model once.** It is about 120 MB and is cached in `private/models`; without it,
   policies are matched by words.
   ```sh
   cd /opt/toran/current && runuser -u toran -- env TORAN_HOME=/opt/toran/private node scripts/ingest.ts embed
   ```

## Sign-in: openfrequency-accounts

Toran has no login of its own. A browser without a session goes to
`https://accounts.openfrequency.co.il/login?next=<the page>`, and Toran asks accounts who the
`__Secure-of_session` cookie belongs to on `http://127.0.0.1:4741/internal/session?product=toran` (its
`docs/internal-session.md`). Accounts must run on the same machine, with the same `OF_INTERNAL_TOKEN`.

- A session sees only its workspace's stores. A store with no workspace is the operator's (the superadmin outside
  view-as), who sees every workspace. `npm run workspace:assign -- <workspace id> <store id or domain>` gives a store
  to a customer's workspace (`--dry-run` first); `none` gives it back.
- A page reuses accounts' answer for up to 60 seconds; every POST asks afresh. View-as is read-only.
- Accounts down or misconfigured: an error page, and nobody gets in. The pitch pages, the webhook and `/healthz`
  never ask accounts.

## The demo number (Twilio)

1. **Get a WhatsApp sender.** Create a Twilio account and add a WhatsApp sender with Self Sign-up. Register a
   number you own (Bring Your Own Number): an Israeli mobile that can receive the SMS or voice OTP. While Meta
   reviews the business, Twilio's WhatsApp sandbox works for testing.
2. **Point the webhook at Toran.** In the sender's settings, set "A message comes in" to
   `https://<pitch host>/wa/twilio` (POST). Set the same URL as `TWILIO_WEBHOOK_URL`: the signature is checked
   against it.
3. **Know what it costs.** Twilio charges $0.005 a message each way. Meta charges nothing for the replies, because
   every demo conversation is started by the store owner (a service conversation). On the demo number Toran never
   starts a conversation.

## The owner line (Twilio, a second number)

The number business owners write to, about Toran and Teder (docs/owner-line.md).

1. **A second WhatsApp sender** on the same Twilio account, with its "A message comes in" webhook pointing at the
   same `https://<pitch host>/wa/twilio`. Toran tells the two numbers apart by the number each message was written
   to. Put its digits in `TORAN_ASSISTANT_WA`, and the same value in openfrequency-accounts' `OF_ASSISTANT_WA`, so the
   link button there opens it.
2. **The templates.** Submit the five in docs/whatsapp-templates.md, as Utility, in Hebrew. As each one is approved,
   add `name=HX...` to `TWILIO_TEMPLATES`. Until a template is approved, its message is not sent outside the 24
   hours, and owner_notifications records it as `no_template`.
3. **Teder.** Set `OF_ASSISTANT_SECRET` (32+ random characters) here and in Teder's `.env`. Teder's internal API is
   on 127.0.0.1:4701 (`TEDER_INTERNAL` if not), and Teder posts its events to Toran's own port on 127.0.0.1.
4. **Know what it costs.** Twilio charges $0.005 a message here too. Meta charges for each template it delivers
   (the utility rate), on Twilio's bill. An answer to the owner, and anything inside the 24 hours, costs Meta
   nothing.

## Email (Resend)

The email channel's code is off until `TORAN_CHANNELS` lists `email`. Each store gets an address on a receiving
subdomain, `<slug>@in.openfrequency.co.il`, and forwards its own support mail there. Toran answers from that address,
with the store's name. A subdomain keeps the main domain's own mail where it is.

1. **Receiving.** In Resend, add `in.openfrequency.co.il` as a receiving domain, and add the MX record it gives
   you at the DNS host. Mail to any address on it then reaches Resend.
2. **Sending.** Verify the same domain for sending in Resend (its SPF and DKIM records), so the replies are signed
   by our own domain and land in the inbox.
3. **The webhook.** In Resend's webhooks, add `https://<pitch host>/mail/resend` with the events `email.received`,
   `email.bounced` and `email.complained`. Copy its signing secret (`whsec_...`) to `RESEND_WEBHOOK_SECRET`.
4. **The settings.** Set `RESEND_API_KEY` (a key that can send and read received emails),
   `TORAN_MAIL_DOMAIN=in.openfrequency.co.il`, and add `email` to `TORAN_CHANNELS`. Restart.
5. **A store.** On the store's page in the dashboard, "לחבר מייל" gives it its address. The owner forwards the
   store's mail to it. Gmail first sends a confirmation code to the new address, and that email shows up in the
   inbox, marked automatic (Toran never answers it).
6. **The website.** On /settings, under "ערוצים", set email to "פעיל" only once a paying store can use it.
   `GET /channels.json` is what the website reads for its "בקרוב" tags.

Toran never answers auto-replies, mailing lists, bounces or no-reply senders. Its own replies say
`Auto-Submitted: auto-replied`, and an address that bounced or complained gets no more mail.

## Development

There is nothing to install beyond `npm install`:
- **The database:** PGlite, Postgres compiled to WASM, in `private/data/pglite`. Only one process may open it, so
  `npm start` runs the web and the worker together.
- **The agent:** the Claude Code CLI on your subscription. An API call is refused unless the command is given
  `--allow-api`.

**Tests.** `npm test` runs the suite on PGlite in memory. Production runs Postgres 17 through another driver, so the
same suite also runs there: `TORAN_TEST_DATABASE_URL=postgres://postgres:<password>@localhost:5432/postgres npm test`
against any Postgres 17 with pgvector (each test gets a database of its own and drops it). CI does both on every push
(`.github/workflows/test.yml`). `npm run release-check` is what a release must pass: the suite with nothing failed and
nothing skipped, then check:public.
