-- Toran on our own number (channels/lines.ts oneNumber, docs/company.md): the operator answers from the WhatsApp
-- Business app on our phone, and each answer lands where that person is talking (channels/waStore.ts lineEcho). In a
-- demo or support conversation the agent steps back through conversations.agent_paused_until, as on a store's own
-- number. A business owner talking to their assistant has no conversation row, so the pause is kept on their number:
-- until then, the assistant keeps the owner's messages and does not answer (owners/line.ts).
ALTER TABLE owner_numbers ADD COLUMN agent_paused_until timestamptz;
