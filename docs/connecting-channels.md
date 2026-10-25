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
| Email | Built: Resend, signed webhook, threads, bounces, owner replies, attachments both ways (the owner's only), a store's own address on its domain | Off. `/mail/resend` answers 404, no DNS for `in.openfrequency.co.il` |
| WhatsApp, a store's own number | Built: Meta Embedded Signup with coexistence, `/meta/webhook`, replies through the Cloud API, the owner's own replies from the phone in the inbox, the token's end watched and renewed or asked for again | The Meta app is set; App Review for advanced access is submitted (step 2) |
| WhatsApp, our own number (owner line, demo number, support) | Built: our one number, on as soon as the company store's WhatsApp page connects it (step 3); also Twilio's code, and Meta by `META_DEMO_PHONE_ID` and `META_OWNER_PHONE_ID` for separate numbers | On the simulator: the number is not connected yet (step 3, after App Review) |
| A store's automatic messages (cart, payment, shipping, review) | Built: the store's platform by webhook or a reading every 15 minutes, its own WhatsApp templates submitted and tracked, email, consent and "הסר", quiet time (step 5) | Off for every store until its owner turns a kind on |
| Instagram, Messenger | Built, behind the flag: login at Meta, `/meta/oauth/<channel>`, the same `/meta/webhook`, replies through the Send API inside the 24 hours, the owner's own answers in the inbox | Off: `TORAN_CHANNELS` does not list them (step 4) |

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
ssh tiyul-vps 'cd /opt/toran; for k in ANTHROPIC_API_KEY META_APP_ID META_APP_SECRET META_WA_CONFIG_ID META_WEBHOOK_VERIFY_TOKEN META_FB_CONFIG_ID META_IG_APP_ID META_IG_APP_SECRET META_DEMO_PHONE_ID META_OWNER_PHONE_ID META_SYSTEM_TOKEN META_TEMPLATES PUBLIC_BASE_URL TORAN_SECRETS_KEY RESEND_API_KEY RESEND_WEBHOOK_SECRET TORAN_MAIL_DOMAIN TORAN_CHANNELS; do grep -qE "^$k=.+" private/.env && echo "$k: set" || echo "$k: MISSING"; done'
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

### A store's own address, e.g. support@theirstore.co.il: built, optional

Until a store does this, Toran answers from `<slug>@in.openfrequency.co.il`. With it, the same answers go out from the
store's own address. Mail still comes in the way it did (forwarded to the address on our domain), or, if the owner
wants, straight to Toran on a subdomain of theirs.

**What you set up once:** nothing past step 1. Toran adds each store's domain through Resend's API with the same
`RESEND_API_KEY`, which is why that key has full access. Two things to check at Resend:
- **The plan's domain limit.** Every store with its own address is one domain at Resend, and a receiving subdomain is
  a second. Check resend.com/pricing against the number of stores you expect before you tell stores about it.
- **The webhook.** The one from step 1 item 4 (`email.received`) also carries mail to the stores' receiving
  subdomains. Nothing to add.

**What the store does,** in Settings, under the email (it shows once the store's email is connected):
1. Writes the address Toran should answer from, e.g. `support@theirstore.co.il`. It has to be an address whose mail
   they already forward to their address on our domain, so a customer's answer comes back to Toran.
2. Optionally writes a subdomain for mail to come straight to Toran, e.g. `help`. This is only for a store that wants
   to stop forwarding; their usual mail on `theirstore.co.il` is not touched either way.
3. Presses "להוסיף את הדומיין". Toran adds `theirstore.co.il` at Resend for sending only (and `help.theirstore.co.il`
   for receiving only), and the page lists the DNS records to add, each with its type, name, value and priority:
   - a TXT on `resend._domainkey.theirstore.co.il` (DKIM)
   - an MX and a TXT on `send.theirstore.co.il` (SPF, for bounces). These sit on a subdomain, so the store's own MX
     and SPF stay as they are.
   - with a subdomain: an MX on `help.theirstore.co.il`
4. Adds them at their DNS host (where they bought the domain, or Cloudflare), exactly as listed. Some hosts want only
   the part before the domain as the name (`resend._domainkey`, `send`, `help`).
5. Presses "לבדוק עכשיו". Toran asks Resend to verify and reads the result. It usually takes minutes, sometimes up to
   two days; the worker reads it again every ten minutes for three days, so the store does not have to keep pressing.

**Once verified:** the agent's answers and the owner's answers from the inbox go out from `support@theirstore.co.il`,
with Reply-To the same address (or `support@help.theirstore.co.il` once that subdomain is verified, so a customer's
reply comes straight in). Mail from the store's own address is never answered: it is the store writing to itself. The
reply box in a conversation says which address the answer goes out from. "להפסיק עם הדומיין הזה" deletes the domain
at Resend, and the answers go out from our domain again.

To check a store's records from any computer:
```
nslookup -type=TXT resend._domainkey.theirstore.co.il
nslookup -type=MX send.theirstore.co.il
nslookup -type=MX help.theirstore.co.il
```

**Files.** Nothing to set up. A customer's attachments (images and PDFs up to 10 MB) are fetched from Resend and kept
in `/opt/toran/private/files`, and shown in the conversation. The owner can attach one image or PDF to an answer from
the inbox. Include that folder in the server's backups.

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
   `smb_message_echoes`, `account_update`, and for the stores' automatic messages (step 5)
   `message_template_status_update` and `template_category_update`.
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

**Cost:** Meta charges nothing for replies within 24 hours of the customer's message. Messages a store starts (the
automatic messages of step 5) are billed by Meta to the store's own WhatsApp account, so each store adds a payment
method in its WhatsApp Manager before those are turned on; the settings page says so.

**How long a store's connection lasts.** The code from Embedded Signup becomes a business integration system user
token, and the configuration in item 4 decides how long it lasts. Meta's template, "WhatsApp Embedded Signup
Configuration With 60 Expiration Token", gives one that ends after 60 days. Toran never stops on that by surprise:
- It reads the token with Meta's `debug_token` right after the connect and once a day, and keeps when it was issued
  and when it ends (`channel_accounts.token_*`). The store's WhatsApp page shows "החיבור בתוקף עד".
- From 20 days before the end the worker renews it, in this order. When the token covers the store's business
  (`business_management`), Meta's `POST /<business>/system_user_access_tokens` makes one that never expires. Else
  Meta's refresh of an expiring system user token (`GET /oauth/access_token`, `grant_type=fb_exchange_token`,
  `set_token_expires_in_60_days=true`) gives another 60 days. A new token is used only once `debug_token` says it is
  valid and lasts longer.
- If Meta allows neither, then from 10 days before the end Today, the lead page and the WhatsApp page show "צריך
  לחבר מחדש את הוואטסאפ" with the button. Your list on /admin has the store first, with a message to copy (its "שלחתי"
  hides it for three days). The person who connected, and the workspace's linked owners, get one email, once email
  (step 1) is on.
- On the end, or the first time Meta refuses the token (code 190): the number's status is `reconnect`. Meta still
  delivers the customers' messages, Toran does not answer them, and each conversation gets a note for the owner (once
  a day) saying why. The inbox's reply box says to answer from the phone. One more email goes out.
- The store presses "לחבר מחדש את הוואטסאפ", goes through the same window of Meta with the same number, and is active
  again with a new token.

To stop the 60-day cycle for the stores that connect from now on, make the configuration by hand instead of from
the template. In Facebook Login for Business, Configurations, "Create configuration":
1. Login variation **WhatsApp Embedded Signup**.
2. Access token **System-user access token**, token expiration **Never**.
3. The assets and permissions the template had: WhatsApp accounts, `whatsapp_business_management`,
   `whatsapp_business_messaging`.
4. Put its id in `META_WA_CONFIG_ID` and restart.

Stores connected with the old configuration keep their 60-day token until they connect again once. The banner asks
them to. If Meta does not offer "Never" for this login variation on your app, keep the template. The renewal and the
banner above handle it.

## Step 3. Our demo number and owner line: Twilio or Meta, built

### Toran on our own number: the way we go live

OpenFrequency has one WhatsApp number, its public number on the WhatsApp Business app on your phone
(`DEMO_WA_NUMBER`, `TORAN_OWNER_WHATSAPP`, every pitch page's button). It is the owner line, the demo number and our
support at once. You connect it once, on the company store's WhatsApp page, and that is the switch: no id to copy, no
second number, no Twilio. docs/company.md, "Toran on our own number", has the order the messages are read in, the
demo's way back to support and where the phone's answers land. After App Review:

1. **Step 2 is done** (the Meta app, the webhook with `messages`, `smb_message_echoes` and `account_update`, its
   settings in `.env`), and the company store is synced (docs/company.md; store 95 in production).
2. **`.env`**, then restart:
   ```
   TORAN_SUPPORT_STORE=openfrequency.co.il
   DEMO_WA_NUMBER=<our number, digits only>          # already set
   TORAN_OWNER_WHATSAPP=<the same number>            # already set
   TORAN_ASSISTANT_WA=<the same number>              # and OF_ASSISTANT_WA in accounts' .env, the same
   META_SYSTEM_TOKEN=<optional, recommended: item 4 below>
   ```
   Leave `META_DEMO_PHONE_ID` and `META_OWNER_PHONE_ID` out.
3. **Connect:** `/admin/toran/lead/95/whatsapp`, "לחבר את הוואטסאפ של החנות", our business and our existing WhatsApp
   Business app number in Meta's window, the code on the phone. The page says "המספר שלנו מחובר" and lists the three
   roles. It is on at once, with no restart.
4. **Templates:** item 6 below, on this number's WhatsApp account, then `META_TEMPLATES` and restart.
5. **Try each role** from a personal phone: a question from a number accounts does not know (support answers); a
   pitch page's button, a question, then "תמיכה" (the demo, then support); "מה קורה?" from a number linked in accounts
   (the assistant). Answer one of them from the WhatsApp Business app: it shows in that conversation in the inbox, and
   Toran waits there.
6. **Undo:** "לנתק את הוואטסאפ מתורן" on the same page.

A store's own page cannot connect this number: it says "זה המספר של OpenFrequency, ואי אפשר לחבר אותו לחנות".

### Separate numbers, by setting

Both lines also work on Twilio's code, and on Meta's Cloud API as numbers of their own. Each one is on Meta once its
setting names its Meta number id, and on Twilio (or, with no Twilio account, the simulator) until then. Our own
number above takes every role a setting leaves out:

| Setting | The number | Known everywhere else as |
| --- | --- | --- |
| `META_DEMO_PHONE_ID` | the demo number, which is also our public number and support | `DEMO_WA_NUMBER` (the pitch pages' button) |
| `META_OWNER_PHONE_ID` | the owner line | `TORAN_ASSISTANT_WA` (accounts' link code, Teder's news) |

A message Meta sends for one of these ids goes to the demo number's router or to the owner line, exactly as Twilio's
does: codes bind, owners reach their assistant, strangers get our support (`TORAN_SUPPORT_STORE`). It is never
answered as a store's own WhatsApp, even when the number was connected on a store's page. Every answer, image and
template goes out through the Cloud API from the number it belongs to, and so do the inbox's replies. The operator
writing from our phone (coexistence) is not taken for a store's owner: the answer lands in the conversation that
person is in, as on our own number.

**Set it up once App Review has passed** (our own numbers are our own business's, so standard access already lets you
try them; App Review is what the stores need):
1. **The demo number** is OpenFrequency's own number on the WhatsApp Business app on your phone
   (`TORAN_OWNER_WHATSAPP`). Connect it with coexistence, so the phone keeps working: sync the company store
   (docs/company.md), open its WhatsApp page (`/admin/toran/lead/<its id>/whatsapp`) and press "לחבר את הוואטסאפ של
   החנות". That subscribes our WhatsApp account to the webhook and seals the number's token.
2. **The owner line** is a second number. Add it to the same WhatsApp account in WhatsApp Manager, or, if it is on the
   WhatsApp Business app too, connect it the same way.
3. **The ids.** In WhatsApp Manager, Phone numbers, copy each number's **Phone number ID** (not the number itself).
4. **The token (recommended).** In Business Settings, System users, create an admin system user, assign it our
   WhatsApp account with full control, and generate a token for the app with `whatsapp_business_messaging` and
   `whatsapp_business_management`, expiration **Never**. Put it in `META_SYSTEM_TOKEN`. Without it, Toran uses the
   token from item 1, which ends after 60 days with the template configuration, as in step 2.
5. **The webhook for a number added in WhatsApp Manager only** (item 1 already did this for the demo number):
   ```
   curl -s -X POST "https://graph.facebook.com/v23.0/<our WhatsApp account id>/subscribed_apps" -H "Authorization: Bearer <META_SYSTEM_TOKEN>"
   ```
   It answers `{"success":true}`.
6. **The owner line's five templates** (docs/whatsapp-templates.md). In WhatsApp Manager, Message templates, create
   each one exactly as the sheet says: its name, Utility, Hebrew, the body, the footer, the quick reply buttons. Once
   Meta approves them, list their names in `META_TEMPLATES`. A template not listed is not sent, and the owner
   notifications record it as skipped. Add a payment method to our WhatsApp account: Meta bills each template.
7. **`.env`**, then restart:
   ```
   META_DEMO_PHONE_ID=<the demo number's Phone number ID>
   META_OWNER_PHONE_ID=<the owner line's Phone number ID>
   META_SYSTEM_TOKEN=<item 4, optional>
   META_TEMPLATES=teder_posts_ready,teder_post_reminder,teder_post_unposted,teder_quota_low,teder_weekly_summary
   DEMO_WA_NUMBER=<the demo number, digits only>          # already set
   TORAN_ASSISTANT_WA=<the owner line, digits only>       # already set, the same as OF_ASSISTANT_WA in accounts
   ```
   Either line can move alone: leave the other's id out and it stays on Twilio.
8. **Try it.** From a personal phone, press a pitch page's demo button: the answer comes from the demo number. Write
   to the owner line from a number linked in accounts: the assistant answers. Write to it from a number that is not
   linked: our support answers, or "this number is not linked" when `TORAN_SUPPORT_STORE` is unset.

Cost: the answers inside the 24 hours are free. The templates are billed by Meta to our WhatsApp account at Meta's
rate for Israel, which the ledger does not know, so it records them at $0.

## Step 4. Instagram and Messenger: built, behind a flag

Both go through the same Meta app as WhatsApp, and stay off until `TORAN_CHANNELS` lists them. Off means their pages
answer 404, Meta's webhook calls about them are acknowledged and dropped, and the website keeps "בקרוב".

**What a store does.** In Settings, under its channels, "לחבר את הדף בפייסבוק" or "לחבר את האינסטגרם". The page lists
what to check first, and the button sends the owner to Meta's login:
- **Messenger:** they log in with the Facebook account that manages the store's Page and approve, and Toran gets the
  Page's token. Someone who manages several Pages picks the store's one.
- **Instagram:** they log in with the store's Instagram professional account (Instagram Login, no Facebook Page
  needed). The token lasts 60 days, and the worker renews it 20 days before it ends.

Either way, Meta is asked to send the account's messages to `/meta/webhook`. Toran answers inside the 24 hours. When
the owner answers from the Page's inbox, Meta Business Suite or the Instagram app, the answer shows in the inbox and
Toran stops answering in that conversation for 12 hours. The login comes back to `/meta/oauth/<channel>`, and Toran
takes it only in the browser that pressed the button, within 15 minutes.

**What you set up once, at Meta** (the same app as step 2, items 1 and 2):
1. **Messenger.** Add the **Messenger** product. Under Facebook Login for Business, Settings:
   - Add `https://toran.openfrequency.co.il/meta/oauth/messenger` to the valid OAuth redirect URIs.
   - Optionally create a configuration with `pages_show_list`, `pages_messaging` and `pages_manage_metadata`, and put
     its id in `META_FB_CONFIG_ID`. Without it, the login asks for those permissions itself.
2. **Instagram.** Add the **Instagram** product with "API setup with Instagram login":
   - Copy the **Instagram app ID** and **Instagram app secret**. They are not the Meta app's.
   - Under "Set up Instagram business login", add the redirect URL `https://toran.openfrequency.co.il/meta/oauth/instagram`.
3. **The webhooks.**
   - **Messenger:** in the app's Webhooks, product **Page**, callback URL `https://toran.openfrequency.co.il/meta/webhook`,
     verify token `META_WEBHOOK_VERIFY_TOKEN`. Subscribe the fields `messages`, `messaging_postbacks` and
     `message_echoes`.
   - **Instagram:** in Instagram, "Configure webhooks", the same URL and token, with the field `messages`.
4. **The app's public details:**
   - privacy policy URL `https://openfrequency.co.il/privacy`
   - terms URL `https://openfrequency.co.il/terms`
   - an icon
   - a data deletion instructions URL
5. **A test Page and Instagram account** of our own, to try it end to end while the app is in development mode. Only
   people with a role on the app can connect until App Review.
6. **`.env`**, then restart:
   ```
   TORAN_CHANNELS=whatsapp,messenger,instagram      # add email too once step 1 is done
   META_FB_CONFIG_ID=<optional, item 1>
   META_IG_APP_ID=<item 2>
   META_IG_APP_SECRET=<item 2>
   PUBLIC_BASE_URL=https://toran.openfrequency.co.il  # already set; the redirect URIs are built from it
   ```
   `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` and `TORAN_SECRETS_KEY` are step 2's, and needed here too.
7. **Try it** with the test Page and account, from a customer's dashboard (a store with a workspace). The operator's
   view under /admin shows the page without the button: the store connects its own accounts.

**App Review** is yours to submit, never Claude's. It covers:
- `pages_messaging`, `pages_manage_metadata` and `pages_show_list` for Messenger
- `instagram_business_basic` and `instagram_business_manage_messages` for Instagram

Check the exact names in the App Review screen. Meta asks for a screen recording of the connect and of a reply.

**Past 24 hours.** Meta allows only a person's answer, tagged `HUMAN_AGENT`, up to 7 days after the customer's last
message. Once Meta approves Human Agent for the app, set `META_HUMAN_AGENT=1`, and the owner's answers from the inbox go
out tagged, up to those 7 days. The agent never answers past 24 hours.

**Then** set Messenger and Instagram to "דמו" or "פעיל" under "ערוצים" on your Settings page, as for email.

## Step 5. A store's automatic messages: built, each off until the store turns it on

The cart, the payment, the shipping and the review request (docs/customer.md, `src/auto/`). They need the store's
orders connected (the key on "מה תורן יודע") and at least one of its own channels: its WhatsApp number (step 2) or
its email (step 1). Never our demo number.

**What you set up once:**
1. **Meta's webhook fields** `message_template_status_update` and `template_category_update` (step 2, item 5), so a
   template's approval reaches Toran within seconds. Without them the worker reads every pending template once an hour.
2. **`PUBLIC_BASE_URL`** on https (already set). The stores' platforms send their webhooks to
   `https://toran.openfrequency.co.il/hooks/<shopify|woocommerce>/<store id>`. Without it Toran reads every 15 minutes.
3. Nothing in Caddy: it passes every path to Toran (deploy/Caddyfile.example). Under accounts' `/admin` prefix
   `/hooks/` answers 404, like the other webhooks.

**What the store does, in Settings, "הודעות אוטומטיות":**
1. **Its WhatsApp templates**, once its number is connected: "לשלוח את התבניות לאישור של Meta". Toran submits seven
   Hebrew templates to the store's own WhatsApp Business Account with the store's token (`POST
   /<WABA>/message_templates`), with the store's name in them:

   | Template | Category | Variables |
   | --- | --- | --- |
   | `toran_cart_reminder` | Marketing, with the footer and a "הסר" button | name, cart link |
   | `toran_order_paid` | Utility | name, order number |
   | `toran_payment_pending` | Utility | name, order number |
   | `toran_payment_failed` | Utility | name, order number, link to pay again |
   | `toran_order_shipped` | Utility | name, order number, tracking link |
   | `toran_order_delivered` | Utility | name, order number |
   | `toran_review_request` | Marketing, with the footer and a "הסר" button | name, order number, review link |

   The words are in `src/auto/messages.ts`, and the page shows each one as the customer will read it. Each template's
   state shows on the page; a kind turns on for WhatsApp only once all of its templates are approved. Meta may approve
   a utility template as marketing (the page says so); it then costs as marketing.
2. **A payment method** on the store's WhatsApp account, in WhatsApp Manager, under billing. Meta bills every template
   the store sends to it.
3. **Instant updates, optional.** Shopify: paste the custom app's **API secret key** (`shpss_...`, the same screen as
   the token, under API credentials). Toran then registers `checkouts/create`, `checkouts/update`, `orders/create`,
   `orders/updated`, `orders/paid`, `fulfillments/create` and `fulfillments/update`, and checks each one's
   `X-Shopify-Hmac-Sha256` with that key. The access token alone cannot sign anything, so without the key Toran reads
   every 15 minutes. `fulfillments/*` need `read_fulfillments` on the app; without it, shipments come from the orders,
   on the readings. WooCommerce: a key with **Read/Write** lets Toran register `order.created` and `order.updated`
   with a secret of its own (`X-WC-Webhook-Signature`); the Read key of "שאלות על הזמנות" cannot, and the page says
   Toran reads every 15 minutes instead. Wix: an API key cannot subscribe to events at all, so Toran reads; the key
   needs "Read Abandoned Checkouts" for cart reminders, and the page says so when it does not have it.
4. **Each kind:** WhatsApp, email or both; the cart's delay; the review's link. Saving turns it on from that moment:
   nothing that happened before is ever sent.

**Consent for the cart and the review** is read from the checkout: Shopify's email and SMS marketing consent (the SMS
one counts for WhatsApp, so the store's checkbox text should say messages may come on WhatsApp), WooCommerce's from
consent plugins that keep it on the order (Mailchimp for WooCommerce and a few common keys), Wix's from the contact's
subscription. Each is kept with its source and time in `auto_consent`.

To check a store's source from the server: `SELECT store_id, platform, can, hooks, polled_at FROM auto_sources;`, and
its messages: `SELECT key, status, why, channel FROM auto_events WHERE store_id = <id> ORDER BY id DESC LIMIT 20;`.

## When a channel is live

- On your Settings page, under "ערוצים", set it to "פעיל". The website drops its "בקרוב" tag within five minutes.
- In each paying store's lead page, set its plan (חנות or חנות גדולה). Only conversations on a store's own channels
  count toward it. The demo number never does.
- Read the first two weeks of each store's conversations with the owner, as the website promises. The customer's
  dashboard shows them the date this ends.
