# Toran (תורן)

A Hebrew-first agent that answers, sells and follows up on an Israeli online store's own WhatsApp number. Part
of the OpenFrequency family, beside Teder.

This repository is **phase 1, the demo machine**:

1. Find Israeli online stores.
2. Build each one a pitch page with a working demo of the agent answering as that store.
3. Let the owner review and approve each page, then send the link by hand.
4. Watch what happens next.

The engine never contacts anyone by itself.

```
lead discovery -> dedupe + platform detection -> score -> ingest -> knowledge pack -> pitch page + demo code
-> owner review -> owner sends the link by hand -> store opens the page -> taps the WhatsApp demo
-> the router binds their phone to that store -> the agent answers as the store -> events -> dashboard
```

## Getting started

```sh
npm install
npm run init-private     # private/.env, the PGlite database
npm test                 # offline, against the fictional store
npm run demo             # the dashboard and a pitch page for the fictional store, no keys needed
```

The audit that chose this stack is [docs/audit.md](docs/audit.md). Decisions are in
[docs/decisions.md](docs/decisions.md).

## The public repo, the private folder

The repository is public. Anything about real stores, leads, conversations, keys or phone numbers lives in
`private/` (gitignored) or the database. The pre-commit hook runs `npm run check:public`, which refuses:

- keys
- databases
- media
- any phone number that is not a fictional one
- the name or domain of any real store the engine has touched
