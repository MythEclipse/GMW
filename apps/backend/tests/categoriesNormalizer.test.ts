import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the `moderation_actions.categories` normalizer.
 *
 * WHY THIS EXISTS
 * The column is `text` and has been written in two different shapes:
 *   `["gambling","scam"]`  (JSON array)  and  `harassment` / `a, b`  (bare)
 * 172 of 1403 live rows use the bare shape. Both `getTrends` and
 * `getByCategory` used to cast it with `::jsonb`, which aborts the ENTIRE
 * query on the first bad row — so a whole table became unreadable and both
 * procedures returned HTTP 500 on every call.
 *
 * These tests pin the normalizer's contract without a database: the SQL must
 * stay cast-free (a `::jsonb` anywhere in it reintroduces the 500) and must
 * cover both storage shapes plus junk that would break a naive cast.
 */

const repoPath = fileURLToPath(
  new URL(
    "../src/modules/moderation/moderation.repository.ts",
    import.meta.url,
  ),
);
const rawSource = readFileSync(repoPath, "utf8");

/** Strip comments so prose explaining a past bug can't fail the assertions. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const source = stripComments(rawSource);

/** Pull the `CATEGORIES_TXT_ARRAY` constant out of the module source. */
function extractNormalizer(): string {
  const start = source.indexOf("const CATEGORIES_TXT_ARRAY = `");
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf("`", start) + 1;
  const close = source.indexOf("`", open);
  return source.slice(open, close);
}

const NORM = extractNormalizer();

describe("categories normalizer SQL", () => {
  it("is present and reusable", () => {
    expect(NORM.length).toBeGreaterThan(0);
  });

  it("performs NO jsonb cast — a cast is what made the query abort", () => {
    // `::jsonb` and `jsonb_array_elements_text(<col>::jsonb)` are the two
    // shapes that raise "invalid input syntax for type json".
    expect(NORM).not.toContain("::jsonb");
    expect(NORM).not.toContain("jsonb_array_elements_text");
  });

  it("uses cast-free text functions only", () => {
    expect(NORM).toContain("regexp_matches");
    expect(NORM).toContain("regexp_split_to_array");
  });

  it("prefers quoted tokens so a JSON array yields its members, not one string", () => {
    // The quoted-token branch must come first in the COALESCE.
    const quotedAt = NORM.indexOf("regexp_matches");
    const splitAt = NORM.indexOf("regexp_split_to_array");
    expect(quotedAt).toBeGreaterThan(-1);
    expect(splitAt).toBeGreaterThan(-1);
    expect(quotedAt).toBeLessThan(splitAt);
  });

  it("maps an empty/blank cell to NULL rather than ['']", () => {
    // NULLIF against ARRAY[''] is what prevents a phantom empty category.
    expect(NORM).toContain("ARRAY['']");
  });
});

describe("categories normalizer is used everywhere categories are queried", () => {
  it("getTrends aggregates through the normalizer", () => {
    const body = source.slice(
      source.indexOf("async getTrends"),
      source.indexOf("async getTopFlaggedDomains"),
    );
    expect(body).toContain("CATEGORIES_TXT_ARRAY");
    expect(body).not.toContain("categories::jsonb");
  });

  it("getByCategory filters through the normalizer", () => {
    const body = source.slice(
      source.indexOf("async getByCategory"),
      source.indexOf("async getCoverage"),
    );
    expect(body).toContain("CATEGORIES_TXT_ARRAY");
    expect(body).not.toContain("categories::jsonb");
  });

  it("no method casts the categories column any more", () => {
    expect(source).not.toContain("categories::jsonb");
  });
});

describe("getTopFlaggedDomains reads content from messages", () => {
  it("does not reference the nonexistent moderation_actions.content column", () => {
    const body = source.slice(
      source.indexOf("async getTopFlaggedDomains"),
      source.indexOf("async getTopFlaggedChannels"),
    );
    // a.content never existed; the message body lives on messages.content.
    expect(body).not.toContain("a.content");
    expect(body).toContain("LEFT JOIN messages");
    expect(body).toContain("m.content");
  });
});
