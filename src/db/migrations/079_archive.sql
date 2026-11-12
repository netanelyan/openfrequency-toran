-- The inbox's archive (the owner, 2026-11-12: "Add an options to archive chats, and archive them automatically 5 days
-- after inactivity"; web/inbox.ts ARCHIVED_SQL). A conversation is in the archive when the owner put it there and nothing
-- came since, or when it has been silent for five days and waits for no one; a new message brings it back.
--
--   conversations.archived_at    when the owner put it in the archive by hand (which also marks it handled)
--   conversations.unarchived_at  when the owner took it out by hand: its five days count again from then
ALTER TABLE conversations ADD COLUMN archived_at timestamptz;
ALTER TABLE conversations ADD COLUMN unarchived_at timestamptz;
