-- Add verdicts.action: the disposition the MODEL chose, as a first-class field.
--
-- Why this column rather than more prose in `analysis`: the moderation worker
-- (a separate process) parses the model's verdict and persists it; the
-- auto-delete enforcer (a different process) reads the row back and acts on
-- it. `action` is the only channel between them that is a named value rather
-- than a sentence. Before this, the enforcer had to infer "delete the message"
-- vs "reset the nickname" from the model's prose, which is how a verdict that
-- correctly said "Nickname mengandung sindiran pribadi; isi pesan bersih"
-- still produced action_type=delete_message — the message died, the name
-- survived.
--
-- Three values, and the model may emit no others:
--   clean           — no violation (also what a doubtful model should say)
--   delete_message  — the message content itself violates
--   reset_nickname  — only the name violates; the message is kept
--
-- Nullable on purpose, with no default and no CHECK constraint:
--   * NULL is what an `error` verdict stores ("could not judge" names no
--     action), and the enforcer reads NULL as "fall back to status".
--   * Legacy rows have no action. The enforcer's fallback keeps them behaving
--     exactly as before, so this migration needs no backfill and no
--     coordination with a running deploy.
-- A CHECK constraint is deliberately NOT added: the enforcer re-validates the
-- value on read (it trusts nothing written by another process), and a
-- constraint here would only turn a bad value into a failed insert during a
-- deploy instead of a logged override.

ALTER TABLE verdicts
  ADD COLUMN IF NOT EXISTS action text;