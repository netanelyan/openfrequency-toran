# Deploying Toran

## On the VPS

These steps are written but not run: the development machine has no Docker.

1. **Clone the repository and create the private folder.**
   ```sh
   git clone https://github.com/netanelyan/openfrequency-toran && cd openfrequency-toran
   cp .env.example private/.env
   ```

2. **Fill in `private/.env`.** At least:

   | Variable | What it is |
   |---|---|
   | `TORAN_ENV` | `prod` |
   | `ANTHROPIC_API_KEY` | the agent |
   | `TORAN_MONTHLY_CAP_USD` | a ceiling on API spend |
   | `PUBLIC_HOST` | the dashboard's name |
   | `PUBLIC_BASE_URL` | `https://<pitch host>` |
   | `SESSION_SECRET` | 32+ random characters (signs the CSRF tokens) |
   | `OF_INTERNAL_TOKEN` | the same value as in openfrequency-accounts' `private/.env`: sign-in is accounts' (see below) |
   | `TORAN_OWNER_NAME`, `TORAN_OWNER_WHATSAPP`, `TORAN_OWNER_EMAIL` | your contact on pitch pages |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_WEBHOOK_URL` | the demo number (see below) |
   | `DEMO_WA_NUMBER` | the demo number in digits, for the pitch page buttons |
   | `BRAVE_API_KEY` | optional, for discovery by search |

3. **Point both names at the VPS.** Copy `deploy/Caddyfile.example` to `deploy/Caddyfile` and put the names in.

4. **Start it.**
   ```sh
   export TORAN_DB_PASSWORD=<a long random password>
   docker compose -f deploy/docker-compose.yml up -d --build
   ```
   The app migrates the database on start, then serves the dashboard, the pitch pages and the webhook, and runs the
   worker.

5. **Download the embedding model once.** It is about 120 MB and is cached in `private/models`; without it,
   policies are matched by words.
   ```sh
   docker compose -f deploy/docker-compose.yml exec app node scripts/ingest.ts embed
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

## Development

There is nothing to install beyond `npm install`:
- **The database:** PGlite, Postgres compiled to WASM, in `private/data/pglite`. Only one process may open it, so
  `npm start` runs the web and the worker together.
- **The agent:** the Claude Code CLI on your subscription. An API call is refused unless the command is given
  `--allow-api`.
