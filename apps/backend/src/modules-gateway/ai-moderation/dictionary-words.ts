/**
 * Which words in a message are worth a dictionary lookup.
 *
 * ## Why this is a separate concern from the lookup itself
 *
 * The KBBI API answers for one word at a time and costs a request per word. A
 * Discord message is mostly function words, links and emoji, and looking those
 * up buys nothing: "yang" has a definition, but it does not tell the moderator
 * whether a message is an insult. So the selection has to happen before the
 * network, and it has to be a pure function of the text — which makes it the
 * only part of this feature worth testing exhaustively.
 *
 * ## The failure this prevents
 *
 * The alternative is to send the whole message body as one "word" and let the
 * API return `not_found`, which teaches the model nothing and looks, in the
 * logs, exactly like a working lookup that found nothing. Selection is also
 * what keeps the prompt small: a 25-message batch of long messages would
 * otherwise ask for hundreds of words and pay for every one.
 */

/** Fragments that carry no meaning worth a definition. */
const STOPLIST = new Set([
  // Connectives and particles.
  "ada",
  "adalah",
  "agar",
  "akan",
  "aku",
  "anda",
  "antara",
  "apa",
  "apabila",
  "atau",
  "bagai",
  "bahwa",
  "bagi",
  "bahkan",
  "biar",
  "bisa",
  "buat",
  "dan",
  "dari",
  "dalam",
  "dapat",
  "dengan",
  "di",
  "dia",
  "dua",
  "hanya",
  "harus",
  "hingga",
  "ia",
  "ingin",
  "ini",
  "itu",
  "jadi",
  "jika",
  "juga",
  "kalau",
  "kami",
  "kamu",
  "karena",
  "kata",
  "ke",
  "kepadanya",
  "kita",
  "lagi",
  "lain",
  "lalu",
  "lebih",
  "maka",
  "mampu",
  "masih",
  "mau",
  "melalui",
  "memang",
  "mengapa",
  "mereka",
  "meski",
  "namun",
  "oleh",
  "pada",
  "para",
  "pun",
  "saat",
  "saja",
  "sampai",
  "sangat",
  "satu",
  "sebagai",
  "sebelum",
  "sebuah",
  "sedang",
  "sehingga",
  "sejak",
  "selain",
  "selama",
  "semua",
  "seperti",
  "sering",
  "serta",
  "sesuatu",
  "setelah",
  "sudah",
  "supaya",
  "tanpa",
  "tapi",
  "telah",
  "tentang",
  "terhadap",
  "tersebut",
  "tetapi",
  "tidak",
  "untuk",
  "walau",
  "waktu",
  "yaitu",
  "yakni",
  "yang",
]);

/** Below this length a fragment is a particle, not a word. */
const MIN_WORD_LENGTH = 3;

/**
 * Fragments that are only ever part of a URL or a brand name.
 *
 * Kept as an exact set rather than a substring rule: "kontol" must survive, and
 * a rule like "drop anything containing `co`" would take it out along with
 * "id". Each entry is a domain fragment or a platform name that a pasted link
 * leaves behind once tokenised.
 */
const NON_WORDS = new Set([
  "http",
  "https",
  "www",
  "com",
  "net",
  "org",
  "shopee",
  "tokopedia",
  "instagram",
  "facebook",
  "tiktok",
  "twitter",
  "youtube",
  "whatsapp",
  "telegram",
  "discord",
  "spotify",
  "netflix",
]);

/** Strip a Discord mention to nothing — `@name` and `<@id>` are not words. */
function stripMentions(text: string): string {
  return text.replace(/<@!?\d+>/g, " ").replace(/@[\w.-]+/g, " ");
}

/**
 * Remove anything that looks like a URL before tokenising.
 *
 * Needed because a pasted link leaves word-like fragments behind
 * (`instagram.com/reel/abc` -> `instagram`, `com`, `reel`, `abc`) that would
 * each consume a slot in the per-message budget.
 */
function stripUrls(text: string): string {
  return text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ");
}

/** Split into lowercase candidate words, in source order. */
function tokenize(text: string): string[] {
  return (
    stripUrls(stripMentions(text))
      .toLowerCase()
      // Unicode-aware so a letter outside Latin-1 is not split into punctuation.
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0)
  );
}

/** Is this fragment something a dictionary can answer for? */
function isLookable(word: string): boolean {
  if (word.length < MIN_WORD_LENGTH) return false;
  if (STOPLIST.has(word)) return false;
  if (NON_WORDS.has(word)) return false;
  // A bare number is not a word, and "2024" costs a slot for nothing.
  if (/^\d+$/.test(word)) return false;
  return true;
}

/**
 * The spans worth looking up in one message: longest-match phrases first,
 * then single content words for whatever tokens remain.
 *
 * Framed Indonesian meaning lives in multi-word headwords — "kambing hitam"
 * is a person unfairly blamed, not a goat that is black, and "rumah sakit"
 * is one institution, not a house and an illness. Splitting on whitespace
 * first throws that meaning away before the dictionary ever sees it.
 *
 * Greedy longest-match: at each token position, try the widest window that
 * is a known phrase before falling back to the single token. A phrase and
 * its first token cannot both win — they would be two rows for one span,
 * and the definition of the single token would contradict the phrase's.
 * Overlapping phrases ("mata kaki" vs "kaki") resolve to the longest,
 * which is the one KBBI actually defines as a unit.
 *
 * `phrases` is the service's own headword list, lowercase, tokens joined by
 * single spaces — the same normal form `tokenize` produces, so comparison
 * is exact set membership, no fuzzy matching.
 */
export function extractSpans(
  text: string | null | undefined,
  phrases: ReadonlySet<string>,
  limit: number,
): string[] {
  if (!text || limit <= 0) return [];
  const tokens = tokenize(text);
  const spans: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < tokens.length && spans.length < limit) {
    let matched = false;
    for (let width = Math.min(4, tokens.length - i); width >= 2; width--) {
      const candidate = tokens.slice(i, i + width).join(" ");
      if (!phrases.has(candidate)) continue;
      if (!seen.has(candidate)) {
        seen.add(candidate);
        spans.push(candidate);
      }
      i += width;
      matched = true;
      break;
    }
    if (matched) continue;
    const token = tokens[i] as string;
    if (isLookable(token) && !seen.has(token)) {
      seen.add(token);
      spans.push(token);
    }
    i += 1;
  }
  return spans;
}

/**
 * The words in one message worth looking up, in order of first appearance.
 *
 * `limit` bounds a single message. A long message holds far more distinct words
 * than the batch budget can pay for, and the earliest ones are the ones a
 * reader notices first, so the cap takes the head rather than sampling.
 *
 * Returns a lowercased, deduplicated list. Order is significant and preserved;
 * an empty array means the message had nothing worth a request.
 */
export function selectDictionaryWords(
  text: string | null | undefined,
  limit: number,
  phrases?: ReadonlySet<string>,
): string[] {
  if (!text || limit <= 0) return [];
  // With a phrase index, phrase-first selection replaces the flat word list.
  // Every existing caller that does not pass `phrases` keeps the old
  // behaviour, so the stoplist/limit tests below pin the fallback, not a new
  // semantic.
  if (phrases) return extractSpans(text, phrases, limit);

  const seen = new Set<string>();
  const words: string[] = [];
  for (const token of tokenize(text)) {
    if (seen.has(token)) continue;
    if (!isLookable(token)) continue;
    seen.add(token);
    words.push(token);
    if (words.length >= limit) break;
  }
  return words;
}

/**
 * The distinct words across a batch, in first-appearance order.
 *
 * Deduplication across messages is the point: "biji" appearing in five messages
 * of one batch is one lookup, not five. `perMessageLimit` is applied per message
 * first, so a single verbose message cannot consume the whole batch budget and
 * starve every other message of grounding.
 */
export function selectBatchDictionaryWords(
  texts: readonly (string | null | undefined)[],
  perMessageLimit: number,
  batchLimit: number,
  phrases?: ReadonlySet<string>,
): string[] {
  return selectBatchDictionaryWordPlan(
    texts,
    perMessageLimit,
    batchLimit,
    phrases,
  ).batch;
}

/**
 * Which words each message contributes, and the deduplicated batch to ask about.
 *
 * The per-message map is only ever populated with words that made it into
 * `batch`. That coupling is the whole point of returning both together: a caller
 * that records every message's candidates and then sends only the first
 * `batchLimit` claims the dictionary "does not know" words it was never asked
 * about, and `<not_in_dictionary>` renders that invention as an authoritative
 * absence the model is then forbidden to explain.
 */
export function selectBatchDictionaryWordPlan(
  texts: readonly (string | null | undefined)[],
  perMessageLimit: number,
  batchLimit: number,
  phrases?: ReadonlySet<string>,
): { perMessage: Map<string, string[]>; batch: string[] } {
  const perMessage = new Map<string, string[]>();
  const seen = new Set<string>();
  const batch: string[] = [];
  if (batchLimit <= 0) return { perMessage, batch };

  texts.forEach((text, index) => {
    const chosen: string[] = [];
    for (const word of selectDictionaryWords(text, perMessageLimit, phrases)) {
      // Break, not filter: the budget must be consumed as the list is built,
      // or every candidate of the message that fills it is admitted at once.
      if (chosen.length >= batchLimit - batch.length) break;
      if (seen.has(word)) continue;
      seen.add(word);
      batch.push(word);
      chosen.push(word);
    }
    if (chosen.length > 0) perMessage.set(String(index), chosen);
  });

  return { perMessage, batch };
}
