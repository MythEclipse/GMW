# GMW Frontend Redesign Plan (2026-09-29)

Status: PROPOSED — awaiting user approval before any code is written.
Scope: `services/frontend` only. No backend/oRPC contract changes, no nav
metaphor change, no new colour language beyond the token ramp already in
`globals.css`.

---

## 1. Why this plan exists

Four things were verified before writing it.

**Just over half the design system is dead weight.** `globals.css` (1014 lines)
declares **78 classes; 37 are referenced anywhere in `src/`, 41 are not.** The
dead ones include `glitch-text`, `radar-sweep`, `gradient-border`, `border-trace`,
`cursor-blink`, `noise-overlay`, `scan-line`, `ticker-digit`, `typing-dots`,
`reveal-up`, `data-flash`, `game-sweep`, `stagger-item`, `pop-in`,
`animate-breathe`, `animate-spin-disc`, `animate-shimmer`, and seven unused
safe-area utilities. They are the residue of two reverted redesign attempts
(`eda5c752` reverted the constellation nav; `2797eda4` replaced the GSAP
treatment during the Vite SPA migration). The reduced-motion kill-list in the
same file still guards classes that no longer exist.

That is why the live site reads as *competent but generic*: the distinctive
tactical language was deleted, and what survived is the plain shadcn layer.

**The 52 unused shadcn primitives are the missing design vocabulary.**
`src/components/ui/` holds 61 primitives. Only 9 are ever imported outside the
folder: `badge`, `button`, `input`, `select`, `tabs`, `table`, `textarea`,
`dialog`, `dropdown-menu`. Everything else — `tooltip`, `popover`, `sheet`,
`command`, `hover-card`, `drawer`, `scroll-area`, `progress`, `toggle`,
`skeleton`, `separator`, `kbd` — is vendored and unrendered. The materials for a
richer surface already exist; nothing uses them.

**The data is far richer than the UI exposes.** The backend offers procedures the
frontend never calls: `attachmentsByChannel`, plus three hooks
(`useMessageActivity`, `useUserDetail`, `useChannelDetail`) that are defined and
never used by a view. `analysis_queue_status` is declared on the WS contract and
pushed live by the gateway, but no component subscribes — the queue's own health
telemetry is received and discarded. The frontend declares 26 WS event types and
consumes 4.

**Hard-won constraints (do not re-litigate):**
- 2026-08-24: the constellation/three.js nav was SHIPPED green on every gate,
  then REJECTED for hurting usability and fully reverted. Never again.
- The 2026-08-26 spec (`2026-08-26-fe-rombak-gsap-wide.md`) asked for "sekeren
  mungkin" with GSAP. GSAP was subsequently removed from the project
  (`611ba399` replaced it with CSS animations). Do not reintroduce GSAP — it is
  not a dependency, and that spec's assumptions are stale anyway (it targets
  `next build` and the `voice`/`recordings`/`media` routes, none of which
  exist).
- `nav-rail.tsx:8-14` carries an explicit instruction: keep the plain vertical
  rail. Do not replace it.
- The oxlint `shadcn/*` design gate (`services/frontend/.oxlintrc.json`) is
  `error`-level. It forbids raw hex colours, inline styles, primitive restyling
  and arbitrary values. New CSS must live in `globals.css` as a token or a named
  class — the reason the charts are hand-rolled SVG rather than recharts.

---

## 2. The design thesis

**Direction: "Quiet Ops Room" — a precision instrument, not a sci-fi HUD.**

Both rejected attempts failed the same way: decoration competed with data. The
accepted direction was, and remains, monochrome + restrained accent. This plan
keeps that and spends the creative budget where it earns attention — on *state
legibility* and *drill-down*, not on atmosphere.

Three principles:

1. **Colour is a signal, never a texture.** Accent indigo appears only for
   (a) live/active state, (b) the single most severe item on screen. Everything
   else is ink or surface. This is already the token model; the redesign's job
   is to enforce it, not expand it.
2. **Every number drills down.** A stat tile is a button that navigates to the
   filtered list behind it. Today `Flagged 1.2K` and `In queue 419` are inert
   text. This is the highest-value change in the plan.
3. **Motion carries meaning or it does not exist.** Live data arriving gets a
   restrained highlight. Nothing loops for decoration. Everything respects
   `prefers-reduced-motion`.

The one genuinely new visual idea — the only one proposed — is the **Queue
Ribbon**: a persistent 4px strip rendered from live `analysis_queue_status`
telemetry showing the moderation pipeline's actual health. It is the app's
signature, it is 100% real data, and it gives the monochrome palette something to
say.

---

## 3. Workstreams

Each is an independent, revertible commit. Order matters: W1 unblocks the rest.

### W1 — Delete the dead design system and the dead UI vocabulary (PREREQUISITE)

Removes the noise that makes every later change look like a rewrite.

- `globals.css`: delete the 41 unreferenced classes, the duplicate
  `@keyframes pulse-ring` (declared at lines 867 and 902 — the second silently
  wins), and the 10 stale reduced-motion entries. Net roughly −450 lines.
- Fix two real defects found during the audit:
  - `bottom-safe-nav-rail` is **referenced** by `mobile-nav.tsx:58` but never
    defined (the defined one is `mb-safe-nav-rail`). The mobile dock's iOS
    home-indicator clearance is currently doing nothing.
  - `--color-primary-foreground: #f8fafc` on `#4f46e5` is ~1.9:1 — below WCAG AA
    for normal text. It is hardcoded rather than tokenised precisely so this was
    never checked. Fix by tokenising, not by hardcoding a different hex.
- Delete the 52 unrendered shadcn primitives, keeping the 9 in use plus any W2-W6
  pulls in. `sidebar.tsx`, `command.tsx`, `carousel.tsx` and
  `message-scroller.tsx` are large and entirely unreferenced.
- Drop the verified-unused deps: `date-fns`, `recharts`, `embla-carousel-react`,
  `react-day-picker`, `input-otp`, `react-resizable-panels`,
  `babel-plugin-react-compiler`. (`clsx`/`tailwind-merge` are **not** unused —
  `cn` is the drop-in that replaced them. `tailwindcss`/`tw-animate-css` are
  imported by CSS, not JS.)

Outcome: `globals.css` becomes a real token layer instead of an archaeology dig.

**Verify:** `bun typecheck`, `bun lint`, `bun run build`, then a 7-route local
pass.

### W2 — Make every headline number navigable

Highest value per line of code in the plan.

- `StatTile` gains an optional `to` (and later `sparkline`). Rendered as a `Link`
  when `to` is set, a `div` when not. A tile with a `to` gets a chevron
  affordance and a hover state previewing the destination.
- Wire each existing tile to a filter that already exists in the router:
  - `Flagged` → `/messages?status=dead` (already linked from the dead-queue callout)
  - `In queue` → `/moderation`
  - `Judged` / `Awaiting verdict` / `Coverage` → `/moderation`
  - `Active members` → `/users`
- Teach the target routes to **read those query params on mount** so the link
  actually applies its filter. Today `messages/view.tsx` and `moderation/view.tsx`
  initialise filter state to `""`/`ANY` and ignore the URL entirely — which makes
  the one existing drill-down link in the app a dead link.
- Every list view gets a visible result count and a "clear filters" affordance
  when it hits zero.

**Verify:** click all 6 drill-downs; confirm the filter chip is applied on arrival
and survives a reload.

### W3 — The Queue Ribbon (the one new signature element)

- Subscribe to `analysis_queue_status` in the shell (`providers.tsx`), not in a
  view, so the ribbon is always mounted and the chrome never remounts.
- Render a fixed 4px strip under the topbar: width = pipeline saturation, colour
  ramping `success → amber → danger` as `activeRequests` /
  `individualCircuitBreakerActive` / `lastError` change. Expands on hover/focus
  into a readout: queued, in-flight, circuit-breaker state, last error.
- `aria-live="polite"`, and never the only place that information exists — the
  same numbers stay on the moderation tiles.
- No pulse loop when the pipeline is idle (reduced-motion).

**Verify:** with a live backend, watch it react to a real `analysis_queue_status`
push. Also test degraded: socket down → must show "unknown", not "healthy".

### W4 — Surface live data the app already receives and throws away

- The dashboard's `reactions`/`reactors` already revalidate on WS events but
  ignore the payload. Add restrained "updated" affordances driven by the push
  rather than by a poll.
- Put the three defined-but-unused hooks to work: `useMessageActivity` (per-hour
  volume heatmap — already a backend procedure), `useUserDetail`,
  `useChannelDetail`. These are the drill-down targets W2's links want.
- Replace the 7 near-identical `<div className="space-y-4"><header><h1
  font-display text-xl…>` page headers with one `<PageHeader>` primitive owning
  title, subtitle and action slot. Every view currently re-derives it.

**Verify:** each new panel renders real data; no `—` placeholders.

### W5 — Typography, density, and the wide-screen problem

- **No max-width anywhere.** `providers.tsx:45` is
  `<main className="min-w-0 flex-1 px-4 pt-4 pb-24 lg:pb-8">` and `globals.css`
  contains zero `max-w-*`. On a 2560px monitor content stretches edge to edge and
  the ranked bars become unreadable 2000px hairlines. Add a container (as a
  token in `globals.css`) for the dashboard grid. Confirmed on the live site: the
  area chart renders as a stretched sliver.
- Consolidate the micro-type scale. The file declares 3 sub-12px steps
  (`--text-2xs`, `--text-micro`, `--text-micro-lg`) — a real accessibility
  problem. Raise the floor to 11px, keep mono for IDs/timestamps only, delete
  `--text-2xs`.
- Give `hud-card` a real 3-step elevation ladder instead of one shadow for every
  surface.

**Verify:** load `/dashboard` at 1440px, 1920px, 2560px. No hairlines, no
sub-11px text, no stretched charts.

### W6 — Mobile and accessibility pass

- The mobile dock fits 7 destinations in a horizontally-scrolling row, leaving 4
  off-screen with no affordance indicating that. Rebuild as a 2-row or
  overflow-menu dock, or move the low-traffic routes (glossary, analysis) into
  the command palette. Keep all 7 reachable — the current code's own comment
  calls a partial dock a bug.
- Keep the a11y primitives in W1 (`tooltip`, `popover`, `sheet`).
- `:focus-visible` rings are already correct; verify they survive the W5 type
  changes.
- Regenerate the `prefers-reduced-motion` kill-list from the classes that
  actually exist, not the current stale list.

**Verify:** keyboard-only pass on all 7 routes; 360px viewport pass.

### W7 — Polish, gated behind a real preview

Deliberately last and deliberately small. Only if W1-W6 land and the result still
reads as generic:

- A restrained entrance transition per route (one shared primitive, not per-route
  choreography).
- Subtle hover-reveal of a message card's full text / analysis.
- ⌘K works but is reachable on mobile only via the topbar button — surface it
  properly.

**No new visual metaphor. No WebGL. No constellation. No GSAP.**

---

## 4. Explicitly out of scope

- Backend changes of any kind. Every panel here is built on procedures and WS
  events that already exist.
- Replacing the nav rail, topbar or mobile dock *metaphor*. (W6 rebuilds the
  mobile dock's layout, not its concept.)
- A new animation library. CSS only, as today.
- Saturated colours or a second accent.
- Lazy-loading / code-splitting. `router.tsx:32-36` documents that decision
  deliberately; the bundle is 231 kB gzipped. Revisit only if it grows.

---

## 5. Delivery plan

| # | Workstream | Risk | Reversible |
|---|-----------|------|-----------|
| W1 | Delete dead CSS + primitives + deps | Medium — many files | Yes, single revert |
| W2 | Drill-down navigation | Low | Yes |
| W3 | Queue Ribbon | Medium — new always-on component | Yes |
| W4 | Live data + PageHeader | Low | Yes |
| W5 | Type/density/width | Medium — touches every view | Yes |
| W6 | Mobile + a11y | Medium | Yes |
| W7 | Polish | Low | Yes, drop it |

Suggested order: **W1 → W2 → W5 → W4 → W3 → W6 → W7**. W5 before W4 because the
container and typography work changes how every panel reads, and it is cheaper
to build new panels into the corrected layout than to redo them.

Every workstream ships as its own atomic commit, following the repo convention of
no `Co-Authored-By` trailer, then verified against the live site with
`browser_vision` before being called done. Per W1's own lesson, nothing is called
done from reading code.

---

## 6. Risk register

| Risk | Mitigation |
|------|-----------|
| Redesign drifts back toward the rejected sci-fi HUD | §2 states the thesis; W7 explicitly forbids a new metaphor; the 2026-08-24 rejection is recorded in §1 as a hard constraint |
| W1's mass deletion breaks something subtle | `bun typecheck && bun lint && bun run build` after every sub-step, plus a 7-route local pass before commit |
| W2's drill-down links land on views that ignore query params | This is a stated deliverable of W2, not an assumption |
| W3's ribbon reads as "healthy" while the socket is down | Degraded state is an explicit acceptance criterion in W3 |
| Bundle grows past the no-lazy-loading threshold | W1 removes ~7 unused deps; measure after |

---

## 7. How we'll know it worked

Measured against the live site before/after, at the same three viewports:

1. **Drill-down:** every stat tile navigates to a pre-filtered list. (Was: 0 of 6.)
2. **Dead code:** 0 unreferenced classes in `globals.css`; 0 unrendered shadcn
   primitives. (Was: 41 of 78 classes, and 52 of 61 primitives.)
3. **Live telemetry:** the pipeline's own health is on screen at all times.
   (Was: received and discarded.)
4. **Legibility:** no sub-11px text, no chart or hairline wider than the
   container. (Was: 3 sub-12px type steps, zero max-widths.)
5. **Mobile:** all 7 destinations reachable without horizontal scrolling at 360px.
   (Was: 4 of 7 off-screen.)
6. **Restraint:** accent indigo still appears only for live/active/severe state.
   Screenshot both themes and count saturated pixels — it should go *down*, not up.

---

## 8. Decisions needed from you

**Q1.** W1 deletes ~41 CSS classes, 52 shadcn primitives and 7 dependencies.
Restoring them later is manual work. Comfortable with that scope, or should W1 be
limited to CSS only (leave the primitives in case a later workstream wants them)?

**Q2.** The one new visual idea is the Queue Ribbon (W3) — always-on chrome. If
you'd rather have zero new persistent UI, W3 can be dropped and that budget
redirected into W4/W5.

**Q3.** W2 changes navigation *behaviour* (query params read on mount). It is the
one workstream that can surprise an existing user mid-task. Keep it?

---

## 9. Approval

This document is a plan, not an implementation. No frontend code has been
modified. `git status` is clean and `bun typecheck` + `bun run build` pass on the
current tree. Nothing proceeds until the three questions in §8 are answered.
