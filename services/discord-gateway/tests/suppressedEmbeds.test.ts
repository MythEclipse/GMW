/**
 * Regression tests for the second round of moderation evidence bugs.
 *
 * Each case here is a real production row, not a synthetic shape:
 *   - bot `Embedded` (1402327963029999646) posts 238 messages that all carry
 *     `SUPPRESS_EMBEDS` and arrive with an empty embed array,
 *   - a Facebook `share/p/` link that Discord never generates a preview for,
 *   - an embed-only bot message whose only link lives in `embed.url`.
 *
 * The bug these pin: `pairLinksWithEmbeds` bailed when the body held no URL,
 * so an embed-only message produced no evidence at all and the model was asked
 * to judge a blank. Auto-delete then acted on that blank.
 */
import { describe, expect, test } from "bun:test";

import { isEligibleForAutoDelete } from "../src/modules/ai-moderation/autoDeleteEligibility.js";
import {
  formatLinkEvidenceForPrompt,
  hasSuppressedEmbeds,
  isLinkOnlyPost,
  pairLinksWithEmbeds,
} from "../src/modules/message-capture/messageMetadata.js";

/** Real payload shape captured from the `Embedded` bot in production. */
const SUPPRESSED_BOT_METADATA = JSON.stringify({
  stickers: [],
  embeds: [],
  attachments: [],
  customEmojis: [],
  mentionedRoles: [],
  mentionedUsers: [],
  mentionedChannels: [],
  author: {
    id: "1402327963029999646",
    username: "Embedded",
    tag: "Embedded#3939",
    avatarURL:
      "https://cdn.discordapp.com/avatars/1402327963029999646/cf11.jpg",
    bot: true,
    displayName: "Embedded",
    globalName: null,
    flags: 65536,
    accountCreatedTimestamp: 1754411440380,
    system: false,
  },
  channel: {
    channelId: "1206217214274048050",
    channelName: "general",
    nsfw: false,
  },
  reference: null,
  flags: 36868,
  flagNames: ["SUPPRESS_EMBEDS", "IS_VOICE_MESSAGE", "IS_FORWARD"],
  componentCount: 1,
});

/** An embed-only message: empty body, all content in the embed. */
const EMBED_ONLY_METADATA = JSON.stringify({
  embeds: [
    {
      title: "Yujinn Bertindak",
      description:
        "Menurut info yg gw dapetin, operasi ini namanya operasi bulu dubur",
      url: "https://www.facebook.com/photo.php?fbid=999",
      image: "https://cdn.discordapp.com/embed/avatars/1/pic.jpg",
      provider: { name: "Facebook", url: "https://www.facebook.com" },
      fields: [{ name: "reactions", value: "1.2K", inline: true }],
      type: "rich",
    },
  ],
  attachments: [],
  stickers: [],
  channel: { channelId: "c1", nsfw: false },
});

describe("embed-only messages are not dropped", () => {
  test("an embed with no link in the body is still paired", () => {
    const pairs = pairLinksWithEmbeds("", EMBED_ONLY_METADATA);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.embed?.title).toBe("Yujinn Bertindak");
  });

  test("the prompt carries the embed body for an embed-only message", () => {
    const out = formatLinkEvidenceForPrompt("", EMBED_ONLY_METADATA);
    expect(out).toContain("<link_evidence>");
    expect(out).toContain("Yujinn Bertindak");
    expect(out).toContain("operasi bulu dubur");
    expect(out).not.toContain("tidak ada: Discord tidak membuat pratinjau");
  });

  test("an embed-only message is not a bare link post", () => {
    // There is no link in the body at all, so the bare-link evidence gate
    // must not be what protects it — that is the suppressed-embed guard's job.
    expect(isLinkOnlyPost("", EMBED_ONLY_METADATA)).toBe(false);
  });
});

describe("SUPPRESS_EMBEDS is detected", () => {
  test("the production Embedded-bot payload is recognised", () => {
    expect(hasSuppressedEmbeds(SUPPRESSED_BOT_METADATA)).toBe(true);
  });

  test("a normal message is not", () => {
    expect(hasSuppressedEmbeds(EMBED_ONLY_METADATA)).toBe(false);
    expect(hasSuppressedEmbeds(JSON.stringify({ embeds: [] }))).toBe(false);
    expect(hasSuppressedEmbeds(null)).toBe(false);
  });
});

describe("unreadable messages are never auto-deleted", () => {
  // The real row: bot `Embedded`, message 1554472364094521396, in
  // 「💬」general on guild 1206212469148749834.
  const blocked = {
    id: "1554472364094521396",
    guild_id: "1206212469148749834",
    channel_id: "1206217214274048050",
    user_id: "1402327963029999646",
    content: "",
    metadata: SUPPRESSED_BOT_METADATA,
  };

  // The guard cannot be talked out of it by any verdict the model returns.
  // The severity ladder this used to loop over ("low", "medium", "high",
  // "critical") is gone, so what is left to vary is the one input that could
  // still have mattered: the model's own confidence in the judgement. Even at
  // maximum certainty, a message whose content was never captured cannot be
  // deleted — the evidence does not exist, so the confidence is a number about
  // nothing.
  for (const confidence of [0.5, 0.75, 0.99, 1]) {
    test(`confidence=${confidence} is still refused`, () => {
      expect(
        isEligibleForAutoDelete(blocked, {
          status: "deleted",
          confidence,
          score: confidence,
        }),
      ).toBe(false);
    });
  }

  // And a message the model could not read at all is never eligible, at any
  // confidence — "could not judge" is not evidence of a violation.
  test("an error verdict on a suppressed message is refused", () => {
    expect(
      isEligibleForAutoDelete(blocked, {
        status: "error",
        confidence: 1,
        score: 1,
      }),
    ).toBe(false);
  });

  // The positive control. Without it the four assertions above would also pass
  // if `isEligibleForAutoDelete` simply returned false for everything, which
  // is the failure mode that looks like a working safety gate.
  test("the same message is eligible once its embeds are readable", () => {
    expect(
      isEligibleForAutoDelete(
        { ...blocked, metadata: EMBED_ONLY_METADATA },
        { status: "deleted", confidence: 0.99, score: 0.99 },
      ),
    ).toBe(true);
  });
});

describe("a Facebook share with no preview is not deleted", () => {
  const meta = JSON.stringify({
    embeds: [],
    attachments: [],
    channel: { channelId: "c1", nsfw: false },
  });

  // The prompt failed to resolve this preview, so the model had nothing to
  // judge but the domain — and guessed. A guessed deletion is not a deletion,
  // whatever the verdict says.
  test("a deleted verdict on a bare link with no resolved preview is refused", () => {
    expect(
      isEligibleForAutoDelete(
        {
          id: "757213657229819934",
          guild_id: "1206212469148749834",
          channel_id: "1206217214274048050",
          user_id: "757213657229819934",
          content: "https://www.facebook.com/share/p/1HS6635WgE/",
          metadata: meta,
        },
        { status: "deleted", confidence: 0.99, score: 0.95 },
      ),
    ).toBe(false);
  });

  test("the prompt says the preview is unavailable instead of inventing one", () => {
    const out = formatLinkEvidenceForPrompt(
      "https://www.facebook.com/share/p/1HS6635WgE/",
      meta,
    );
    expect(out).toContain("Discord tidak membuat pratinjau");
  });
});
