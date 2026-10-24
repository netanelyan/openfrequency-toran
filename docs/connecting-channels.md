# Connecting Toran's channels

How to turn on each channel in production, in the order it makes sense to do it. It is written against the code as
of 2026-10-24 (main d607c68). The general deploy notes are in docs/deploy.md; this file is the checklist.

## Where things stand

| Channel | Code | Production (checked from outside, 2026-10-24) |
| --- | --- | --- |
| Email | Built: Resend, signed webhook, threads, bounces, owner replies | Off. `/mail/resend` answers 404, no DNS for `in.openfrequency.co.il` |
| WhatsApp, the demo number | Built: Twilio, one shared number | On the simulator. `/wa/twilio` answers 404 |
| WhatsApp, a store's own number | **Not built** | - |
| Instagram | **Not built** | Shown as "בקרוב" on the website |
| Messenger | **Not built** | Shown as "בקרוב" on the website |

Steps 0 to 3 are accounts and settings only. Steps 4 and 5 need code first, but the Meta side takes weeks, so it is
worth starting it now.

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
ssh tiyul-vps 'cd /opt/toran; for k in ANTHROPIC_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_WHATSAPP_FROM TWILIO_WEBHOOK_URL DEMO_WA_NUMBER TORAN_ASSISTANT_WA TWILIO_TEMPLATES RESEND_API_KEY RESEND_WEBHOOK_SECRET TORAN_MAIL_DOMAIN TORAN_CHANNELS; do grep -qE "^$k=.+" private/.env && echo "$k: set" || echo "$k: MISSING"; done'
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

## Step 2. WhatsApp, the demo number (Twilio): built

This is the one number every pitch page's "try it" button opens. Prospects write the store's DEMO code to it.

> **Read this before registering a number.** `DEMO_WA_NUMBER` is set to OpenFrequency's own number, the same as
> `TORAN_OWNER_WHATSAPP`: the support number, and the number on your phone. A number registered on the WhatsApp Business Platform (which is what
> Twilio uses) normally stops working in the WhatsApp app on the phone. Before you register it, ask Twilio whether
> it supports keeping the app on that number ("coexistence"). If it doesn't, use a separate number for the demo,
> keep OpenFrequency's number for support (`TORAN_OWNER_WHATSAPP`), and update the demo number on the website
> (`TORAN_DEMO_WA` in /etc/openfrequency-web/lead.env, and `whatsapp` in site.config.json).

1. **Twilio account.** Sign up at twilio.com and upgrade it from trial (add a payment method).
2. **Meta business.** Twilio's WhatsApp self sign-up connects a Meta Business portfolio. Use OpenFrequency's, and
   start Meta's **business verification** on it (Business Settings, Security Center). It asks for company
   documents and takes days, and the same verification is needed for steps 3 to 5.
3. **The sender.** In Twilio, Messaging, Senders, WhatsApp senders, create one with self sign-up and register the
   number (an Israeli number that can get the SMS or voice code). The display name should be "OpenFrequency".
   While Meta reviews it, Twilio's WhatsApp sandbox works for testing.
4. **The webhook.** On the sender, set "A message comes in" to `https://toran.openfrequency.co.il/wa/twilio`,
   method POST.
5. **`.env`**, then restart. The Account SID and Auth Token are on the Twilio console's front page:
   ```
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_WHATSAPP_FROM=+972...                     # the sender's number
   TWILIO_WEBHOOK_URL=https://toran.openfrequency.co.il/wa/twilio   # exactly as in step 4: the signature is checked against it
   DEMO_WA_NUMBER=972...                            # the same number, digits only
   ```
6. **Check it is wired:**
   ```
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://toran.openfrequency.co.il/wa/twilio
   ```
   `403` means it is on. `404` means it is still on the simulator (one of the four Twilio settings is missing, or
   `TORAN_WA=sim` is set).
7. **Try it.** Open a pitch page, press its WhatsApp button, send the code, and ask about a product. The conversation
   appears in the inbox with the "דמו" tag.

Cost: Twilio charges $0.005 a message each way. Meta charges nothing for replies within 24 hours of the customer's
message, which covers every demo conversation.

## Step 3. The owner line (a second Twilio number): built

The number store owners write to about their store (Toran's assistant) and their Teder posts. It has to be a
different number from the demo number. Full details are in docs/owner-line.md and docs/deploy.md.

1. A second WhatsApp sender on the same Twilio account, with the same webhook URL as in step 2.
2. `.env` here: `TORAN_ASSISTANT_WA=972...` (digits). In openfrequency-accounts' `.env`: `OF_ASSISTANT_WA` with the
   same value. Then `OF_ASSISTANT_SECRET` (32 or more random characters) here and in Teder's `.env`.
3. Submit the five templates in docs/whatsapp-templates.md on Twilio (Content Template Builder, category Utility,
   Hebrew). As Meta approves each one, add it to `TWILIO_TEMPLATES` as `name=HX...`, comma-separated.

## Step 4. A store's own WhatsApp number: needs code first

Today every WhatsApp message goes to the demo number or the owner line. Nothing routes a store's own number to
that store. The website already promises that "the store's number stays yours", so this is the step that makes
WhatsApp a live channel for a paying store.

**The code (for Claude to build):** a WhatsApp channel account per store, in the same `channel_accounts` table email
uses. Twilio sends every number's messages to the one webhook, so the number a message was sent to says which store
it belongs to. It also needs the "connect your number" step in the store's Settings, and the 24-hour window and
templates per store.

**What you can do now:**
- Ask Twilio how to register numbers for your customers' businesses under your account. Twilio's term is
  **Independent Software Vendor (ISV)**, done with **Senders API / Tech Provider** onboarding. Each store's number
  is registered under the store's own Meta business, which the owner approves once.
- The same warning as in step 2: a store's number that moves to the platform leaves the WhatsApp app on the
  owner's phone unless coexistence is supported. Each customer needs to hear that before connecting. The website's
  FAQ should say it too.

## Step 5. Instagram and Messenger: need code first

Both go through one Meta app. The code is new: a "connect your Facebook Page and Instagram" button in the store's
Settings (Facebook Login), the page's access token kept encrypted (`channel_accounts.secret` is ready for it), Meta's
webhook for incoming messages, and sending replies through Meta's API inside its 24-hour window.

**What you can do now, because Meta's review is the slow part:**
1. **Business verification** of OpenFrequency's Meta Business portfolio (the same one as step 2).
2. **A Meta app.** At developers.facebook.com, create an app of type Business, owned by that portfolio. Add the
   products **Messenger** and **Instagram**.
3. **The app's public details:** privacy policy URL `https://openfrequency.co.il/privacy`, terms URL
   `https://openfrequency.co.il/terms`, an icon, and a data deletion instructions URL. Meta's review checks they
   exist.
4. **The permissions to request in App Review** (check the exact names in the App Review screen, Meta renames them):
   for Messenger `pages_messaging`, `pages_manage_metadata` and `pages_show_list`; for Instagram
   `instagram_manage_messages` (or `instagram_business_manage_messages` with Instagram Login) and
   `instagram_basic`; and `business_management`. Review asks for a screen recording of the feature working, so it
   is submitted after the code exists. Until then, you and test users added to the app can use it in development
   mode.
5. **A test Page and Instagram account.** A Facebook Page and an Instagram professional account connected to it.
   Use a test store's, so the code can be tried end to end before review.

## When a channel is live

- On your Settings page, under "ערוצים", set it to "פעיל". The website drops its "בקרוב" tag within five minutes.
- In each paying store's lead page, set its plan (חנות or חנות גדולה). Only conversations on a store's own channels
  count toward it. The demo number never does.
- Read the first two weeks of each store's conversations with the owner, as the website promises. The customer's
  dashboard shows them the date this ends.
