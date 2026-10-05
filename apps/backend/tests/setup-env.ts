// bun test preload — the single env block for BOTH suites (tests/ and
// tests-gateway/).
//
// bunfig.toml names exactly one preload path, so before the merge each app had
// its own: the backend's was a no-op and the gateway's set the values below.
// Keeping only the no-op one left 17 gateway tests failing on
// `DISCORD_TOKEN: expected string, received undefined` — the config singleton
// reads process.env at import time, so the preload ordering IS the mechanism.
//
// Values are all synthetic. DATABASE_URL points at a port nothing serves, so a
// test that accidentally opens a pool fails loudly instead of touching a real
// database.
process.env.DISCORD_TOKEN = "test-discord-token"
process.env.DATABASE_URL = "postgres://localhost:6432/test"
process.env.AI_ANALYSIS_ENABLED = "true"
process.env.AI_LLM_API_KEY = "sk-test"

// loadConfig() refuses to boot when NODE_ENV=production and MUTATION_TOKEN is
// missing or under 16 chars. This shell exports NODE_ENV=production, so without
// this line every test importing the config singleton dies at import time —
// which reads as a config bug rather than an env-setup one. Synthetic and ≥16
// chars, satisfying the production rule instead of bypassing it.
process.env.MUTATION_TOKEN = "test-mutation-token-0123456789"
// Deterministic exclusion list so the capture-filter tests do not depend on
// the host environment.
process.env.EXCLUDED_CHANNEL_IDS = "blocked-chan,blocked-chan-2"

// The schema asserts at parse time that the claim lease outlives the worst-case
// batch (ceil(batch / vision concurrency) vision waves + the LLM call). Under
// test that arithmetic must hold or EVERY test that imports the config singleton
// throws before its first assertion, which reads as a config bug rather than a
// lease-arithmetic bug.
process.env.AI_ANALYSIS_PROCESSING_TIMEOUT_MS = "1500000"
