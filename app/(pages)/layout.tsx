import type { ReactNode } from 'react';

/**
 * Marketing-pages layout (route group `(pages)`).
 *
 * A few decorative/animated elements on the marketing pages — oversized section
 * numerals (`.section-number`, text-[10rem]) and slide-in transforms
 * (`.sd-slide--x`, translateX) — extend a few pixels past the viewport on
 * phones. The root already sets `overflow-x: clip`, but iOS Safari can still pan
 * horizontally when only the html element clips, so contain the overflow at the
 * marketing wrapper on small screens too.
 *
 * `clip` (not `hidden`) keeps `position: sticky` working; the wrapper is
 * content-height so it clips nothing vertically. md+ stays `visible`.
 */
export default function MarketingPagesLayout({ children }: { children: ReactNode }) {
  // `retro` scopes the retro-future design system (see app/globals.css) to the
  // public marketing tree only — the portal and admin keep their own palette
  // and type. Applying it here means every page in this route group inherits
  // the tokens without importing anything.
  //
  // `force-light` is NOT optional decoration next to it. The retro palette is
  // deliberately fixed — CreamBand pins its background to --retro-cream
  // (#F6F4F0) and every primitive hardcodes --retro-*. The CONTENT rendered on
  // those bands does not: blog bodies and 17 of the block renderers use
  // `text-foreground`, which resolves to var(--foreground) and flips to #ededed
  // under .dark. That is #ededed on #F6F4F0 — a contrast ratio of 1.07:1 where
  // AA needs 4.5:1, i.e. invisible. Light mode hid it, because the same text is
  // 15.92:1 there. Operator-reported on /blog/visual-block-editor-47-blocks.
  //
  // force-light pins the token set light for the whole subtree (see globals.css)
  // and, via the `@custom-variant dark` rule there, also stops any `dark:`
  // utility applying inside it — so a future block cannot reintroduce this.
  // app/sites/[domain]/layout.tsx applies it for exactly the same reason after
  // the same bug hit a tenant site on 2026-08-20. Do not remove it without
  // making every band's background theme-aware first.
  return (
    <div
      className="retro retro-paper force-light overflow-x-clip md:overflow-x-visible"
    >
      {children}
    </div>
  );
}
