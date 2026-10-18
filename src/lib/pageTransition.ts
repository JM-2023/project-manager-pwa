import { flushSync } from "react-dom";

/* Tab switches — the new page settles in. The old page leaves in the same
   frame as the tap (you already left it; nothing of it lingers over the new
   one), the title row is in place from the first frame, and the content below
   lands row by row: each card or row fades up quickly and eases the last few
   px down into place, a beat after the one above. The navigation's sliding
   pill carries the switch itself; the content arrives quietly behind it.

   No blur, no overlap, no sideways travel. Tabs are peers, the page ground
   and title never change place, and every frame has something sharp to read.
   Only opacity and translate animate, and the tap frame does no work beyond
   rendering the new page and measuring its on-screen blocks.

   Deliberately not a View Transition: WebKit shows the new side of one as a
   still frame until it ends (the nav pill would freeze, the cascade would
   land all at once), and the page can't be tapped while one runs. */

/**
 * Jump the arriving page's own CSS entrances (the launch page-in rise,
 * sections and rows that fade up from 0, several of them staggered) to their
 * end state. They are written for things appearing within a page; under the
 * settle they would make the page arrive twice. Elements that mount later,
 * like a newly added row, still animate.
 */
function settleEntrances(page: Element): void {
  if (typeof CSSAnimation === "undefined") return;
  for (const animation of page.getAnimations({ subtree: true })) {
    if (!(animation instanceof CSSAnimation)) continue;
    if (animation.effect?.getComputedTiming().endTime === Infinity) continue;
    animation.finish();
  }
}

const RISE = 10; // px a block settles down from
const FADE = 170; // ms to full opacity — readable early
const SETTLE = 320; // ms to come to rest — the motion lingers past the fade
const FADE_EASING = "cubic-bezier(0.2, 0.7, 0.3, 1)";
const SETTLE_EASING = "cubic-bezier(0.2, 0.9, 0.25, 1)";
const STEP = 24; // ms between consecutive rows of blocks
const HEAD_START = 16; // ms the cascade is already in when the first frame paints
const MAX_ROWS = 6; // rows past this land with the sixth
const SAME_ROW = 8; // blocks whose tops sit this close land together
const ROW_MAX = 132; // a plain wrapper taller than this splits into its children
const MAX_KIDS = 12; // a grid of more on-screen cells (the month) lands whole
const MAX_UNITS = 32;

/** A block paints its own surface (card, band, chip): split it and its
    background would show before its content. */
function hasSurface(style: CSSStyleDeclaration): boolean {
  return (
    !/^(transparent|rgba\(.*,\s*0\))$/.test(style.backgroundColor) ||
    style.backgroundImage !== "none" ||
    style.boxShadow !== "none" ||
    parseFloat(style.borderTopWidth) > 0 ||
    parseFloat(style.borderBottomWidth) > 0
  );
}

function onScreen(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
}

/**
 * The blocks that land: walk down from the page, splitting plain wrappers
 * taller than a row into their on-screen children, and stop at anything a
 * row tall or smaller, at anything with a surface of its own, and at dense
 * grids. A task list comes apart into its cards; the month stays one piece.
 * Blocks off screen take no part — they are already settled when scrolled to.
 */
function collectUnits(page: Element): Array<{ el: HTMLElement; top: number; left: number }> {
  const units: Array<{ el: HTMLElement; top: number; left: number }> = [];
  const visit = (el: Element) => {
    if (!(el instanceof HTMLElement)) return;
    const style = getComputedStyle(el);
    if (style.display === "contents") {
      Array.from(el.children).forEach(visit);
      return;
    }
    if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed" || !onScreen(el)) return;
    const rect = el.getBoundingClientRect();
    const kids = Array.from(el.children).filter(onScreen);
    const splittable = units.length < MAX_UNITS && kids.length > 0 && kids.length <= MAX_KIDS && !hasSurface(style);
    if (rect.height > ROW_MAX && splittable) {
      kids.forEach(visit);
      return;
    }
    units.push({ el, top: rect.top, left: rect.left });
  };
  Array.from(page.children).forEach(visit);
  return units;
}

/** Animate one property from `from` to the element's own value, `delay` ms in. */
function land(el: HTMLElement, from: Keyframe, delay: number, duration: number, easing: string): void {
  // The delay is baked into the keyframes rather than set as one: a delayed
  // animation's backwards fill isn't reliably drawn by WebKit, so a later row
  // could show in place for a moment before hiding. There is no closing
  // keyframe, so the property settles on the element's own value (a disabled
  // button on its dimmed opacity; `translate` stacks with any transform).
  // The whole cascade starts a frame in, so the frame that replaces the old
  // page already shows the first row on its way, never a bare page.
  const total = delay + duration;
  const frames = delay > 0 ? [{ ...from, offset: 0 }, { ...from, offset: delay / total, easing }] : [{ ...from, offset: 0, easing }];
  el.animate(frames, { duration: total }).currentTime = HEAD_START;
}

/** Land blocks top to bottom: each row of blocks a beat after the one above. */
function landUnits(units: Array<{ el: HTMLElement; top: number; left: number }>): void {
  units.sort((a, b) => a.top - b.top || a.left - b.left);
  let row = -1;
  let rowTop = -Infinity;
  for (const { el, top } of units) {
    if (top - rowTop > SAME_ROW) {
      row += 1;
      rowTop = top;
    }
    if (typeof el.animate !== "function") continue;
    const delay = Math.min(row, MAX_ROWS - 1) * STEP;
    land(el, { opacity: 0 }, delay, FADE, FADE_EASING);
    land(el, { translate: `0 ${RISE}px` }, delay, SETTLE, SETTLE_EASING);
  }
}

/** Land the page's on-screen blocks below its title, top to bottom. */
function settleIn(page: Element): void {
  // The title row is the anchor: it is in place from the first frame, and
  // so is anything level with it (the date arrows, the settings eyebrow).
  const anchorBottom = page.querySelector("h1")?.getBoundingClientRect().bottom ?? 0;
  landUnits(collectUnits(page).filter((unit) => unit.top >= anchorBottom));
}

/**
 * Settle content swapped in place on the current page (another project's
 * tasks, the other search scope) the way a tab switch lands a page. Call it
 * once the new content is in the DOM and before the frame is painted (from a
 * layout effect). Blocks off screen take no part.
 */
export function settleRegion(region: Element | null): void {
  if (!region || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  landUnits(collectUnits(region));
}

/* ---------- the switch ------------------------------------------------ */

/**
 * Run a tab swap and settle the new page in. `changed` false (the current tab
 * tapped again) swaps instantly.
 */
export function switchPageAnimated(changed: boolean, swap: () => void): void {
  if (!changed || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    swap();
    return;
  }
  // flushSync: the new page must be in the DOM (scrolled to the top, its
  // canvases painted) before its blocks are measured, all in this task so no
  // frame shows it unprepared.
  flushSync(swap);
  const page = document.querySelector(".page-content");
  if (page) {
    settleEntrances(page);
    settleIn(page);
  }
}
