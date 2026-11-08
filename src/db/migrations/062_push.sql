-- Web push to the owner's browser, as Teder's (src/owners/push.ts; TORAN-READINESS.md P1-11; the owner, 2026-11-08: Toran
-- ready for customers like Teder). A browser that asked (Settings) is woken with an empty push when a conversation
-- starts waiting; its service worker asks Toran, behind the owner's session, what to show. Nothing about a customer's
-- message travels through the push service.
--
--   push_subs       one row a browser: its endpoint, who asked, in which workspace (null: the operator, every store)
--   notifications   what was said, kept whether or not a browser was there: the service worker shows the newest one of
--                   the session's workspace
CREATE TABLE push_subs (
  id            serial PRIMARY KEY,
  endpoint      text NOT NULL UNIQUE,
  user_id       integer,
  workspace_id  integer,
  failed        integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subs_workspace ON push_subs (workspace_id);

CREATE TABLE notifications (
  id            serial PRIMARY KEY,
  workspace_id  integer,
  store_id      integer REFERENCES stores(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  url           text NOT NULL DEFAULT '/',
  pushed        integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_workspace ON notifications (workspace_id, id DESC);
