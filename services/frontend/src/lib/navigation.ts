/**
 * Navigation.
 *
 * Exactly seven destinations, one per router the backend actually exposes
 * (dashboard, messages, channels, users, moderation, analysis, knowledge).
 *
 * The earlier frontend also linked /voice, /recordings and /media; those
 * backend modules no longer exist, so the routes are gone rather than left as
 * dead ends. `href` is the ONLY source of truth — the desktop rail, the mobile
 * dock and the command palette all read this array, so adding a destination
 * once makes it appear everywhere.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Short label for the mobile dock, where horizontal space is tight. */
  shortLabel: string;
  description: string;
  keywords: string[];
  /** Higher sorts earlier. */
  order: number;
}

export const navItems: readonly NavItem[] = [
  {
    href: "/dashboard",
    label: "Overview",
    shortLabel: "Home",
    description: "Guild-wide moderation health, activity, and top channels",
    keywords: ["home", "overview", "stats", "summary", "dashboard"],
    order: 1,
  },
  {
    href: "/messages",
    label: "Messages",
    shortLabel: "Msgs",
    description: "Live message stream with verdict and queue state",
    keywords: ["message", "chat", "stream", "feed", "live"],
    order: 2,
  },
  {
    href: "/moderation",
    label: "Moderation",
    shortLabel: "Mod",
    description: "Verdicts, enforcement actions, and coverage",
    keywords: ["moderation", "verdict", "flag", "action", "enforce", "delete"],
    order: 3,
  },
  {
    href: "/channels",
    label: "Channels",
    shortLabel: "Chans",
    description: "Per-channel volume, flagged rate, and culture",
    keywords: ["channel", "guild", "volume", "culture"],
    order: 4,
  },
  {
    href: "/users",
    label: "Users",
    shortLabel: "Users",
    description: "Most active members and their moderation profile",
    keywords: ["user", "member", "profile", "author", "top"],
    order: 5,
  },
  {
    href: "/analysis",
    label: "Analysis",
    shortLabel: "Search",
    description: "Search across analysed messages and their verdicts",
    keywords: ["analysis", "search", "query", "find", "grep"],
    order: 6,
  },
  {
    href: "/glossary",
    label: "Glossary",
    shortLabel: "Gloss",
    description: "Channel slang, term glossary, and flagged domains",
    keywords: ["glossary", "slang", "term", "culture", "dictionary", "scam"],
    order: 7,
  },
] as const;

/** The landing route. */
export const DEFAULT_ROUTE = "/dashboard";

/**
 * Resolve a path to its nav item. Trailing slashes are tolerated because the
 * app is built with `trailingSlash: true`, so a visited URL is `/moderation/`
 * while the item href is `/moderation`.
 */
export function activeNavItem(pathname: string): NavItem | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return navItems.find((item) => item.href === normalized) ?? null;
}

/** Substring match for the command palette; empty query returns everything. */
export function searchNavItems(query: string): NavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...navItems];

  return navItems.filter((item) => {
    const haystack = [
      item.label,
      item.shortLabel,
      item.description,
      item.href,
      ...item.keywords,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}
