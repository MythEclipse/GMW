// bun test preload — replicates the env block from the old vitest.config.ts.
// Runs before any test module imports, so the config singleton (which reads
// process.env at import time) gets the same test values it had under vitest.
process.env.DISCORD_TOKEN = "test-discord-token";
process.env.DATABASE_URL = "postgres://localhost:6432/test";
process.env.AI_ANALYSIS_ENABLED = "true";
process.env.AI_LLM_API_KEY = "sk-test";
// Deterministic exclusion list so the capture-filter tests do not depend on
// the host environment.
process.env.EXCLUDED_CHANNEL_IDS = "blocked-chan,blocked-chan-2";
