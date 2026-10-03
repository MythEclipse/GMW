-- Add messages.ai_analysis_duration_ms, which the Drizzle schemas in BOTH the
-- gateway and the backend declare and the backend SELECTS on every message-feed
-- read, but which no migration in 0000-0024 ever created.
--
-- How it stayed invisible: production's database has carried the column since
-- some out-of-band change, so every read succeeded there. A database built
-- purely from the migration chain never had it. Migration 0021 already hit this
-- and worked around it by not reading the column -- its comment says so
-- explicitly -- but the backend's SELECT was never given the same treatment, so
-- the first read against a chain-built database failed with:
--
--   ERROR 42703 errorMissingColumn  (oRPC WS -> "internal server error")
--
-- The reset exposed it. Creating the column is the correct fix rather than
-- dropping it from the two schemas: it is real data (how long the model took),
-- both schemas declare it, and the frontend types read it.
--
-- Nullable, no default: legacy rows genuinely have no measured duration, and a
-- fabricated 0 would read as "instant" in the UI.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_analysis_duration_ms bigint;
