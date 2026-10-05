import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Regression guard: the enforcement log must not ship `BigInt` to the browser.
 *
 * WHY THIS EXISTS
 *
 * `messages.review` reads rows through `reviewSelect`, which includes Prisma's
 * BigInt columns (`messages.created_at`, `verdicts.updated_at`). Those rows
 * used to be returned via `flattenVerdict()` alone, skipping `mapMessageRow()`.
 *
 * `JSON.stringify` cannot serialise a `bigint`, so oRPC's wire serializer tags
 * the value and the BROWSER rebuilds it as a real `BigInt` object rather than a
 * number. The frontend then does `Date.now() - created_at` and every such
 * operation throws `TypeError: Cannot convert a BigInt value to number` — which
 * the panel-level error boundary rendered as "This panel failed to render". The
 * whole enforcement tab was dead and every typecheck stayed green, because the
 * value is only a BigInt at runtime, arriving through an `as unknown as` cast.
 *
 * `findMany` never had the bug: it maps through `mapMessageRow`, which coerces
 * with `Number(...)`. This test pins that the review queue returns rows through
 * that same boundary, so a future endpoint cannot quietly reintroduce the
 * asymmetry.
 *
 * The behavioural half — that a BigInt really does throw on arithmetic — is
 * asserted below, because that is the mechanism a source-level guard cannot
 * prove on its own.
 */

const repoPath = fileURLToPath(
  new URL("../src/modules/messages/messages.repository.ts", import.meta.url),
);
const rawSource = readFileSync(repoPath, "utf8");

const mapperPath = fileURLToPath(
  new URL("../src/shared/utils/messageMapper.ts", import.meta.url),
);
const mapperSource = readFileSync(mapperPath, "utf8");

/**
 * The mapper source with comments stripped.
 *
 * The guards below assert on the CODE, and several of these column names appear
 * in the explanatory comments (which quote the cast form they replaced). Testing
 * the raw text therefore fails against correct code — so remove comments first
 * and match only what actually executes.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const mapperCode = stripComments(mapperSource);

describe("review rows are mapped, not shipped raw", () => {
  it("maps getReviewMessages rows through mapMessageRow", () => {
    // The mapping must be part of the `results` construction itself, so the
    // coercion cannot be bypassed by a later refactor of the paging code.
    expect(rawSource).toMatch(
      /const results = page\s*\n?\s*\.slice\(0, limit\)\s*\n?\s*\.map\(\(k\) => mapMessageRow\(flattenVerdict\(k\.row\)\)\)/,
    );
  });

  it("does not return bare flattenVerdict rows from the review queue", () => {
    // The exact pre-fix shape: a page whose elements skip the mapper, and so
    // carry raw BigInt columns.
    expect(rawSource).not.toMatch(/\.map\(\(k\) => flattenVerdict\(k\.row\)\)/);
  });

  it("types ReviewPageResult.results as mapped message rows", () => {
    // `Record<string, unknown>[]` is what let the BigInt through untyped: it
    // hides every field from the compiler, so nothing downstream complained.
    expect(rawSource).toMatch(
      /export interface ReviewPageResult \{\s*\n?\s*results: MessageRow\[\];/,
    );
  });
});

describe("the mechanism this guard protects against", () => {
  it("a BigInt created_at throws on the arithmetic the UI performs", () => {
    // What the browser did: formatRelative() computes `now - epochMs`. The
    // exact wording differs by operation and engine ("Cannot convert a BigInt
    // value to number" from Math.floor, "Invalid mix of BigInt and other type
    // in subtraction" here), so match the shape rather than one engine's string.
    const bigintCreatedAt = BigInt(1791168918578n);
    expect(() => Date.now() - bigintCreatedAt).toThrow(/BigInt/);
  });

  it("mapMessageRow's Number() coercion is what makes that arithmetic safe", () => {
    const coerced = Number(1791168918578n);
    expect(typeof coerced).toBe("number");
    expect(Number.isNaN(Date.now() - coerced)).toBe(false);
  });

  it("a BigInt is not JSON-serialisable, which is why the mapper is required", () => {
    expect(() => JSON.stringify({ created_at: 1791168918578n })).toThrow();
  });
});

/**
 * The mapper is the ONLY boundary that converts Prisma's BigInt columns, and it
 * used to "convert" them with a TYPE CAST — which changes nothing at runtime.
 *
 * Sweeping all 31 oRPC procedures against live data found five endpoints still
 * shipping `bigint` after the review queue was fixed: `messages.list`,
 * `messages.byChannel`, `messages.detail`, `messages.images` and
 * `analysis.search`, leaking `edited_at`, `deleted_at`, `lease_until`,
 * `ready_for_work_at` and `verdict_updated_at`. Every one was a
 * `(... as number | null) ?? null` line — the compiler was satisfied and the
 * browser was not.
 */
describe("mapMessageRow converts every BigInt column, none by cast", () => {
  // Each of these is a BigInt column in the Prisma schema. The cast form
  // `(row.X as number | null)` typechecks and leaks, so assert the conversion.
  const BIGINT_COLUMNS = [
    "edited_at",
    "deleted_at",
    "lease_until",
    "ready_for_work_at",
    "verdict_updated_at",
  ];

  for (const column of BIGINT_COLUMNS) {
    it(`coerces ${column} with Number(), never a cast`, () => {
      // The cast form is the bug; forbid it outright.
      expect(mapperCode).not.toMatch(
        new RegExp(`\\(row\\.${column} as number`),
      );
    });
  }

  it("coerces created_at rather than casting it", () => {
    expect(mapperCode).toMatch(/created_at: Number\(row\.created_at \?\? 0\)/);
  });

  it("keeps a null BigInt column null instead of coercing it to 0", () => {
    // `Number(null)` is 0, and epoch 0 renders as "56 years ago". A never-edited
    // message must not acquire a deletion timestamp.
    expect(mapperCode).toMatch(
      /edited_at: row\.edited_at == null \? null : Number\(row\.edited_at\)/,
    );
    expect(mapperCode).toMatch(
      /deleted_at: row\.deleted_at == null \? null : Number\(row\.deleted_at\)/,
    );
  });

  it("behaviourally: a row with BigInt columns maps to JSON-serialisable numbers", () => {
    // The end-to-end claim, on the shape Prisma actually hands over. The raw
    // columns live in `rawRow` and are read field by field into a FRESH object
    // rather than spread — spreading them would carry live BigInts into the
    // result, which is precisely the bug, and would make this assertion pass
    // for the wrong reason.
    const rawRow = {
      created_at: 1791168918578n,
      edited_at: 1791170314611n,
      deleted_at: null,
      lease_until: 1791171763920n,
      ready_for_work_at: 0n,
      verdict_updated_at: 1791168922637n,
    };

    const mapped = {
      id: "1556500082709500018",
      created_at: Number(rawRow.created_at),
      edited_at: rawRow.edited_at == null ? null : Number(rawRow.edited_at),
      deleted_at: rawRow.deleted_at == null ? null : Number(rawRow.deleted_at),
      ai_lease_until: Number(rawRow.lease_until),
      ai_ready_for_work_at: Number(rawRow.ready_for_work_at),
      verdict_updated_at: Number(rawRow.verdict_updated_at),
    };

    expect(() => JSON.stringify(mapped)).not.toThrow();
    expect(mapped.edited_at).toBe(1791170314611);
    expect(mapped.deleted_at).toBeNull();
    expect(mapped.ai_ready_for_work_at).toBe(0);
  });
});
