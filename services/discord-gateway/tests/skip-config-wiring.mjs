/**
 * Does the env var actually reach the worker?
 *
 * The e2e test injects `skipChannelIds` directly, which proves the worker's
 * behaviour but NOT the wiring. If `AI_SKIP_ANALYSIS_CHANNEL_IDS` were never
 * passed (or the production entry point forgot it), the channel would be
 * moderated in production and every unit test would still pass — the same
 * class of failure as the lease assertion, which existed and did not cover the
 * vision pre-pass.
 *
 * So this reads the real config singleton with the real env var set, and checks
 * the same wiring moderation-worker.ts performs.
 *
 * Run: bun tests/skip-config-wiring.mjs
 */
const CHANNEL = "1308392257975488593";
// The spacing is deliberate and must be exercised: this list is hand-edited
// as a CI secret, and `a, b` is how a human writes it.
process.env.DISCORD_TOKEN = "test-token";
process.env.AI_SKIP_ANALYSIS_CHANNEL_IDS = `${CHANNEL}, 111222333444555666 ,`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  const { config } = await import("../src/shared/config/index.ts");

  check(
    "the env var reaches the config singleton",
    Array.isArray(config.AI_SKIP_ANALYSIS_CHANNEL_IDS),
    JSON.stringify(config.AI_SKIP_ANALYSIS_CHANNEL_IDS),
  );
  check(
    "it is split on commas",
    config.AI_SKIP_ANALYSIS_CHANNEL_IDS.length === 2,
    JSON.stringify(config.AI_SKIP_ANALYSIS_CHANNEL_IDS),
  );
  check(
    "the real channel id is in it",
    config.AI_SKIP_ANALYSIS_CHANNEL_IDS.includes(CHANNEL),
  );
  // Whitespace is the realistic mistake when hand-editing an env file, and an
  // untrimmed id would silently match nothing.
  check(
    "entries are trimmed, so a trailing space still matches",
    config.AI_SKIP_ANALYSIS_CHANNEL_IDS.every((id) => id === id.trim()),
    JSON.stringify(config.AI_SKIP_ANALYSIS_CHANNEL_IDS),
  );
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.stack ?? e.message}`);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
