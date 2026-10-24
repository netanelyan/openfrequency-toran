# Connecting Toran's channels

How to turn on each channel in production, in the order it makes sense to do it. The general deploy notes are in
docs/deploy.md; this file is the checklist.

**The providers (decided 2026-10-24):** Meta directly for every WhatsApp number, the stores' and our own, and for
Instagram and Messenger, through one Meta app. A store connects the number it already has on the WhatsApp Business
app (coexistence), so WhatsApp keeps working on the owner's phone. Resend for email. Twilio's code stays in the
repository, unused.

## Where things stand

| Channel | Code | Production (checked from outside, 2026-10-24) |
| --- | --- | --- |
| Email | Built: Resend, signed webhook, threads, bounces, owner replies | Off. `/mail/resend` answers 404, no DNS for `in.openfrequency.co.il` |
| WhatsApp, a store's own number | Built: Meta Embedded Signup with coexistence, `/meta/webhook`, replies through the Cloud API, the owner's own replies from the phone in the inbox | Waits for the Meta app and its settings (step 2) |
| WhatsApp, our demo number and owner line | Built on Twilio's code; moving them to Meta is a later item | On the simulator |
| Instagram, Messenger | **Not built.** Next, behind a flag | Shown as "בקרוב" on the website |

## How to change a setting on the server

Every step ends with lines in `/opt/toran/private/.env` and a restart. Toran runs under systemd on tiyul-vps
(not pm2, not Docker):

```
ssh tiyul-vps
nano /opt/toran/private/.env        # add or change the lines
systemctl restart toran
systemctl is-active toran           # active
curl -s http://127.0.0.1:4710/healthz   # ok
journalctl -u toran -n 30 --no-pager    # if it is not active
```

To see which settings are present without printing any value:

```
ssh tiyul-vps 'cd /opt/toran; for k in ANTHROPIC_API_KEY META_APP_ID META_APP_SECRET META_WA_CONFIG_ID META_WEBHOOK_VERIFY_TOKEN TORAN_SECRETS_KEY RESEND_API_KEY RESEND_WEBHOOK_SECRET TORAN_MAIL_DOMAIN TORAN_CHANNELS; do grep -qE "^$k=.+" private/.env && echo "$k: set" || echo "$k: MISSING"; done'
```

## Step 0. The model: check this first

In production Toran answers with Claude only when `ANTHROPIC_API_KEY` is set. Without it, every channel gets the
scripted test answers. Connect nothing before this is set.

1. Create an API key at console.anthropic.com (Settings, API keys), in the workspace you want billed.
2. Add to `.env`:
   ```
   ANTHROPIC_API_KEY=<the key, it starts with sk-ant->
   TORAN_MONTHLY_CAP_USD=100        # a hard monthly limit on API spend for the whole server
   ```
   The cap is a hard stop. Once the month's spend reaches it, Toran stops calling the model: every customer gets
   "I'm checking" and every question goes to the store's owner, on every store, until the month ends. Set it well
   above what you expect, and watch the ring on your dashboard. Leave it out for no cap.
3. Restart. Your Settings page in developer mode (tap the version line) shows `api` as the model.

## Step 1. Email (Resend): everything is built

Each store gets its own address, `<slug>@in.openfrequency.co.il`, and forwards its support mail to it. Toran answers
from that address in the store's name. Using a subdomain keeps openfrequency.co.il's own mail untouched.

1. **Resend account.** Sign up at resend.com.
2. **The domain.** In Resend, Domains, add `in.openfrequency.co.il`. Turn on **receiving** for it as well as
   sending. Resend then lists DNS records: an MX record for receiving, and the SPF (a TXT, and an MX on a `send`
   subdomain) and DKIM (a TXT on `resend._domainkey`) records for sending.
3. **DNS.** Add every record Resend lists, exactly as listed, at the DNS host of openfrequency.co.il. Wait until
   Resend shows the domain as verified. To check from any computer:
   ```
   nslookup -type=MX in.openfrequency.co.il
   nslookup -type=TXT resend._domainkey.in.openfrequency.co.il
   ```
   Your `_dmarc.openfrequency.co.il` is `p=none` today, which is fine to start with.
4. **The webhook.** In Resend, Webhooks, add `https://toran.openfrequency.co.il/mail/resend` with the events
   `email.received`, `email.bounced` and `email.complained`. Copy its signing secret (it starts `whsec_`).
5. **The API key.** In Resend, API Keys, create one with full access (it has to send mail and read received mail).
6. **`.env`**, then restart:
   ```
   RESEND_API_KEY=re_...
   RESEND_WEBHOOK_SECRET=whsec_...
   TORAN_MAIL_DOMAIN=in.openfrequency.co.il
   TORAN_CHANNELS=whatsapp,email
   ```
7. **Check it is wired.** From any computer:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://toran.openfrequency.co.il/mail/resend
   ```
   `403` means it is on and checking signatures (an unsigned probe is refused, as it should be). `404` means a
   setting is missing.
8. **Try it end to end** with a test store before a customer:
   1. On the store's lead page press "לחבר מייל" (in the customer's Settings it is "לחבר את המייל"). The store
      gets its address.
   2. From a personal mailbox, write to that address. Within a minute the conversation is in the inbox and Toran has
      answered.
   3. Answer it from the dashboard and check the reply arrives, signed by `in.openfrequency.co.il` (not in spam).
9. **Tell the website.** On your Settings page, under "ערוצים", set email to "דמו" or "פעיל". The website reads
   it within five minutes, and the "בקרוב" tag on email goes away. Choose "פעיל" only once a paying store can use it.
10. **A store connects.** The owner forwards their support mail to their address. In Gmail: Settings, "העברה
    ו-POP/IMAP", "הוספת כתובת להעברה". Gmail first sends a confirmation code to the new address. It shows up in
    the store's inbox marked as automatic (Toran never answers it), and the owner copies the code into Gmail.

Cost: Resend has a free plan with a daily and a monthly sending limit, and paid plans above it. Check
resend.com/pricing against the number of stores you expect.

## Step 2. A store's own WhatsApp number (Meta, coexistence): built

The store opens Settings, "לחבר את הוואטסאפ של החנות", reads what to check first, and presses the button. Meta's
window opens; the store logs into Facebook, picks or creates its business, chooses to connect its existing WhatsApp
Business app number, and approves on the phone with the code Meta shows. Toran turns the code into the store's token
(sealed with `TORAN_SECRETS_KEY`), asks Meta to send the number's messages to `/meta/webhook`, and reads the number's
state. Connected: Toran answers from then on. Not yet: the dashboard says "ממתין לאישור של Meta", the worker asks Meta
again every ten minutes, and the store turns on by itself. When the owner answers a customer from the phone, the
answer shows in the inbox and Toran stops answering in that conversation for 12 hours.

**What you set up once, at Meta:**
1. **Business verification** of OpenFrequency's Meta Business portfolio (Business Settings, Security Center). It asks
   for company documents and takes days.
2. **A Meta app.** At developers.facebook.com, create an app of type Business, owned by that portfolio, and add the
   **WhatsApp** product.
3. **Become a Tech Provider.** In the app's WhatsApp settings, follow Meta's Tech Provider onboarding. That is what
   lets other businesses (the stores) connect their numbers to our app.
4. **The Embedded Signup configuration.** In the app, Facebook Login for Business, Configurations, create one for
   WhatsApp Embedded Signup, with onboarding of **WhatsApp Business app** numbers (coexistence) turned on. Its id is
   `META_WA_CONFIG_ID`. Add `toran.openfrequency.co.il` to the app's allowed domains for the JavaScript SDK.
5. **The webhook.** In the app's WhatsApp, Configuration: callback URL `https://toran.openfrequency.co.il/meta/webhook`,
   verify token the string you put in `META_WEBHOOK_VERIFY_TOKEN`. Subscribe the fields `messages`,
   `smb_message_echoes` and `account_update`.
6. **App Review.** For stores outside our own business, Meta must approve `whatsapp_business_messaging` and
   `whatsapp_business_management` with advanced access. You submit it; Claude never does. Until then the flow works
   for people with a role on the app, so try it with our own number first.
7. **`.env`**, then restart:
   ```
   META_APP_ID=<the app id>
   META_APP_SECRET=<the app secret, App settings, Basic>
   META_WA_CONFIG_ID=<the configuration id from item 4>
   META_WEBHOOK_VERIFY_TOKEN=<any string you choose, the same as in item 5>
   META_GRAPH_VERSION=v23.0
   TORAN_SECRETS_KEY=<32 or more random characters, e.g. from: openssl rand -base64 33>
   ```
   Keep `TORAN_SECRETS_KEY` safe and unchanged: it seals every store's token, and a new key means every store
   connects again.
8. **Check it is wired:**
   ```
   curl -s "https://toran.openfrequency.co.il/meta/webhook?hub.mode=subscribe&hub.verify_token=<your token>&hub.challenge=ok"
   ```
   It answers `ok`. Meta runs the same check when you save the webhook in item 5.

**What a store needs** (the connect page lists it): the WhatsApp Business app, not the regular WhatsApp (switching is
free and keeps the chats), updated, in use on that number for at least a week, a Facebook account, and the phone at
hand.

**Cost:** Meta charges nothing for replies within 24 hours of the customer's message, which is everything Toran
sends today. Messages a store starts (the cart and shipping templates, a later item) are billed by Meta to the store's
own WhatsApp account, so each store adds a payment method in its WhatsApp Manager before those are turned on.

## Step 3. Our demo number and owner line: Meta next

Both run on Twilio's code today, and in production on the simulator. The plan is to move them to Meta's Cloud API
too, with coexistence, so OpenFrequency's own number (`TORAN_OWNER_WHATSAPP`, the support number and the number on
your phone) stays in the WhatsApp Business app on the phone. That is a separate item. The owner line's five
templates (docs/whatsapp-templates.md) are then submitted to Meta directly.

## Step 4. Instagram and Messenger: next, behind a flag

Both go through the same Meta app. The code is next: a "connect your Facebook page or Instagram" button (Meta
login, then picking the page or account), the token sealed like WhatsApp's, the same `/meta/webhook`, and replies
inside the 24-hour window. Past it, only with a tag Meta allows. They stay behind a flag, off in production.

**What you can do now:**
1. In the same app, add the products **Messenger** and **Instagram** (the Instagram API with Instagram Login).
2. **The app's public details:** privacy policy URL `https://openfrequency.co.il/privacy`, terms URL
   `https://openfrequency.co.il/terms`, an icon, and a data deletion instructions URL.
3. **A test Page and Instagram account:** a Facebook Page and an Instagram professional account of our own, to try
   it end to end in development mode.

App Review for `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `instagram_business_basic` and
`instagram_business_manage_messages` (check the exact names in the App Review screen) is yours to submit, after the
code exists. Claude never submits it.

## When a channel is live

- On your Settings page, under "ערוצים", set it to "פעיל". The website drops its "בקרוב" tag within five minutes.
- In each paying store's lead page, set its plan (חנות or חנות גדולה). Only conversations on a store's own channels
  count toward it. The demo number never does.
- Read the first two weeks of each store's conversations with the owner, as the website promises. The customer's
  dashboard shows them the date this ends.
