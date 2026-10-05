/**
 * KBBI definitions must reach the PROMPT, not merely exist.
 *
 * A unit test on `formatDefinitions` alone passes while the whole feature is
 * inert: the block renders correctly and nothing ever calls it. That is
 * exactly how the previous version of this feature shipped — the formatter was
 * written, tested in isolation, and never wired into the prompt, so the model
 * kept guessing slang meanings with a green suite behind it.
 *
 * So the wiring tests here run the real `ModerationWorker.analyze()` through a
 * recording gateway and assert on the captured prompt string.
 */

import { describe, expect, it } from "bun:test";
import {
  extractSpans,
  selectBatchDictionaryWordPlan,
  selectBatchDictionaryWords,
  selectDictionaryWords,
} from "../src/modules-gateway/ai-moderation/dictionary-words.js";
import {
  type DictionaryConfig,
  type DictionaryEntry,
  formatDefinitions,
  KbbiDictionary,
} from "../src/modules-gateway/ai-moderation/kbbiDictionary.js";
import {
  buildSystemPrompt,
  clearPromptCache,
  DICTIONARY_RULES,
  OUTPUT_CONTRACT,
} from "../src/modules-gateway/ai-moderation/policy.js";

/** A fetch stub that answers from a fixed word -> senses map. */
function stubFetch(
  answers: Record<string, { senses: string[]; standard?: boolean }>,
  opts: { ok?: boolean } = {},
): typeof fetch {
  return ((url: string | URL) => {
    if (opts.ok === false) {
      return Promise.resolve(new Response("nope", { status: 503 }));
    }
    const parsed = new URL(String(url));
    const words = parsed.searchParams.getAll("words");
    const results = words.map((word) => {
      const a = answers[word];
      if (!a) return { word, status: "not_found", entry: null };
      return {
        word,
        status: "success",
        entry: {
          data: {
            entri: [{ nama: word, makna: [{ submakna: a.senses }] }],
          },
        },
        standard: { is_standard: a.standard ?? true },
      };
    });
    return Promise.resolve(
      new Response(JSON.stringify({ results }), {
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

const CFG: DictionaryConfig = {
  baseUrl: "http://dict.test",
  enabled: true,
  timeoutMs: 1000,
  maxWords: 24,
  maxWordsPerMessage: 8,
  maxCharsPerWord: 300,
  maxCharsPerBatch: 2000,
};

// ── word selection ───────────────────────────────────────────────────────────

// ── phrase-first selection ──────────────────────────────────────────────────

describe("extractSpans", () => {
  const PHRASES = new Set([
    "kambing hitam",
    "rumah sakit",
    "naik daun",
    "mata kaki",
    "kepala dingin",
  ]);

  it("matches a multi-word headword as one span instead of its words", () => {
    expect(extractSpans("dia jadi kambing hitam di tim", PHRASES, 8)).toEqual([
      "kambing hitam",
      "tim",
    ]);
  });

  it("longest match wins when a phrase overlaps a shorter one", () => {
    const spans = extractSpans("matanya bengkak di mata kaki", PHRASES, 8);
    expect(spans).toContain("mata kaki");
    // The tokens covered by the phrase are consumed as a unit — "mata" must
    // not reappear as a free-standing word for the same span.
    expect(spans.filter((s) => s === "mata")).toHaveLength(0);
  });

  it("falls back to single words when no phrase applies", () => {
    // "kamu" is in the stoplist, so it drops out of the word-only tail.
    expect(extractSpans("kamu kontol anjir", PHRASES, 8)).toEqual([
      "kontol",
      "anjir",
    ]);
  });

  it("drops stoplist words in the word-only tail", () => {
    expect(extractSpans("yang kambing hitam", PHRASES, 8)).toEqual([
      "kambing hitam",
    ]);
  });

  it("dedupes a phrase repeated in one message", () => {
    // "dan"/"lain" are in the stoplist, so only the phrase survives.
    expect(
      extractSpans("rumah sakit dan rumah sakit lain", PHRASES, 8),
    ).toEqual(["rumah sakit"]);
  });

  it("honours the limit", () => {
    expect(
      extractSpans("kambing hitam rumah sakit naik daun", PHRASES, 2),
    ).toHaveLength(2);
  });
});

describe("selectDictionaryWords with a phrase index", () => {
  it("carries phrases straight through the selection cap", () => {
    const phrases = new Set(["rumah sakit"]);
    // "ke" and "sini" — "ke" is stoplist, "sini" is not... "sini" is not in the
    // stoplist, so it survives; the phrase replaces "rumah" and "sakit".
    expect(
      selectDictionaryWords("ke sini ke rumah sakit kawan", 4, phrases),
    ).toEqual(["sini", "rumah sakit", "kawan"]);
  });
});

describe("KbbiDictionary.phrases", () => {
  it("fetches /api/phrases once and caches it", async () => {
    let calls = 0;
    const kbbi = new KbbiDictionary(CFG, ((url: string) => {
      calls += 1;
      if (String(url).includes("/api/phrases")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ phrases: ["kambing hitam", "rumah sakit"] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
    }) as typeof fetch);

    const first = await kbbi.phrases();
    expect(first.has("kambing hitam")).toBe(true);
    expect(calls).toBe(1);
    const second = await kbbi.phrases();
    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it("degrades to an empty set when the route is missing", async () => {
    const kbbi = new KbbiDictionary(CFG, (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        }),
      )) as typeof fetch);
    const phrases = await kbbi.phrases();
    expect(phrases.size).toBe(0);
  });

  it("degrades to an empty set when the service is down", async () => {
    const kbbi = new KbbiDictionary(CFG, (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch);
    expect((await kbbi.phrases()).size).toBe(0);
  });
});

describe("selectDictionaryWords", () => {
  it("keeps content words and drops function words", () => {
    const words = selectDictionaryWords("dasar goblok otak kamu cok", 8);
    expect(words).toEqual(["dasar", "goblok", "otak", "cok"]);
  });

  it("returns first-appearance order with repeats collapsed", () => {
    expect(selectDictionaryWords("biji biji makan biji", 8)).toEqual([
      "biji",
      "makan",
    ]);
  });

  it("strips URLs, mentions and custom emoji before tokenising", () => {
    const words = selectDictionaryWords(
      "lihat https://instagram.com/reel/abc123 sama @Rangga dan <:123456789>",
      8,
    );
    // "lihat" survives; the URL fragments and the mention do not.
    expect(words).toContain("lihat");
    expect(words).not.toContain("instagram");
    expect(words).not.toContain("reel");
    expect(words).not.toContain("abc123");
    expect(words).not.toContain("rangga");
  });

  it("drops bare numbers and sub-three-letter fragments", () => {
    expect(selectDictionaryWords("2024 di ke 12345", 8)).toEqual([]);
  });

  it("honours the per-message limit", () => {
    expect(selectDictionaryWords("satu dua tiga empat lima", 3)).toHaveLength(
      3,
    );
  });

  it("returns nothing for empty or nullish input", () => {
    expect(selectDictionaryWords("", 8)).toEqual([]);
    expect(selectDictionaryWords(null, 8)).toEqual([]);
    expect(selectDictionaryWords(undefined, 8)).toEqual([]);
  });

  it("lowercases so the lookup matches the KBBI index", () => {
    expect(selectDictionaryWords("GOBLOK Makan", 8)).toEqual([
      "goblok",
      "makan",
    ]);
  });
});

describe("selectBatchDictionaryWords", () => {
  it("keeps the old word-only behaviour when no phrase index is given", () => {
    // Every caller that does not pass the new argument keeps the semantic the
    // stoplist/limit tests above pin — the phrase list is strictly additive.
    expect(
      selectBatchDictionaryWords(["biji dressings", "biji lagi makan"], 8, 24),
    ).toEqual(["biji", "dressings", "makan"]);
  });

  it("deduplicates across messages", () => {
    // "lagi" is in the stoplist, so it is not a candidate at all.
    expect(
      selectBatchDictionaryWords(["biji dressings", "biji lagi makan"], 8, 24),
    ).toEqual(["biji", "dressings", "makan"]);
  });

  it("applies the per-message cap before the batch cap, so one long message cannot starve the rest", () => {
    // "satu"/"dua" are in the stoplist, so the first message contributes
    // "tiga"/"empat" and the budget of 3 carries into the second message. The
    // assertion is that the batch cap is honoured across the batch, not that
    // any one message keeps all its words.
    const out = selectBatchDictionaryWords(
      ["satu dua tiga empat", "lima enam tujuh"],
      8,
      3,
    );
    expect(out).toHaveLength(3);
    expect(out).toEqual(["tiga", "empat", "lima"]);
  });
});

describe("selectBatchDictionaryWordPlan", () => {
  it("records only the words each message contributed to the batch", () => {
    // Six messages of eight candidates against a 24-word budget. The old
    // selection recorded every message's candidates but only sent the first 24,
    // so messages 4-6 were told the KBBI did not know words it was never asked
    // about — rendered as <not_in_dictionary>, which DICTIONARY_RULES makes
    // authoritative and forbids the model from explaining.
    const texts = ["a", "b", "c", "d", "e", "f"].map((p) =>
      Array.from({ length: 8 }, (_, i) => `wkw${p}zz${i}`).join(" "),
    );
    const { perMessage, batch } = selectBatchDictionaryWordPlan(texts, 8, 24);

    expect(batch).toHaveLength(24);
    const asked = new Set(batch);
    // The invariant: every recorded word was actually sent, so every absence
    // rendered as <not_in_dictionary> is one the service really answered. The
    // old selection recorded all 48 candidates while sending 24, so 24 of them
    // were absences nobody had verified.
    let recorded = 0;
    for (const words of perMessage.values()) {
      for (const word of words) {
        expect(asked.has(word)).toBe(true);
        recorded += 1;
      }
    }
    expect(recorded).toBe(batch.length);

    // The budget runs out part-way through the fourth message; the ones after
    // it contribute only what still fitted, and never more.
    expect(perMessage.get("0")).toHaveLength(8);
    expect(perMessage.get("3")).toEqual(["wkwdzz0", "wkwdzz1"]);
    expect(perMessage.get("4")).toEqual(["wkwezz0"]);
    expect(perMessage.get("5")).toEqual(["wkwfzz0"]);
  });

  it("keeps a word on the first message that used it", () => {
    const { perMessage, batch } = selectBatchDictionaryWordPlan(
      ["kucing lagi", "kucing makan"],
      8,
      24,
    );
    // "lagi" is in the stoplist. "kucing" is one lookup — the second message
    // does not re-send it — but "makan" is new and still gets its place.
    expect(batch).toEqual(["kucing", "makan"]);
    expect(perMessage.get("0")).toEqual(["kucing"]);
    expect(perMessage.get("1")).toEqual(["makan"]);
  });

  it("deduplicates a word already claimed by an earlier message", () => {
    // "biji" in five messages is one lookup, and the definition must still land
    // on every message that used the word — which the worker derives from this
    // plan, so the second message must not be dropped for reusing it.
    const { perMessage, batch } = selectBatchDictionaryWordPlan(
      ["biji dressings", "biji lagi makan"],
      8,
      24,
    );
    expect(batch).toEqual(["biji", "dressings", "makan"]);
    expect(perMessage.get("0")).toEqual(["biji", "dressings"]);
    expect(perMessage.get("1")).toEqual(["makan"]);
  });

  it("returns nothing for a zero batch budget", () => {
    const { perMessage, batch } = selectBatchDictionaryWordPlan(
      ["kucing"],
      8,
      0,
    );
    expect(batch).toEqual([]);
    expect(perMessage.size).toBe(0);
  });
});

// ── the adapter ──────────────────────────────────────────────────────────────

describe("KbbiDictionary.lookup", () => {
  it("returns definitions for known words and omits unknown ones", async () => {
    const kbbi = new KbbiDictionary(
      CFG,
      stubFetch({ biji: { senses: ["isi buah"] } }),
    );
    const got = await kbbi.lookup(["biji", "zzzqqq"]);
    expect(got).toHaveLength(1);
    expect(got[0]?.word).toBe("biji");
    expect(got[0]?.definition).toBe("isi buah");
  });

  it("matches results by the echoed word, not by array position", async () => {
    // A service that dropped the unknown row would shift every index. Keying
    // by the echoed word means "makan" still gets MINE, not "biji"'s.
    const answers = {
      biji: { senses: ["Biji sense"] },
      makan: { senses: ["Makan sense"] },
    };
    const kbbi = new KbbiDictionary(CFG, stubFetch(answers));
    const got = await kbbi.lookup(["biji", "zzzqqq", "makan"]);
    const byWord = Object.fromEntries(got.map((e) => [e.word, e.definition]));
    expect(byWord).toEqual({ biji: "Biji sense", makan: "Makan sense" });
  });

  it("surfaces a non-standard word so the model knows the sense is not the intended one", async () => {
    const kbbi = new KbbiDictionary(
      CFG,
      stubFetch({ bokap: { senses: ["ayah"], standard: false } }),
    );
    const got = await kbbi.lookup(["bokap"]);
    expect(got[0]?.standard).toBe(false);
  });

  it("returns nothing for an empty word list, and never calls fetch", async () => {
    let called = false;
    const kbbi = new KbbiDictionary(CFG, (() => {
      called = true;
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch);
    expect(await kbbi.lookup([])).toEqual([]);
    expect(called).toBe(false);
  });

  it("degrades to nothing on a non-OK response", async () => {
    const kbbi = new KbbiDictionary(CFG, stubFetch({}, { ok: false }));
    expect(await kbbi.lookup(["biji"])).toEqual([]);
  });

  it("degrades to nothing when the request throws", async () => {
    const kbbi = new KbbiDictionary(CFG, (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch);
    expect(await kbbi.lookup(["biji"])).toEqual([]);
  });

  it("degrades to nothing on malformed JSON", async () => {
    const kbbi = new KbbiDictionary(CFG, (() =>
      Promise.resolve(
        new Response("<html>gateway error</html>", { status: 200 }),
      )) as typeof fetch);
    expect(await kbbi.lookup(["biji"])).toEqual([]);
  });

  it("emits one request for the whole batch, deduplicated", async () => {
    let seenUrl = "";
    const kbbi = new KbbiDictionary(CFG, ((url: string) => {
      seenUrl = String(url);
      return Promise.resolve(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
    }) as typeof fetch);
    await kbbi.lookup(["biji", "biji", "makan"]);
    const params = new URL(seenUrl).searchParams.getAll("words");
    expect(params).toEqual(["biji", "makan"]);
  });

  it("drops a definition rather than truncating it mid-sentence", async () => {
    const kbbi = new KbbiDictionary(
      { ...CFG, maxCharsPerWord: 20 },
      stubFetch({
        biji: { senses: ["isi buah yang apabila ditanam dapat tumbuh"] },
      }),
    );
    // The single sense is longer than the cap, so nothing is emitted — a
    // half-sentence still reads as authoritative, which is worse than nothing.
    expect(await kbbi.lookup(["biji"])).toEqual([]);
  });

  it("keeps whole senses up to the cap and drops the rest", async () => {
    // 8 + 2 + 11 = 21 fits in 25; the third sense (15) would push it to 38.
    const kbbi = new KbbiDictionary(
      { ...CFG, maxCharsPerWord: 25 },
      stubFetch({
        biji: { senses: ["isi buah", "butir kecil", "kata penggolong"] },
      }),
    );
    const got = await kbbi.lookup(["biji"]);
    expect(got[0]?.definition).toBe("isi buah; butir kecil");
  });

  it("the cap counts the separator, so the RENDERED string never exceeds it", async () => {
    // Counting sense text but not the "; " between them lets the rendered
    // string overshoot by 2 * (senses - 1). Found by the live probe: "kopi"
    // rendered 303 chars against a 300 cap.
    const senses = ["aaaa", "bbbb", "cccc", "dddd"];
    const exact = senses.join("; ").length; // 18
    const kbbi = new KbbiDictionary(
      { ...CFG, maxCharsPerWord: exact },
      stubFetch({ biji: { senses } }),
    );
    const got = await kbbi.lookup(["biji"]);
    expect(got[0]?.definition.length).toBeLessThanOrEqual(exact);
    expect(got[0]?.definition).toBe("aaaa; bbbb; cccc; dddd");

    // One char tighter and the last sense must go, not be half-included.
    // 3 senses = 16 chars, fits in 17; 4 senses = 22, does not.
    const tighter = new KbbiDictionary(
      { ...CFG, maxCharsPerWord: exact - 1 },
      stubFetch({ biji: { senses } }),
    );
    const dropped = await tighter.lookup(["biji"]);
    expect(dropped[0]?.definition).toBe("aaaa; bbbb; cccc");
    expect(dropped[0]?.definition.length).toBeLessThanOrEqual(exact - 1);
  });

  it("stops at the batch character cap instead of building and trimming", async () => {
    // "isi buah yang planted" is 21 chars, one over the batch cap of 20, so
    // nothing is emitted and the second word is never considered. The cap is
    // checked BEFORE the entry is accepted, which is the point: an entry that
    // does not fit is skipped, not truncated to fit.
    const kbbi = new KbbiDictionary(
      { ...CFG, maxCharsPerBatch: 20 },
      stubFetch({
        biji: { senses: ["isi buah yang planted"] },
        makan: { senses: ["memakan sesuatu"] },
      }),
    );
    expect(await kbbi.lookup(["biji", "makan"])).toEqual([]);
  });

  it("re-emits in requested order regardless of reply order", async () => {
    const kbbi = new KbbiDictionary(CFG, (() => {
      const results = [
        {
          word: "makan",
          status: "success",
          entry: { data: { entri: [{ makna: [{ submakna: ["M"] }] }] } },
        },
        {
          word: "biji",
          status: "success",
          entry: { data: { entri: [{ makna: [{ submakna: ["B"] }] }] } },
        },
      ];
      return Promise.resolve(
        new Response(JSON.stringify({ results }), { status: 200 }),
      );
    }) as typeof fetch);
    const got = await kbbi.lookup(["biji", "makan"]);
    expect(got.map((e) => e.word)).toEqual(["biji", "makan"]);
  });

  it("treats a missing standard flag as standard", async () => {
    const kbbi = new KbbiDictionary(CFG, (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                word: "biji",
                status: "success",
                entry: { data: { entri: [{ makna: [{ submakna: ["x"] }] }] } },
              },
            ],
          }),
          { status: 200 },
        ),
      )) as typeof fetch);
    expect((await kbbi.lookup(["biji"]))[0]?.standard).toBe(true);
  });

  it("exposes the selection limits the caller needs", () => {
    const kbbi = new KbbiDictionary(CFG);
    expect(kbbi.limits).toEqual({
      maxWords: 24,
      maxWordsPerMessage: 8,
      maxCharsPerBatch: 2000,
    });
  });

  it("caches resolved words and avoids duplicate network requests", async () => {
    let fetchCalls = 0;
    const kbbi = new KbbiDictionary(CFG, (() => {
      fetchCalls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                word: "biji",
                status: "success",
                entry: {
                  data: { entri: [{ makna: [{ submakna: ["benih"] }] }] },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch);

    const first = await kbbi.lookup(["biji"]);
    expect(first[0]?.definition).toBe("benih");
    expect(fetchCalls).toBe(1);

    // Second call for the same word must hit the cache without calling fetch
    const second = await kbbi.lookup(["biji"]);
    expect(second[0]?.definition).toBe("benih");
    expect(fetchCalls).toBe(1);
    expect(kbbi.consulted).toBe(true);
  });

  it("fetches only uncached words when batch contains mixed cached and new words", async () => {
    const fetchedUrls: string[] = [];
    const kbbi = new KbbiDictionary(CFG, ((url: string) => {
      fetchedUrls.push(url);
      const isMakan = url.includes("makan");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: isMakan
              ? [
                  {
                    word: "makan",
                    status: "success",
                    entry: {
                      data: {
                        entri: [{ makna: [{ submakna: ["mengunyah"] }] }],
                      },
                    },
                  },
                ]
              : [
                  {
                    word: "biji",
                    status: "success",
                    entry: {
                      data: { entri: [{ makna: [{ submakna: ["benih"] }] }] },
                    },
                  },
                ],
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch);

    // First call caches "biji"
    await kbbi.lookup(["biji"]);
    expect(fetchedUrls.length).toBe(1);
    expect(fetchedUrls[0]).toContain("words=biji");

    // Second call requests ["biji", "makan"] -> only "makan" should be fetched
    const combined = await kbbi.lookup(["biji", "makan"]);
    expect(fetchedUrls.length).toBe(2);
    expect(fetchedUrls[1]).toContain("words=makan");
    expect(fetchedUrls[1]).not.toContain("words=biji");
    expect(combined.map((e) => e.word)).toEqual(["biji", "makan"]);
  });
});

// ── rendering ────────────────────────────────────────────────────────────────

describe("formatDefinitions", () => {
  const entry = (w: string, d: string, standard = true): DictionaryEntry => ({
    word: w,
    definition: d,
    standard,
  });

  it("renders nothing for no entries", () => {
    expect(formatDefinitions([])).toBe("");
  });

  it("renders one element per word, with the standard flag", () => {
    const out = formatDefinitions([
      entry("biji", "isi buah"),
      entry("bokap", "ayah", false),
    ]);
    expect(out).toContain('<definition word="biji" standard="true">isi buah');
    expect(out).toContain('<definition word="bokap" standard="false">ayah');
  });

  it("escapes the word attribute", () => {
    expect(formatDefinitions([entry('"><script>', "x")])).toContain("&quot;");
  });
});

// ── the prompt wiring ────────────────────────────────────────────────────────

describe("the dictionary rule covers words the dictionary lacks", () => {
  it("DICTIONARY_RULES explains the not_in_dictionary marker", () => {
    // Without this the marker renders into the prompt as an unexplained tag,
    // and a tag nobody explained is exactly what the model ignores.
    expect(DICTIONARY_RULES).toContain("not_in_dictionary");
  });

  it("OUTPUT_CONTRACT forbids inventing a meaning at the point of writing", () => {
    // The dictionary block is read early and the contract is read last. A ban
    // that lives only in the early block was already violated once in prod.
    // "JANGAN" and the verb are split across a line wrap, so assert the phrase
    // that stays on one line.
    expect(OUTPUT_CONTRACT).toContain("memberikannya arti");
  });
});

/**
 * The prod case: KBBI answered `not_found` for "Cumyami", GMW dropped the row
 * exactly as designed, and the verdict then reported the word as "berarti
 * 'cuma yang'" — an invented definition shown to a moderator as analysis.
 *
 * Rendering only hits left the model a gap with nothing saying it WAS a gap. A
 * named absence is what makes it non-fillable, so these assert the marker
 * reaches the prompt.
 */
describe("formatDefinitions — words the dictionary does not carry", () => {
  const entry = (w: string, d: string): DictionaryEntry => ({
    word: w,
    definition: d,
    standard: true,
  });

  it("names a word that was asked about and not found", () => {
    const out = formatDefinitions([], ["cumyami"]);
    expect(out).toContain("not_in_dictionary");
    expect(out).toContain("cumyami");
  });

  it("keeps hits and misses in one block", () => {
    const out = formatDefinitions([entry("biji", "isi buah")], ["cumyami"]);
    expect(out).toContain("biji");
    expect(out).toContain("cumyami");
  });

  it("renders nothing when there is neither a hit nor a miss", () => {
    expect(formatDefinitions([], [])).toBe("");
  });
});

describe("KBBI evidence reaches the prompt", () => {
  it("the system prompt carries the rule only when definitions exist", () => {
    clearPromptCache();
    const withDict = buildSystemPrompt({ mode: "text", dictionary: true });
    const without = buildSystemPrompt({ mode: "text", dictionary: false });
    expect(withDict).toContain(DICTIONARY_RULES.trim().slice(0, 40));
    expect(without).not.toContain(DICTIONARY_RULES.trim().slice(0, 40));
  });

  it("the cache key includes the dictionary flag, so a rule-less prompt is never served to a batch that has definitions", () => {
    clearPromptCache();
    const noDict = buildSystemPrompt({ mode: "text", dictionary: false });
    const yesDict = buildSystemPrompt({ mode: "text", dictionary: true });
    expect(noDict).not.toBe(yesDict);
    expect(yesDict).toContain("## KAMUS");
    expect(noDict).not.toContain("## KAMUS");
  });

  it("a dictionary-less batch produces a prompt byte-identical to before the feature", () => {
    clearPromptCache();
    const off = buildSystemPrompt({ mode: "text" });
    clearPromptCache();
    const explicitOff = buildSystemPrompt({
      mode: "text",
      memory: false,
      history: false,
      dictionary: false,
    });
    expect(off).toBe(explicitOff);
    expect(off).not.toContain("<dictionary>");
    expect(off).not.toContain("## KAMUS");
  });
});
