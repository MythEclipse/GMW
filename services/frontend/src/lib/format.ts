/**
 * Presentation helpers.
 *
 * Every timestamp in this system is EPOCH MILLISECONDS in a `bigint` column,
 * never a Postgres `timestamp` and never an ISO string from the API. Passing
 * one of these to `new Date()` is correct; passing it to a formatter that
 * expects seconds renders 1970.
 */

const numberFormatter = new Intl.NumberFormat("id-ID");
const compactFormatter = new Intl.NumberFormat("id-ID", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return numberFormatter.format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return compactFormatter.format(value);
}

export function formatPercent(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatDateTime(epochMs: number | null | undefined): string {
  if (epochMs == null) return "—";
  return new Date(epochMs).toLocaleString("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDate(epochMs: number | null | undefined): string {
  if (epochMs == null) return "—";
  return new Date(epochMs).toLocaleDateString("id-ID", { dateStyle: "medium" });
}

export function formatTime(epochMs: number | null | undefined): string {
  if (epochMs == null) return "—";
  return new Date(epochMs).toLocaleTimeString("id-ID", { timeStyle: "short" });
}

/** "3 minutes ago" / "just now" — for live feeds. */
export function formatRelative(
  epochMs: number | null | undefined,
  now = Date.now(),
): string {
  if (epochMs == null) return "—";
  const diff = now - epochMs;
  if (diff < 0) return "just now";

  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** Truncate for a dense tile without cutting mid-word where avoidable. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice}…`;
}

/** Turn a snake_case key into a human label: `nsfw_minor` → `Nsfw minor`. */
export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Discord snowflakes are strings; never coerce them through Number(). */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

/**
 * Discord channel names are stored without the emoji prefix, so fall back to
 * the raw id rather than rendering an empty heading.
 */
export function channelLabel(name: string | null, id: string): string {
  return name && name.trim().length > 0 ? name : `#${id}`;
}
