# Deploying Toran

## On the VPS

These steps are written but not run: the development machine has no Docker. The app runs on the host under pm2 as
`toran`, like the other apps, and only Postgres runs in Docker. The host's Caddy (the one tiyul, brickdeal, accounts
and Teder use) is in front of it, and nothing of Toran's listens on 80, 443 or 0.0.0.0.

1. **Clone the repository and install.** Node 24 or later.
   ```sh
   git clone https://github.com/netanelyan/openfrequency-toran /opt/openfrequency-toran && cd /opt/openfrequency-toran
   npm ci --omit=dev
   npm run init-private
   chmod 600 private/.env
   ```
   `init-private` creates `private/.env` with a session secret in it, and an empty PGlite database the VPS won't use.

2. **Fill in `private/.env`.** At least:

   | Variable | What it is |
   |---|---|
   | `TORAN_ENV` | `prod` |
   | `DATABASE_URL` | `postgres://toran:<the password>@127.0.0.1:5433/toran` (step 3) |
   | `ANTHROPIC_API_KEY` | the agent |
   | `TORAN_MONTHLY_CAP_USD` | a ceiling on API spend |
   | `PUBLIC_HOST` | `toran.openfrequency.co.il`, the dashboard's name |
   | `PUBLIC_BASE_URL` | `https://toran.openfrequency.co.il`: the pitch pages and the webhooks can share the name |
   | `SESSION_SECRET` | 32+ random characters (signs the CSRF tokens) |
   | `OF_INTERNAL_TOKEN` | the same value as in openfrequency-accounts' `private/.env`: sign-in is accounts' (see below) |
   | `TORAN_OWNER_NAME`, `TORAN_OWNER_WHATSAPP`, `TORAN_OWNER_EMAIL` | your contact on pitch pages |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_WEBHOOK_URL` | the demo number (see below) |
   | `DEMO_WA_NUMBER` | the demo number in digits, for the pitch page buttons |
   | `BRAVE_API_KEY` | optional, for discovery by search |

3. **Start the database.** Postgres with pgvector, on 127.0.0.1:5433 (`TORAN_DB_PORT` changes it).
   ```sh
   export TORAN_DB_PASSWORD=<a long random password>
   docker compose -f deploy/docker-compose.yml up -d
   ```
   Use the same password in `DATABASE_URL`.

4. **Start the app.** It migrates the database on start, then serves the dashboard, the pitch pages and the webhooks
   on 127.0.0.1:4710, and runs the worker.
   ```sh
   pm2 start deploy/ecosystem.config.cjs && pm2 save
   curl -s http://127.0.0.1:4710/healthz
   ```
   After a `git pull`: `npm ci --omit=dev && pm2 restart toran`.

5. **Add the name to Caddy.** Point `toran.openfrequency.co.il` at the VPS, append the block in
   `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile` without changing the other blocks, then:
   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
   ```

6. **Download the embedding model once.** It is about 120 MB and is cached in `private/models`; without it,
   policies are matched by words.
   ```sh
   node scripts/ingest.ts embed
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
   every demo conversation is started by the store owner (a service conversation). Toran never starts a
   conversation.

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
