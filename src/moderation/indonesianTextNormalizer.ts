import badwordsModule from "indonesian-badwords";
import { INDONESIAN_SLANG_LEXICON } from "./resources/indonesianSlangLexicon.js";

const CUSTOM_EMOJI_PATTERN = /<a?:([a-zA-Z0-9_]+):(\d+)>/g;
const WORD_PATTERN = /[\p{L}\p{N}_]+/gu;

interface BadwordAnalyzeResult {
  badwords?: string[];
  count?: number;
}

interface BadwordsModule {
  analyze?: (text: string) => BadwordAnalyzeResult;
  flag?: (text: string) => boolean;
}

const badwords = badwordsModule as BadwordsModule;

export interface ModerationTextEvidence {
  raw: string;
  normalized: string;
  notes: string[];
  badwords: string[];
  hasBadwords: boolean;
}

export function normalizeDiscordCustomEmoji(text: string): {
  text: string;
  emojiNames: string[];
} {
  const emojiNames: string[] = [];
  const normalized = text.replace(CUSTOM_EMOJI_PATTERN, (_match, name: string) => {
    emojiNames.push(name);
    return `[emoji:${name}]`;
  });

  return { text: normalized, emojiNames };
}

export function normalizeIndonesianSlang(text: string): {
  text: string;
  notes: string[];
} {
  const notes: string[] = [];
  const normalized = text.replace(WORD_PATTERN, (word) => {
    const entry = INDONESIAN_SLANG_LEXICON[word.toLowerCase()];
    if (!entry) return word;

    notes.push(`${word}=${entry.normalized} (${entry.note})`);
    return entry.normalized;
  });

  return { text: normalized, notes: Array.from(new Set(notes)) };
}

export function detectIndonesianBadwords(text: string): string[] {
  try {
    const result = badwords.analyze?.(text);
    if (Array.isArray(result?.badwords)) {
      let hits = Array.from(new Set(result.badwords.map((word) => word.toLowerCase())));
      
      const lowerText = text.toLowerCase();
      hits = hits.filter(hit => {
        if (hit === "asu") {
          const words = lowerText.match(/[\p{L}\p{N}_]+/gu) || [];
          return words.some(w => 
            w.includes("asu") && 
            !["asus", "masuk", "termasuk", "dimasukkan", "memasukkan", "kasur", "asumsi", "asuransi", "asupan", "pasukan", "pasundan"].includes(w)
          );
        }
        return true;
      });

      return hits;
    }
  } catch {
    // Keep moderation pipeline resilient if dependency changes shape.
  }
  return [];
}

export function buildModerationTextEvidence(text: string): ModerationTextEvidence {
  const emojiNormalized = normalizeDiscordCustomEmoji(text);
  const slangNormalized = normalizeIndonesianSlang(emojiNormalized.text);
  const badwordHits = detectIndonesianBadwords(slangNormalized.text);
  const notes = [...slangNormalized.notes];

  for (const emojiName of emojiNormalized.emojiNames) {
    notes.push(
      `emoji:${emojiName}=Discord custom emoji/expression; not text offense by default`,
    );
  }

  if (badwordHits.length > 0) {
    notes.push(`local lexical check: Indonesian badword detected: ${badwordHits.join(", ")}`);
  } else {
    notes.push("local lexical check: no Indonesian badword detected");
  }

  return {
    raw: text,
    normalized: slangNormalized.text,
    notes: Array.from(new Set(notes)),
    badwords: badwordHits,
    hasBadwords: badwordHits.length > 0,
  };
}

export function formatModerationTextEvidenceForPrompt(text: string): string {
  const evidence = buildModerationTextEvidence(text);
  if (evidence.normalized === evidence.raw && evidence.notes.length === 0) {
    return "";
  }

  return [
    `[normalized_text: ${evidence.normalized}]`,
    evidence.notes.length > 0 ? `[normalization_notes: ${evidence.notes.join("; ")}]` : null,
  ]
    .filter(Boolean)
    .join(" ");
}
