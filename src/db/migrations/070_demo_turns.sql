-- A demo on our WhatsApp number is 10 answers (the owner, 2026-11-09: "make a demo on whatsapp have 10 messages. count
-- each message, show it in the footer דמו של תורן (1/10)"). wa_users.turns counts the answers given since the phone was
-- bound to its store; a new code starts again from 0, and after the tenth the binding goes and our support answers that
-- phone (channels/demo.ts).

ALTER TABLE wa_users ADD COLUMN turns integer NOT NULL DEFAULT 0;
