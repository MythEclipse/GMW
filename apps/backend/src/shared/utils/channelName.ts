/**
 * Read `messages.metadata -> 'channel' ->> 'channelName'`.
 *
 * Prisma's query builder has no `->>` path expression, so the JSON traversal
 * these SQL fragments used to perform is done in JS.
 *
 * `messages.metadata` is a `text` column holding a JSON document — it is not a
 * jsonb column — so Prisma hands it back as the raw string and the parse has to
 * happen here. An object is accepted too, since `verdicts.evidence` IS jsonb and
 * callers reuse this for it. Returns `undefined` rather than throwing when the
 * value is null, unparseable, or lacks the key, matching the SQL, which yielded
 * NULL in every one of those cases.
 *
 * Shared because several repositories resolve channel names the same way: a
 * caller that wanted the id it fell back to had to re-implement the same
 * COALESCE(NULLIF(...), channel_id) shape.
 */
export function readChannelName(metadata: unknown): string | undefined {
  if (typeof metadata === "string") {
    if (metadata === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(metadata);
    } catch {
      // A malformed cell used to make the `::jsonb` cast abort the whole
      // query. One unreadable row must not take out the entire page.
      return undefined;
    }
    return readChannelName(parsed);
  }

  if (metadata == null || typeof metadata !== "object") return undefined;
  const channel = (metadata as Record<string, unknown>).channel;
  if (channel == null || typeof channel !== "object") return undefined;
  const name = (channel as Record<string, unknown>).channelName;
  return typeof name === "string" && name !== "" ? name : undefined;
}
