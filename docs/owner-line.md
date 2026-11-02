# The owner line: one WhatsApp number for a Toran store's owners

## Since 2026-11-02: Teder is managed on its dashboard only

The owner decided on 2026-11-02: "managing teder through whatsapp, only through the dashboard. the demo stays". So:

- **Nothing of Teder's goes to WhatsApp.** No post.ready list, reminder, unposted bundle, published note, quota line
  or weekly summary, and no template, whatever `META_TEMPLATES` or `TWILIO_TEMPLATES` say.
  `src/owners/notify.ts` `TEDER_ON_WHATSAPP` is false: `owners/events.ts` ends every `teder_event` and `teder_ready`
  job with `{ skipped: 'teder_on_dashboard' }` before it asks accounts or Teder anything, and `pushToOwner` refuses
  too. Teder's signed events are still checked and acknowledged at `POST /internal/teder/events` (so Teder does not
  retry them), and Teder itself stopped sending them (openfrequency-teder, `src/autonomy/runner.js`).
- **An owner whose workspace has Teder and no Toran store is our support's**, on whichever of our numbers they wrote
  to, exactly as a number nobody linked: `storeChannel()` with our support's account (src/company.ts). Our support's
  status (the website's `src/support.mjs`) says Teder's posts are approved on Teder's dashboard,
  https://teder.openfrequency.co.il. Nothing of theirs is kept on the line (no `owner_numbers` row is touched), so an
  answer the operator writes from our phone lands in that support conversation. Without our support, one line says
  where Teder is managed, at most once an hour: "את המצגות של תדר מאשרים עכשיו רק בלוח הבקרה של תדר: <TEDER_URL>.
  שם גם מתקנים אותן ורואים מה עלה." (`line.ts` `tederHere`).
- **An owner of a Toran store whose workspace also has Teder** keeps the assistant, with Toran's tools only (no
  `teder_` tool, no Teder in the prompt). A reply about Teder's posts that the reader in code understands ("אשר את 1",
  "הצג", "סטטוס", a number past the list) gets that same line, and nothing reaches Teder. "הפסק" is still kept as
  the owner's word (here and in accounts) and answered with where Teder is; "התחל" records no opt-in.
- **A link code** from a workspace with Teder alone is still claimed (accounts no longer makes one for such a
  workspace) and answered with where Teder is managed; with Toran, "אפשר לכתוב לי כאן על החנות."
- **What stays:** the Teder demo by WhatsApp code (channels/request.ts), paying over WhatsApp (channels/pay.ts, read
  before the owner line), our support, and the owner line for a Toran store's owners.

The code for Teder on the line (posts.ts, teder.ts, the teder_ tools in src/assistant, the templates) is kept, unused,
as the record of what it did. The rest of this document describes the line as it was built; where it speaks of Teder
on WhatsApp, the section above wins.

## How the line was built

A business owner writes to one WhatsApp number (`TORAN_ASSISTANT_WA`) and talks to their assistant about Toran (the
store's conversations), Teder (the posts waiting for approval), or both, whichever their workspace has. Until
2026-11-02 Teder wrote to them on the same number when posts were ready, when it was time to post, when the month's
quota ran low, and once a week. Three services take part:

```
            the owner's phone
                  │  ▲
     WhatsApp     │  │  replies, and Teder's news (a template outside the 24 hours)
                  ▼  │
   ┌──────────── Toran ─────────────┐
   │ the owner line (src/owners/)   │── GET/POST /internal/owner-phone* ──▶  accounts  (who the number is)
   │                                │── signed /internal/assistant/* ────▶  Teder     (the posts)
   │ POST /internal/teder/events ◀──┼── signed events ───────────────────  Teder
   └────────────────────────────────┘
```

Everything here is between services on one machine. No route in this document is reachable through Caddy.

## 1. Accounts: who a WhatsApp number is

A phone number belongs to one user in one workspace. Accounts never sends anything to a phone. The number proves
itself by writing: the customer asks accounts for a link code, sends it from their WhatsApp to the owner line, and
Toran tells accounts which number sent it (the same pattern as the website's demo requests).

### The flow

1. On their home page in accounts, a customer (`client_owner` or `client_member`) of a workspace with Toran taps
   "לחבר את הוואטסאפ". Until 2026-11-02 the form had one checkbox, whether they agree to get Teder's and Toran's
   updates on WhatsApp (the opt-in, kept with its time); the updates were Teder's alone, so the box went with them,
   and a workspace with Teder alone has no link form (openfrequency-accounts' docs/internal-owner-phone.md).
2. Accounts makes a code `LINK-XXXXXX` (6 of `ABCDEFGHJKMNPQRSTUVWXYZ23456789`), good for 30 minutes and for one use.
   It shows the code and a `https://wa.me/<OF_ASSISTANT_WA>?text=LINK-XXXXXX` button.
3. The customer sends it. Toran calls `POST /internal/owner-phone/claim` with the code and the number that sent it.
   Accounts links the number to that user and workspace, marks it verified now, and copies the opt-in with its time.
4. The home page lists the linked numbers, and each one can be removed. (Until 2026-11-02 its updates could be turned
   on or off there too, an opt-in with its time and the source `accounts`.)

### Tables (accounts)

```
phone_links  code PK, user_id, workspace_id, opt_in (0/1), created_at, expires_at, used_at, used_phone
user_phones  phone PK (international digits), user_id, workspace_id, verified_at, opt_in_at, opt_in_source,
             opt_out_at, opt_out_source, created_at
```

A removed number is deleted from `user_phones`. The `audit` table records the removal, the link and every consent
change.

### Routes (accounts' internal listener, 127.0.0.1:4741)

All of them take the same `Authorization: Bearer <OF_INTERNAL_TOKEN>`, loopback and Host checks as
`/internal/session`. Every answer is JSON with `Cache-Control: no-store`. A phone is international digits only
(`972500000123`), and anything else is `400 bad_phone`.

**The owner object** (every route below answers with it):

```json
{
  "phone": "972500000123",
  "verifiedAt": "2026-10-24T09:00:00.000Z",
  "user": { "id": 12, "name": "Dana", "email": "dana@example.com" },
  "workspace": { "id": 3, "slug": "dana-shop", "name": "Dana Shop", "disabled": false },
  "role": "client_owner",
  "products": ["teder", "toran"],
  "optIn": { "at": "2026-10-24T09:00:00.000Z", "source": "accounts" },
  "optOut": null
}
```

- `products` is the workspace's enabled products.
- `optIn` is null when they never agreed.
- `optOut` is `{ "at", "source" }` when the later of the two is an opt-out. Exactly one of `optIn` and `optOut` speaks
  for now: the later one.
- `workspace.disabled` true means nothing may be done for this number. Toran treats it as not linked.

| Route | Answers |
|---|---|
| `GET /internal/owner-phone?phone=<digits>` | `200` the owner, `404 not_linked` |
| `GET /internal/owner-phones?workspace=<id>` | `200 { "phones": [owner, ...] }` (verified numbers only, possibly empty) |
| `POST /internal/owner-phone/claim` with `{ "code": "LINK-XXXXXX", "phone": "<digits>" }` | `200` the owner; `404 unknown_code`; `410 expired`; `409 used` (the code was used); `409 phone_taken` (the number belongs to another workspace) |
| `POST /internal/owner-phone/consent` with `{ "phone": "<digits>", "optIn": true\|false, "source": "whatsapp" }` | `200` the owner; `404 not_linked` |

Claiming a number that is already linked to the same user and workspace just verifies it again and keeps the code's
opt-in choice. A number linked to another workspace is `409 phone_taken`, and it has to be removed there first.

## 2. Teder: its assistant API

Teder defines this side, in openfrequency-teder's `docs/assistant-api.md` (`src/assistant/`), and that document
is the contract. In short:

- **Requests:** Toran calls `/internal/assistant/customers/<workspace>/...` on Teder's own port (`TEDER_INTERNAL`,
  default `http://127.0.0.1:4700`):
  - `posts/pending`, `status`, `posts/<id>/bundle`
  - `posts/<id>/approve`, `posts/<id>/reject` (`reason`, `freeText`), `posts/<id>/edit` (`slide`, `field`, `newText`)

  Every change names the person in `by` (`{ name, userId }`, from accounts), and Teder records it as theirs.
- **Signing**, both ways, with `OF_ASSISTANT_SECRET`:

  ```
  X-OF-Signature: t=<unix seconds>,n=<nonce>,s=<hex HMAC-SHA256>
  ```

  It is over six lines: the direction (`toran->teder` for a request, `teder->toran` for an event), t, the nonce, the
  method, the path with its query, and the body's SHA-256. A t more than 300 seconds off, or a nonce seen again, is
  refused.
- **Events:** Teder sends them to `POST /internal/teder/events` as `{ id, type, at, sentAt, customer, data }`.
  - The types are post.ready (one post each), post.reminder, post.published, post.unposted, quota.low and
    weekly.summary.
  - Teder holds them through the customer's quiet hours and Shabbat, and lets the customer turn each type off on its
    Settings page. Toran sends what arrives.
- **Slide images:** signed links that work for 24 hours.

Toran maps an owner's "line 1 / line 2" of a slide to Teder's fields. On the cover, line 1 is `hook` and line 2 is
`sub`. On any other slide, line 1 is `title` and line 2 is `body`. The last slide is not editable.

## 3. Toran: the line

`src/owners/`:

| File | What it does |
|---|---|
| `identity.ts` | The accounts client for the routes above. A number is asked about live on every message. If accounts cannot be reached, nobody is an owner (fail closed). |
| `teder.ts` | The signed Teder client and the signature check on events |
| `intents.ts` | Owner replies about posts read in code: approve, reject (with a reason), shorter, edit a line, show, the bundle, every post, "all but". A message the parser does not wholly understand goes to the model. |
| `line.ts` | One message from an owner's number, end to end, in order: identity (an owner with Teder and no Toran store goes to our support here), the rate limit, the disclosure, "הפסק" and "התחל", Toran's pending "כן", the parser (a reply about Teder's posts is told where the dashboard is), then the model with Toran's tools |
| `notify.ts` | Off since 2026-11-02 (`TEDER_ON_WHATSAPP`). The only place Toran wrote to someone who did not just write. It sends only to a verified number that opted in and did not opt out, within the per-number limit (Teder already held its events through quiet time). Inside the 24 hours it sends text and images; outside them it sends an approved template only. Every attempt is recorded in `owner_notifications`, whatever happened to it. |
| `posts.ts` | What the line does with posts: show the posts waiting (and keep their order), act on numbered ones, send one ready to post, say the status. The reader in code and the model's tools both use it. |
| `events.ts` | The text and images for each Teder event. Teder's post.ready events, one per post, are gathered for 90 seconds and sent as one numbered list of everything waiting. |
| `templates.ts` | The utility templates, as submitted to Meta (docs/whatsapp-templates.md), and what each is sent by on the provider in use |

**The number itself: Twilio or Meta.** The line is `TORAN_ASSISTANT_WA` either way. On Twilio, Twilio's webhook brings
its messages and Twilio sends the answers, from the line's number, with each template's Content SID
(`TWILIO_TEMPLATES`). Once `META_OWNER_PHONE_ID` names its Meta number id, Meta's `/meta/webhook` brings them instead.
The router (`src/channels/route.ts`) sends them to the same `ownerLine()` before any store's account is looked at. The answers, the images,
Teder's news and the inbox's replies to our support go out through the Cloud API from that number
(`src/channels/lines.ts`, with `META_SYSTEM_TOKEN` or the token sealed when the number was connected). A template goes
by its own name, in Hebrew, its body's variables in order, and only once `META_TEMPLATES` lists it as approved.
Otherwise it is skipped as `no_template`, as on Twilio without a SID. The setup is in docs/connecting-channels.md,
step 3.

**On our own number** (docs/company.md, "Toran on our own number"): the line is OpenFrequency's one number, which is
also the demo number and our support. A verified owner's message there reaches the same `ownerLine()`, and Teder's
news and templates leave from that number. When the operator answers an owner from our phone, the answer is kept in
the owner's chat and the assistant waits 12 hours (`owner_numbers.agent_paused_until`), except for "הפסק" and "התחל".

**Numbers belong to the list the owner last saw.** When Toran shows posts, it keeps their order (`owner_lists`),
and "1" means the first one shown. The model names a post by that number, never by Teder's id. An approval or a
rejection of a number is refused in code unless the owner's message names that number (or "all", or there was only
one post).

**The owner's words act at once.** "אשר את 1 ו-3" approves, and the answer says what was done. These are
the owner's own instructions about their own posts, and Teder's dashboard acts on one click the same way. What
still waits for "כן" is Toran's offer to write to one of the store's customers.
