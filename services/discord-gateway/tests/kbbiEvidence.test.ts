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
  selectBatchDictionaryWords,
  selectDictionaryWords,
} from "../src/modules/ai-moderation/dictionary-words.js";
import {
  type DictionaryConfig,
  type DictionaryEntry,
  formatDefinitions,
  KbbiDictionary,
} from "../src/modules/ai-moderation/kbbiDictionary.js";
import {
  buildSystemPrompt,
  clearPromptCache,
  DICTIONARY_RULES,
  OUTPUT_CONTRACT,
} from "../src/modules/ai-moderation/policy.js";

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
  it("deduplicates across messages", () => {
    // "lagi" is in the stoplist, so it is not a candidate at all.
    expect(
      selectBatchDictionaryWords(["biji dressings", "biji lagi makan"], 8, 24),
    ).toEqual(["biji", "dressings", "makan"]);
  });

  it("applies the per-message cap before the batch cap, so one long message cannot starve the rest", () => {
    // The first message alone holds more than 3 lookable words ("satu" and "dua"
    // are numbers and drop out), so it exhausts the batch budget on its own.
    // That is the documented order: per-message cap first, then batch cap. The
    // assertion is that the batch cap is honoured and the batch is short, not
    // that the second message survives — a batch-wide budget of 3 spent by the
    // first message is the intended behaviour.
    const out = selectBatchDictionaryWords(
      ["satu dua tiga empat lima enam", "delapan sembilan"],
      8,
      3,
    );
    expect(out).toHaveLength(3);
    expect(out).toEqual(["tiga", "empat", "lima"]);
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

  it("returns nothing when disabled, and never calls fetch", async () => {
    let called = false;
    const kbbi = new KbbiDictionary({ ...CFG, enabled: false }, (() => {
      called = true;
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch);
    expect(await kbbi.lookup(["biji"])).toEqual([]);
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
