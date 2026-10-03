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
): string[] {
  if (!text || limit <= 0) return [];

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
): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const text of texts) {
    for (const word of selectDictionaryWords(text, perMessageLimit)) {
      if (seen.has(word)) continue;
      seen.add(word);
      words.push(word);
      if (words.length >= batchLimit) return words;
    }
  }
  return words;
}
