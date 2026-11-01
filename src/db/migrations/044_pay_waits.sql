-- A phone that asked to pay over WhatsApp (src/channels/pay.ts): it sent a PAY-XXXXXX code from accounts' "pay on
-- WhatsApp" button, Toran answered with the amount and the transfer's details, and for 7 days a photo or a document
-- from that phone is the transfer's receipt, handed to accounts with the code. A new code from the same phone takes
-- the row over. Toran keeps no amount and no bank details here: accounts has them, and records the payment.
--
--   code            the PAY code accounts gave, sent back with the receipt
--   workspace_id    the workspace the code is for, and its name, as accounts said when the code was read
--   expires_at      7 days after the code was read; past it the phone's files go where they went before, and the
--                   worker deletes the row (jobs/worker.ts schedule)
CREATE TABLE IF NOT EXISTS pay_waits (
  phone           text PRIMARY KEY,
  code            text NOT NULL,
  workspace_id    integer NOT NULL,
  workspace_name  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS pay_waits_expires ON pay_waits (expires_at);
