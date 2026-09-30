/**
 * Read the captured rich evidence off a message row.
 *
 * The dashboard needs this for the same reason the moderation worker does:
 * `messages.content` is `""` for any post whose only payload is a link whose
 * preview Discord resolves after `messageCreate`, so a card that renders only
 * `content` shows an empty message for something that plainly carried a
 * Facebook photo. The resolved embed was captured in `messages.metadata` the
 * whole time.
 *
 * This mirrors `services/discord-gateway/src/modules/message-capture/messageMetadata.ts`
 * and is deliberately duplicated rather than shared: the two services are
 * deployed and versioned separately, and the gateway's copy pulls in Drizzle,
 * the config singleton and discord.js types, none of which belong in a
 * browser bundle. The `EmbedEvidence` shape below is the contract; if it
 * changes on the gateway side it changes here too, in the same commit.
 *
 * Every reader is defensive on purpose: a row captured before a field existed,
 * or a metadata column that is not valid JSON, must degrade to "no evidence"
 * rather than throw inside a React render.
 */

export interface EmbedEvidence {
  title: string | null;
  description: string | null;
  url: string | null;
  image: string | null;
  thumbnail: string | null;
  provider: { name: string | null; url: string | null } | null;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  footer: { text: string | null } | null;
  type?: string | null;
  video?: { url: string | null } | null;
}

export interface AttachmentEvidence {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
  width?: number | null;
  height?: number | null;
  description?: string | null;
  /**
   * Discord's spoiler marker. The gateway captures it, so the FE mirrors it:
   * a spoiler attachment is one of the things a moderator most needs to see
   * (the author flagged it as sensitive), and the gateway's own vision pass is
   * handed those images.
   */
  spoiler?: boolean;
}

export interface StickerEvidence {
  id: string;
  name: string;
  url: string;
  format: string | null;
  description?: string | null;
}

export interface ParsedMessageMetadata {
  embeds: EmbedEvidence[];
  attachments: AttachmentEvidence[];
  stickers: StickerEvidence[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Parse `messages.metadata` into the parts a card renders.
 *
 * Returns empty lists rather than throwing: a malformed or absent column is an
 * ordinary state here — rows predating the column, and the backend's own
 * synthetic rows (`messages.repository.ts:379`) all write `null`.
 */
export function parseMessageMetadata(
  metadata: string | null | undefined,
): ParsedMessageMetadata {
  const empty: ParsedMessageMetadata = {
    embeds: [],
    attachments: [],
    stickers: [],
  };
  if (!metadata) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const root = parsed as Record<string, unknown>;

  const embeds = Array.isArray(root.embeds)
    ? root.embeds
        .filter((e): e is Record<string, unknown> => Boolean(e))
        .map((e) => {
          const provider = e.provider as
            | Record<string, unknown>
            | null
            | undefined;
          const footer = e.footer as Record<string, unknown> | null | undefined;
          const video = e.video as Record<string, unknown> | null | undefined;
          return {
            title: asString(e.title),
            description: asString(e.description),
            url: asString(e.url),
            image: asString(e.image),
            thumbnail: asString(e.thumbnail),
            provider: provider
              ? { name: asString(provider.name), url: asString(provider.url) }
              : null,
            fields: Array.isArray(e.fields)
              ? e.fields
                  .filter((f): f is Record<string, unknown> => Boolean(f))
                  .map((f) => ({
                    name: String(f.name ?? ""),
                    value: String(f.value ?? ""),
                    inline: Boolean(f.inline),
                  }))
              : [],
            footer: footer ? { text: asString(footer.text) } : null,
            type: asString(e.type),
            video: video ? { url: asString(video.url) } : null,
          } satisfies EmbedEvidence;
        })
    : [];

  const attachments = Array.isArray(root.attachments)
    ? root.attachments
        .filter((a): a is Record<string, unknown> => Boolean(a))
        .map((a) => ({
          id: String(a.id ?? ""),
          name: String(a.name ?? "unknown"),
          url: String(a.url ?? ""),
          contentType: asString(a.contentType),
          size: Number(a.size ?? 0),
          width: typeof a.width === "number" ? a.width : null,
          height: typeof a.height === "number" ? a.height : null,
          description: asString(a.description),
          // Absent on rows captured before the gateway started recording it,
          // which is not the same as "not a spoiler" — hence the undefined
          // rather than a false, so the card only ever hides an image the
          // author actually marked.
          spoiler: typeof a.spoiler === "boolean" ? a.spoiler : undefined,
        }))
    : [];

  const stickers = Array.isArray(root.stickers)
    ? root.stickers
        .filter((s): s is Record<string, unknown> => Boolean(s))
        .map((s) => ({
          id: String(s.id ?? ""),
          name: String(s.name ?? ""),
          url: String(s.url ?? ""),
          format: asString(s.format),
          description: asString(s.description),
        }))
    : [];

  return { embeds, attachments, stickers };
}

export function readEmbeds(
  metadata: string | null | undefined,
): EmbedEvidence[] {
  return parseMessageMetadata(metadata).embeds;
}

export function readAttachments(
  metadata: string | null | undefined,
): AttachmentEvidence[] {
  return parseMessageMetadata(metadata).attachments;
}

export function readStickers(
  metadata: string | null | undefined,
): StickerEvidence[] {
  return parseMessageMetadata(metadata).stickers;
}

// ─── Attachment classification ──────────────────────────────────────────────

/**
 * Whether an attachment can be handed to an `<img>`.
 *
 * The gateway records `contentType` straight from Discord, so the MIME type is
 * the discriminator. A `video/mp4` must stay OUT: rendered as an `<img>` it is
 * a broken glyph, and an inline player on every feed row is bandwidth spent on
 * a surface whose job is deciding whether to escalate, not playback.
 */
export function isRenderableAttachment(
  attachment: AttachmentEvidence,
): boolean {
  const type = (attachment.contentType ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (type.startsWith("image/")) {
    // SVG and AVIF/HEIC are not universally decodable; an honest file chip is
    // better than a browser's broken-image placeholder.
    return !type.includes("svg") && !type.includes("avif");
  }
  if (type) return false;
  // No MIME recorded — a row captured before the column existed, or a bot that
  // sent none. Fall back to the extension, using the same list the gateway's
  // vision pass accepts.
  const ext = attachment.url
    .split("?")[0]
    .split("#")[0]
    .split(".")
    .pop()
    ?.toLowerCase();
  return ext
    ? ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)
    : false;
}

const VIDEO_EXTENSIONS = [
  "mp4",
  "webm",
  "mov",
  "m4v",
  "mkv",
  "avi",
  "mpg",
  "mpeg",
];

/** How a non-renderable attachment is labelled on the card. */
export function attachmentKindLabel(
  attachment: AttachmentEvidence,
): "video" | "audio" | "file" {
  const type = (attachment.contentType ?? "").toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  const ext = attachment.url
    .split("?")[0]
    .split("#")[0]
    .split(".")
    .pop()
    ?.toLowerCase();
  if (ext && VIDEO_EXTENSIONS.includes(ext)) return "video";
  return "file";
}

/** Every `http(s)` URL in the text, in order, de-duplicated. */
export function extractPostedUrls(
  content: string | null | undefined,
): string[] {
  if (!content) return [];
  const found = content.match(/https?:\/\/[^\s<>")\]]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

/**
 * Comparable form of a URL: no scheme, no `www.`, no trailing slash.
 *
 * Discord wraps every posted link in `t.co`, so the URL in the body is almost
 * never the URL the embed resolved to — a raw comparison pairs nothing.
 */
function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

export interface LinkEmbedPair {
  /** The URL the author actually wrote, as it appears in the message. */
  postedUrl: string;
  /** The destination the link resolved to, when known. */
  resolvedUrl: string | null;
  /** The embed Discord produced for it — the actual content. */
  embed: EmbedEvidence | null;
}

/**
 * Pair each posted link with the embed that resolved it.
 *
 * Mirrors `pairLinksWithEmbeds` in the gateway's `messageMetadata.ts`: the
 * dashboard and the moderation model must read the same message the same way.
 * Matching is exact, then normalised, then positional, because a `t.co`
 * wrapper matches neither of the first two.
 */
export function pairLinksWithEmbeds(
  content: string | null | undefined,
  metadata: string | null | undefined,
): LinkEmbedPair[] {
  const posted = extractPostedUrls(content);
  const embeds = readEmbeds(metadata);

  // Embed-only message (a bot posting rich media): the body is empty and the
  // only link lives in `embed.url`. Mirrors the gateway fix — returning `[]`
  // here is what made the dashboard say "empty message".
  if (posted.length === 0) {
    return embeds.map((embed) => ({
      postedUrl: "",
      resolvedUrl: embed.url ?? null,
      embed,
    }));
  }

  const pairs: LinkEmbedPair[] = posted.map((postedUrl) => {
    const normalized = normalizeUrl(postedUrl);
    const match = embeds.find(
      (e) =>
        e.url != null &&
        (e.url === postedUrl || normalizeUrl(e.url) === normalized),
    );
    return { postedUrl, resolvedUrl: null, embed: match ?? null };
  });

  for (const pair of pairs) {
    if (pair.embed) pair.resolvedUrl = pair.embed.url ?? null;
  }

  const spare = embeds.filter((e) => !pairs.some((p) => p.embed === e));
  let next = 0;
  for (const pair of pairs) {
    if (pair.embed) continue;
    const leftover = spare[next];
    if (!leftover) break;
    pair.embed = leftover;
    pair.resolvedUrl = leftover.url ?? null;
    next += 1;
  }
  return pairs;
}
