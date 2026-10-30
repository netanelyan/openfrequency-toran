-- The message path holds up when something fails (the readiness audit's PRA-BE-001, -002, -003, -005, -006, -008,
-- PRA-DB-005, -006 and -007; jobs/queue.ts, jobs/worker.ts, channels/conversations.ts, jobs/retention.ts):
--
--   jobs.locked_by       the boot that claimed a running job: a job another boot left running goes back to the queue at
--                        start, and a live job's locked_at is refreshed every minute, so the lease can be minutes, not 15
--   messages.reply_to    on the agent's answer, the ext_id of the customer message it answers: a job run again after a
--                        failed send finds the answer it already wrote, and sends what did not go out (delivery holds the
--                        id of each part as it goes), with no model call
--   owner_inbound        the same for the owner line: the answer is kept before it is sent, and marked when it went out
--   store_spend          each store's spend this month, kept as each usage row is written: the store's own cap reads one
--                        row, not the usage table
--   stores.service_stopped_at   the day a store's service stopped (no channel left, taken down, or its workspace's
--                        Toran off): its customers' conversations are deleted 30 days later, as the terms say
--   auto_events.sending_at      when an automatic message was taken to be sent: one still "sending" ten minutes on was
--                        stopped by a restart, and is marked failed, never sent again by itself
--
-- One open conversation per customer of an account (and per phone on a demo store): the lookup and the insert are one
-- step under an advisory lock (conversations.ts), and these partial unique indexes are the second guard. Email keeps
-- one conversation per thread, so it is not in them. A conversation silent for 7 days is closed when the customer
-- writes again (a new one starts, as before), and by the daily pass after 14; the ones open now that are older than
-- that, or doubled, are closed here first.
ALTER TABLE jobs ADD COLUMN locked_by text;
ALTER TABLE messages ADD COLUMN reply_to text;
CREATE INDEX messages_reply_to ON messages (reply_to) WHERE reply_to IS NOT NULL;
ALTER TABLE owner_inbound ADD COLUMN reply jsonb;
ALTER TABLE owner_inbound ADD COLUMN delivered_at timestamptz;
ALTER TABLE stores ADD COLUMN service_stopped_at timestamptz;
ALTER TABLE stores ADD COLUMN service_stopped_why text;            -- channels | taken_down | plan
ALTER TABLE auto_events ADD COLUMN sending_at timestamptz;

CREATE TABLE store_spend (
  store_id  integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  month     text NOT NULL,                       -- Israel's calendar month, "2026-10"
  usd       numeric(12,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, month)
);
INSERT INTO store_spend (store_id, month, usd)
  SELECT store_id, to_char(at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM'), SUM(usd) FROM usage
   WHERE store_id IS NOT NULL AND at >= now() - interval '40 days' GROUP BY 1, 2 HAVING SUM(usd) > 0;

-- The month's total for the global cap reads a range of the usage table by time alone.
CREATE INDEX usage_at ON usage (at);

-- The echo checks (channels/waStore.ts, socialStore.ts): one of our own sends coming back is found by its id in a
-- message's delivery, or in an event's data, without reading either table whole.
CREATE INDEX messages_delivery ON messages USING gin (delivery jsonb_path_ops);
CREATE INDEX events_data_id ON events ((data->>'id')) WHERE kind IN ('wa_out', 'owner_reply');
CREATE INDEX events_data_echo ON events ((data->>'echo')) WHERE kind = 'owner_reply';
-- The per-store hourly counts (channels/store.ts): a store's inbound messages, by kind and time.
CREATE INDEX conversations_started ON conversations (store_id, started_at);

UPDATE conversations SET closed_at = last_at + interval '7 days'
 WHERE closed_at IS NULL AND channel <> 'email' AND peer IS NOT NULL AND last_at < now() - interval '7 days';
UPDATE conversations c SET closed_at = now()
 WHERE c.closed_at IS NULL AND c.channel <> 'email' AND c.peer IS NOT NULL AND EXISTS (
   SELECT 1 FROM conversations d WHERE d.closed_at IS NULL AND d.channel = c.channel AND d.peer = c.peer AND d.id <> c.id
      AND d.store_id = c.store_id AND d.account_id IS NOT DISTINCT FROM c.account_id
      AND (d.last_at > c.last_at OR (d.last_at = c.last_at AND d.id > c.id)));
CREATE UNIQUE INDEX conversations_open_account ON conversations (account_id, peer) WHERE closed_at IS NULL AND account_id IS NOT NULL AND channel <> 'email';
CREATE UNIQUE INDEX conversations_open_demo ON conversations (store_id, channel, peer) WHERE closed_at IS NULL AND account_id IS NULL AND peer IS NOT NULL;
