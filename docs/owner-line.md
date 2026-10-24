# The owner line: one WhatsApp number for Toran and Teder

A business owner writes to one WhatsApp number (`TORAN_ASSISTANT_WA`) and talks to their assistant about Toran (the
store's conversations), Teder (the posts waiting for approval), or both, whichever their workspace has. Teder writes
to them on the same number when posts are ready, when it is time to post, when the month's quota runs low, and once
a week. Three services take part:

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

1. On their home page in accounts, a customer (`client_owner` or `client_member`) taps "לחבר את הוואטסאפ". The form
   has one checkbox: whether they agree to get Teder's and Toran's updates on WhatsApp. This is the opt-in, kept with
   its time.
2. Accounts makes a code `LINK-XXXXXX` (6 of `ABCDEFGHJKMNPQRSTUVWXYZ23456789`), good for 30 minutes and for one use.
   It shows the code and a `https://wa.me/<OF_ASSISTANT_WA>?text=LINK-XXXXXX` button.
3. The customer sends it. Toran calls `POST /internal/owner-phone/claim` with the code and the number that sent it.
   Accounts links the number to that user and workspace, marks it verified now, and copies the opt-in with its time.
4. The home page lists the linked numbers. Each one can be removed, and its updates turned on or off. Turning them on
   counts as an opt-in, with its time and the source `accounts`.

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

## 2. Teder: the posts, for the assistant

### Signing (both directions)

One secret, `OF_ASSISTANT_SECRET` (32 characters or more), is set in Teder's and Toran's `.env` to the same value.
While it is unset or short, the routes answer `503 not_configured` and nothing is sent. Every request carries:

```
X-OF-Timestamp: <unix seconds>
X-OF-Signature: v1=<hex HMAC-SHA256(secret, "v1\n" + ts + "\n" + METHOD + "\n" + pathWithQuery + "\n" + sha256hex(rawBody))>
```

`rawBody` is the empty string for a GET. The receiver refuses a timestamp more than 300 seconds away from its clock
(`401 stale`) and a signature that does not match (`401 bad_signature`, compared in constant time). It also refuses a
request with `X-Forwarded-For`, or one from a socket that is not loopback (`403 not_local`).

### Teder's internal listener: 127.0.0.1:`TEDER_INTERNAL_PORT` (default 4701), JSON in and out

It is a separate listener, never proxied, in the same process as Teder's site. Toran reaches it at
`TEDER_INTERNAL` (default `http://127.0.0.1:4701`). Every route is scoped to one accounts workspace: a post of
another workspace is `404 not_found`, exactly like one that does not exist. A workspace that has no Teder account is
`404 no_teder`.

Every POST body carries `actor` (who asked, e.g. `wa:972500000123`). Teder records it as `approved_by`, in `edits`
and in its audit.

**A post, as listed:**

```json
{ "id": 812, "number": null, "account": { "id": "dana-shop", "name": "דנה שופ" }, "status": "queued",
  "hook": "5 טעויות בבחירת נעלי ריצה", "slotAt": "2026-10-25T07:00:00.000Z", "slides": 7,
  "cover": { "url": "https://teder.openfrequency.co.il/m/<token>.jpg" } }
```

`number` is always null: Toran numbers the posts it shows, never Teder. `cover.url` and every image URL below are
signed links that work without a session for 7 days (`GET /m/<token>.jpg` on Teder's public site, the token being
the post, the platform, the slide index and the expiry, HMAC-signed with `SESSION_SECRET`). WhatsApp fetches them
from Meta's servers.

| Route | Answers |
|---|---|
| `GET /internal/assistant/status?workspace=<id>` | `200 { "workspace": 3, "accounts": [{ "id", "name", "mode", "status" }], "pending": 3, "approvedThisWeek": 4, "publishedThisWeek": 5, "quota": { "month": "2026-10", "suggested": { "used": 31, "limit": 40 }, "redos": { "used": 8, "limit": 10 } }, "quiet": { "now": false, "until": null, "reason": null }, "quietHours": { "start": "22:00", "end": "08:00" }, "shabbat": true }` |
| `GET /internal/assistant/posts?workspace=<id>&status=queued` | `200 { "posts": [post, ...] }`, oldest slot first. `status` is optional, default `queued` (waiting for approval). |
| `GET /internal/assistant/posts/<id>?workspace=<id>` | `200 { "post": post + { "caption", "hashtags": [...], "slideList": [{ "idx": 1, "kind": "cover", "lines": ["...", "..."], "image": { "url" } }] } }` |
| `POST /internal/assistant/posts/<id>/approve` with `{ workspace, actor }` | `200 { "post": { "id", "status": "approved" } }`; `409 not_pending` |
| `POST /internal/assistant/posts/<id>/reject` with `{ workspace, actor, reason: "topic"\|"shorter"\|"tone"\|"photo"\|"other", note }` | `200 { "post": { "id", "status": "rejected" }, "replacement": { "id", "status": "drafting" } \| null, "redosLeft": 2 }`; `409 not_pending`. A rejection writes a replacement while redos are left, the same way the dashboard's reject does. |
| `POST /internal/assistant/posts/<id>/edit` with `{ workspace, actor, slide: 1-based, line: 1-based, text }` | `200 { "post": post, "slide": { "idx", "lines", "image": { "url" } } }` after the checks and the re-render; `422 failed_checks { "problems": ["..."] }`; `409 not_pending`; `400 bad_line` |
| `GET /internal/assistant/posts/<id>/bundle?workspace=<id>` | `200 { "post": { "id", "hook" }, "images": [{ "url" }, ...], "caption": "the caption to copy, hashtags included" }`, the Instagram set |

A slide's `lines` are its title line first, then its body's lines. `edit` with `line: 1` changes the title, and
`line: k` changes the body's line `k-1`.

`quiet` says whether a message to the owner may go out now. `now: true` comes with `until` (the end of the quiet
time) and `reason`:
- `shabbat`: the workspace's `shabbat` setting is on (the default), and it is Shabbat or a holiday by Teder's own
  calendar (`restAt`).
- `quiet_hours`: the time is inside the workspace's quiet hours (default 22:00 to 08:00, Israel time).

Both settings are on Teder's settings page, per workspace.

### Events: Teder → Toran

Teder writes each event to an outbox table and posts it to `TORAN_INTERNAL` (default `http://127.0.0.1:4710`)
`/internal/teder/events`, signed as above. It retries with backoff (1, 5, 15, 60 minutes, then hourly) for 24 hours
on anything but a `2xx`. Toran answers `200 { "ok": true }` to an event it already has.

```json
{ "id": "evt_3f2a...", "type": "post.ready", "workspace": 3, "at": "2026-10-24T09:00:00.000Z", "data": { ... } }
```

| `type` | When | `data` |
|---|---|---|
| `post.ready` | At the end of a run that queued posts for approval, one event per workspace | `{ "posts": [post, ...] }` (the ones queued in that run) |
| `post.reminder` | When an approved post's slot comes and the owner posts it themselves (a draft) | `{ "post": post, "platform": "tiktok" }` |
| `post.unposted` | When the slot passed and the post was not published | `{ "post": post, "platform": "instagram" }` (Toran fetches the bundle) |
| `quota.low` | Once a month per kind, when the suggestions used reach 80% of the limit, or 2 redos are left | `{ "kind": "suggested"\|"redos", "used": 32, "limit": 40, "month": "2026-10" }` |
| `weekly.summary` | Sunday 09:00 Israel time, for the 7 days before | `{ "from": "2026-10-18", "to": "2026-10-24", "made": 9, "approved": 7, "rejected": 2, "published": 6, "expired": 0, "pending": 1, "quota": { ...as in status } }` |

## 3. Toran: the line

`src/owners/`:

| File | What it does |
|---|---|
| `identity.ts` | The accounts client for the routes above. A number is asked about live on every message. If accounts cannot be reached, nobody is an owner (fail closed). |
| `teder.ts` | The signed Teder client and the signature check on events |
| `intents.ts` | Owner replies about posts read in code: approve, reject (with a reason), shorter, edit a line, show, the bundle, every post, "all but". A message the parser does not wholly understand goes to the model. |
| `line.ts` | One message from an owner's number, end to end, in order: identity, "הפסק" and "התחל", the rate limit, the disclosure, Toran's pending "כן", the parser, then the model with Toran's tools and Teder's |
| `notify.ts` | The only place Toran writes to someone who did not just write. It sends only to a verified number that opted in and did not opt out, outside Teder's quiet time and within the per-number limit. Inside the 24 hours it sends text and images; outside them it sends an approved template only. Every attempt is recorded in `owner_notifications`, whatever happened to it. |
| `posts.ts` | What the line does with posts: show the posts waiting (and keep their order), act on numbered ones, send one ready to post, say the status. The reader in code and the model's tools both use it. |
| `events.ts` | The text and images for each Teder event |
| `templates.ts` | The utility templates, as submitted to Meta (docs/whatsapp-templates.md) |

**Numbers belong to the list the owner last saw.** When Toran shows posts, it keeps their order (`owner_lists`),
and "1" means the first one shown. The model names a post by that number, never by Teder's id. An approval or a
rejection of a number is refused in code unless the owner's message names that number (or "all", or there was only
one post).

**The owner's words act at once.** "אשר את 1 ו-3" approves, and the answer says what was done. These are
the owner's own instructions about their own posts, and Teder's dashboard acts on one click the same way. What
still waits for "כן" is Toran's offer to write to one of the store's customers.
