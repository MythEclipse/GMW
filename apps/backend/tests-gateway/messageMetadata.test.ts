/**
 * Regression tests for the gateway's message metadata.
 *
 * Each of these pins a bug that was live in production, so a future refactor
 * that reintroduces it fails here rather than in the dashboard.
 */

import type { Message } from "discord.js-selfbot-v13";
import { describe, expect, it } from "vitest";
import {
  decodeMessageFlags,
  getAttachmentsFromMetadata,
  getMemberPermissionNames,
  getMessageLocation,
  getMessageMetadata,
  parseRichMessageMetadata,
} from "../src/modules-gateway/message-capture/messageMetadata.js";

/**
 * A discord.js `Collection`-alike: a real Map, because the code calls
 * `.map()` on these caches and a plain object has no `map`.
 */
function coll<V>(entries: Array<[string, V]> = []) {
  const m = new Map<string, V>(entries);
  return Object.assign(m, {
    map<R>(fn: (v: V, k: string, c: Map<string, V>) => R): R[] {
      return Array.from(m.entries()).map(([k, v]) => fn(v, k, m));
    },
  });
}

/** A TextChannel-shaped stub. */
function textChannel(over: Record<string, unknown> = {}) {
  return {
    id: "chan-1",
    name: "general",
    isThread: () => false,
    topic: "diskusi Umum",
    nsfw: false,
    ...over,
  };
}

/** A ThreadChannel-shaped stub. ThreadChannel has NO topic and NO nsfw. */
function threadChannel(over: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    name: "bantuan-join",
    parentId: "chan-1",
    isThread: () => true,
    archived: false,
    locked: false,
    memberCount: 3,
    messageCount: 42,
    ownerId: "u-owner",
    createdTimestamp: 1_700_000_000_000,
    appliedTags: [],
    parent: {
      id: "chan-1",
      name: "general",
      topic: "diskusi Umum",
      nsfw: false,
    },
    ...over,
  };
}

function message(over: Record<string, unknown> = {}): Message {
  return {
    id: "m-1",
    channelId: "chan-1",
    guildId: "g1",
    content: "halo",
    createdTimestamp: 1_700_000_000_000,
    type: "DEFAULT",
    channel: textChannel(),
    author: {
      id: "u1",
      username: "budi",
      displayName: "Budi",
      globalName: "Budi G",
      tag: "budi#1234",
      bot: false,
      system: false,
      flags: { bitfield: 0 },
      createdTimestamp: 1_600_000_000_000,
      avatarURL: () => "https://cdn/avatar.png",
    },
    member: null,
    mentions: {
      roles: coll(),
      users: coll(),
      channels: coll(),
      everyone: false,
    },
    attachments: coll(),
    embeds: [],
    stickers: coll(),
    components: [],
    reference: null,
    flags: { bitfield: 0, has: () => false },
    webhookId: null,
    applicationId: null,
    pinned: false,
    tts: false,
    system: false,
    position: 0,
    hasThread: false,
    poll: null,
    ...over,
  } as unknown as Message;
}

describe("channel location", () => {
  it("reads the topic from the PARENT for a thread", () => {
    // Regression: ThreadChannel has no `topic` property, so the old
    // `"topic" in channel` check always failed and every thread message
    // stored topic: null — losing the one field that says what the thread is
    // for.
    const loc = getMessageLocation(
      message({ channel: threadChannel() } as never),
    );
    expect(loc.topic).toBe("diskusi Umum");
    expect(loc.threadName).toBe("bantuan-join");
    expect(loc.channelId).toBe("chan-1");
    expect(loc.threadId).toBe("thread-1");
  });

  it("inherits nsfw from the parent for a thread", () => {
    // Regression: a thread inside an age-restricted channel reported
    // nsfw: undefined, so the worker analysed it and the enforcer would
    // delete it. Discord has no per-thread NSFW toggle.
    const loc = getMessageLocation(
      message({
        channel: threadChannel({
          parent: { id: "chan-1", name: "nsfw", nsfw: true },
        }),
      } as never),
    );
    expect(loc.nsfw).toBe(true);
    expect(loc.ageRestricted).toBe(true);
  });

  it("keeps a non-nsfw thread non-nsfw", () => {
    const loc = getMessageLocation(
      message({ channel: threadChannel() } as never),
    );
    expect(loc.nsfw).toBe(false);
  });

  it("returns undefined when neither the thread nor the parent is known", () => {
    const loc = getMessageLocation(
      message({ channel: threadChannel({ parent: null }) } as never),
    );
    // Not `false`: the worker treats null/undefined as "unknown → moderate",
    // which is the safe default for a channel it cannot resolve.
    expect(loc.nsfw).toBeUndefined();
  });
});

describe("message flags", () => {
  it("decodes the flags a moderator actually cares about", () => {
    const { names } = decodeMessageFlags((1 << 1) | (1 << 4) | (1 << 5));
    expect(names).toContain("IS_CROSSPOST");
    expect(names).toContain("URGENT");
    expect(names).toContain("HAS_THREAD");
  });

  it("returns an empty list for no flags", () => {
    expect(decodeMessageFlags(0).names).toEqual([]);
    expect(decodeMessageFlags(undefined).raw).toBe(0);
  });

  it("preserves the raw bitfield for a flag it does not know by name", () => {
    // A flag Discord adds later must still survive capture.
    const future = 1 << 30;
    const { raw } = decodeMessageFlags(future);
    expect(raw).toBe(future);
  });
});

describe("member permissions", () => {
  it("reads permission names", () => {
    expect(
      getMemberPermissionNames({
        toArray: () => ["Administrator", "ManageMessages"],
      }),
    ).toEqual(["Administrator", "ManageMessages"]);
  });

  it("returns [] instead of throwing on a broken permission object", () => {
    // toArray() throws on unknown bits in older discord.js; a throw here
    // would cost us the entire message, not just the permissions.
    expect(
      getMemberPermissionNames({
        toArray: () => {
          throw new Error("unknown bit");
        },
      }),
    ).toEqual([]);
    expect(getMemberPermissionNames(null)).toEqual([]);
  });
});

describe("author and member evidence", () => {
  it("captures role position, which is what makes a verdict actionable", () => {
    const meta = getMessageMetadata(
      message({
        member: {
          displayName: "Budi",
          nickname: "bud",
          joinedTimestamp: 1_650_000_000_000,
          guild: { id: "g1" },
          communicationDisabledUntilTimestamp: null,
          premiumSinceTimestamp: null,
          pending: false,
          permissions: { toArray: () => ["ManageMessages"] },
          roles: {
            cache: coll([
              // In Discord the @everyone role id IS the guild id.
              ["g1", { id: "g1", name: "everyone", position: 0, color: 0 }],
              [
                "r2",
                { id: "r2", name: "Moderator", position: 7, color: 3447003 },
              ],
            ]),
          },
        },
      } as never),
    );
    const roles = meta.member?.roles ?? [];
    expect(roles.find((r) => r.id === "r2")?.position).toBe(7);
    expect(roles.find((r) => r.id === "r2")?.color).toBe(3447003);
    expect(roles.find((r) => r.id === "g1")?.isEveryone).toBe(true);
    expect(roles.find((r) => r.id === "r2")?.isEveryone).toBe(false);
    expect(meta.member?.permissions).toEqual(["ManageMessages"]);
    expect(meta.member?.nickname).toBe("bud");
  });

  it("records a timed-out member, which is moderation-relevant", () => {
    const until = 1_700_000_500_000;
    const meta = getMessageMetadata(
      message({
        member: {
          displayName: "B",
          joinedTimestamp: null,
          guild: { id: "g1" },
          communicationDisabledUntilTimestamp: until,
          premiumSinceTimestamp: null,
          pending: false,
          permissions: { toArray: () => [] },
          roles: { cache: coll() },
        },
      } as never),
    );
    expect(meta.member?.communicationDisabledUntil).toBe(until);
  });

  it("captures author flags and account age", () => {
    const meta = getMessageMetadata(message());
    expect(meta.author.bot).toBe(false);
    expect(meta.author.displayName).toBe("Budi");
    expect(meta.author.accountCreatedTimestamp).toBe(1_600_000_000_000);
  });
});

describe("media evidence", () => {
  it("captures attachment dimensions and alt text", () => {
    const meta = getMessageMetadata(
      message({
        attachments: coll([
          [
            "a1",
            {
              id: "a1",
              name: "shot.png",
              url: "https://cdn/shot.png",
              contentType: "image/png",
              size: 1234,
              width: 1080,
              height: 1920,
              duration: null,
              description: "spoiler: someone crying",
              spoiler: true,
              flags: null,
            },
          ],
        ]),
      } as never),
    );
    const a = meta.attachments[0];
    expect(a.width).toBe(1080);
    expect(a.height).toBe(1920);
    expect(a.description).toBe("spoiler: someone crying");
    expect(a.spoiler).toBe(true);
  });

  it("captures sticker description, which the old code dropped", () => {
    const meta = getMessageMetadata(
      message({
        stickers: coll([
          [
            "s1",
            {
              id: "s1",
              name: "Sadge",
              url: "https://cdn/s1.png",
              format: "PNG",
              description: "the classic PEPPY facepalm",
              packId: "p1",
              type: 2,
              tags: ["Funny"],
            },
          ],
        ]),
      } as never),
    );
    expect(meta.stickers[0].description).toBe("the classic PEPPY facepalm");
    expect(meta.stickers[0].packId).toBe("p1");
    expect(meta.stickers[0].tags).toEqual(["Funny"]);
  });

  it("captures embed type, video and provider", () => {
    const meta = getMessageMetadata(
      message({
        embeds: [
          {
            title: "video",
            description: null,
            url: null,
            color: 0,
            image: null,
            thumbnail: null,
            author: null,
            footer: null,
            fields: [],
            type: "video",
            timestamp: null,
            video: { url: "https://youtube/xyz", width: 640, height: 360 },
            provider: { name: "YouTube", url: "https://youtube" },
          },
        ],
      } as never),
    );
    expect(meta.embeds[0].type).toBe("video");
    expect(meta.embeds[0].video?.url).toBe("https://youtube/xyz");
    expect(meta.embeds[0].provider?.name).toBe("YouTube");
  });
});

describe("mentions", () => {
  it("records a mass ping, which the old metadata could not express", () => {
    // Regression: @everyone is never in mentions.roles, so a mass ping was
    // indistinguishable from a message with no role mentions.
    const meta = getMessageMetadata(
      message({
        mentions: {
          roles: coll(),
          users: coll(),
          channels: coll(),
          everyone: true,
        },
      } as never),
    );
    expect(meta.mentionsEveryone).toBe(true);
  });

  it("records role position so a mod-team ping is distinguishable", () => {
    const meta = getMessageMetadata(
      message({
        mentions: {
          roles: coll([["r1", { id: "r1", name: "Moderator", position: 9 }]]),
          users: new Map(),
          channels: new Map(),
          everyone: false,
        },
      } as never),
    );
    expect(meta.mentionedRoles[0].position).toBe(9);
  });

  it("records mentioned users with their bot flag", () => {
    const meta = getMessageMetadata(
      message({
        mentions: {
          roles: new Map(),
          users: coll([
            [
              "u2",
              {
                id: "u2",
                username: "helper",
                bot: true,
                displayName: "Helper",
              },
            ],
          ]),
          channels: new Map(),
          everyone: false,
        },
      } as never),
    );
    expect(meta.mentionedUsers[0].bot).toBe(true);
  });
});

describe("polls", () => {
  it("captures the poll, which is often the whole message", () => {
    const meta = getMessageMetadata(
      message({
        poll: {
          question: { text: "mau-each 500?" },
          allowMultiselect: false,
          expiresTimestamp: Date.now() / 1000 + 7200,
          answers: coll([
            [1, { id: 1, text: "Setuju", emoji: null }],
            [
              2,
              {
                id: 2,
                text: null,
                emoji: { name: "money", id: "99", animated: false },
              },
            ],
          ]),
        },
      } as never),
    );
    expect(meta.poll?.question).toBe("mau-each 500?");
    expect(meta.poll?.answers).toHaveLength(2);
    // The emoji object must be flattened, not serialised as an object graph.
    expect(meta.poll?.answers[1].emoji).toBe("<:money:99>");
  });
});

describe("round trip", () => {
  it("survives a JSON round trip with every new field intact", () => {
    const original = getMessageMetadata(
      message({
        components: [{ type: 1 }, { type: 1 }],
        pinned: true,
        tts: true,
        system: false,
        position: 7,
        hasThread: true,
        webhookId: "w1",
        applicationId: "app1",
        editedTimestamp: 1_700_000_900_000,
        flags: { bitfield: (1 << 1) | (1 << 4), has: () => false },
      } as never),
    );
    const parsed = parseRichMessageMetadata(JSON.stringify(original));
    expect(parsed).not.toBeNull();
    expect(parsed?.pinned).toBe(true);
    expect(parsed?.tts).toBe(true);
    expect(parsed?.position).toBe(7);
    expect(parsed?.hasThread).toBe(true);
    expect(parsed?.webhookId).toBe("w1");
    expect(parsed?.applicationId).toBe("app1");
    expect(parsed?.editedTimestamp).toBe(1_700_000_900_000);
    expect(parsed?.componentCount).toBe(2);
    expect(parsed?.flagNames).toContain("IS_CROSSPOST");
    expect(parsed?.mentionedChannels).toEqual([]);
  });

  it("parses a row captured before these fields existed", () => {
    // Backwards compatibility: old rows must not throw, and must not
    // fabricate values they never had.
    const legacy = JSON.stringify({
      stickers: [],
      embeds: [],
      attachments: [],
      customEmojis: [],
      mentionedRoles: [{ id: "r1", name: "Mod" }],
      mentionedUsers: [],
      author: {
        id: "u1",
        username: "budi",
        tag: null,
        avatarURL: null,
        bot: false,
      },
      member: null,
      channel: {
        channelId: "c",
        threadId: null,
        threadName: null,
        channelName: "g",
      },
      reference: null,
      isCrosspost: false,
    });
    const parsed = parseRichMessageMetadata(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed?.mentionedChannels).toEqual([]);
    expect(parsed?.flagNames).toBeUndefined();
    expect(parsed?.pinned).toBeUndefined();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(parseRichMessageMetadata("{not json")).toBeNull();
    expect(parseRichMessageMetadata(null)).toBeNull();
  });

  it("reports no attachments for a row with none", () => {
    expect(getAttachmentsFromMetadata(null)).toEqual([]);
    expect(getAttachmentsFromMetadata("{}")).toEqual([]);
  });
});
