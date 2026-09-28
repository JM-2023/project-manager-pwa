import { flushSync } from "react-dom";

/* Tab switches — a focus pull, not a slide. The outgoing page defocuses and
   dissolves where it stands; the incoming page's blocks (header, cards, rows)
   come into focus in place, top to bottom, a beat apart, the first ones
   already sharpening while the old page is still clearing over them. Nothing
   travels sideways: the page is swapped under the reader's eye rather than
   moved.

   Deliberately not a View Transition. WebKit shows the new side of one as a
   still frame until the transition ends, so a cascade running underneath is
   invisible and then lands all at once — on iPhone Safari that read as the
   page appearing, vanishing and appearing again. Instead the old page's
   on-screen part is cloned into an inert overlay (the "ghost") that blurs
   out over the live new page. The navigation and the sync pill sit above
   the ghost and never blur. */

/* ---------- the ghost: the old page, defocusing ----------------------- */

const GHOST_MS = 180;
const GHOST_BLUR = 10;

let ghost: HTMLElement | null = null;

function dropGhost(): void {
  ghost?.remove();
  ghost = null;
}

/** Clone the page as it looks right now into a fixed overlay at the same spot. */
function makeGhost(page: HTMLElement): HTMLElement {
  const rect = page.getBoundingClientRect();
  const clone = page.cloneNode(true) as HTMLElement;
  Object.assign(clone.style, {
    position: "absolute",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    margin: "0"
  });
  // cloneNode copies markup, not live state: canvases come back blank, form
  // controls at their default values and scrollers (the project chip rail,
  // the table's sideways scroll) at their start. Scroll offsets need layout,
  // so they are noted now and restored once the clone is in the document.
  const sources = Array.from(page.querySelectorAll("*"));
  const scrolled = sources.flatMap((el, i) => (el.scrollTop || el.scrollLeft ? [i] : []));
  const heights = sources.map((el) => el.getBoundingClientRect().height);
  const from = page.querySelectorAll("canvas, input, select, textarea");
  const to = clone.querySelectorAll("canvas, input, select, textarea");
  from.forEach((source, i) => {
    const target = to[i];
    if (source instanceof HTMLCanvasElement && target instanceof HTMLCanvasElement) {
      target.width = source.width;
      target.height = source.height;
      if (source.width > 0 && source.height > 0) target.getContext("2d")?.drawImage(source, 0, 0);
    } else if ("value" in source && "value" in target) {
      (target as HTMLInputElement).value = (source as HTMLInputElement).value;
    }
  });
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  clone.removeAttribute("id");

  // The overlay is an empty copy of the shell, so the page's custom
  // properties (--page-inset, the rail spacing, the per-page width picked by
  // .app-shell:has(...)) resolve exactly as they did for the original.
  const shell = page.closest(".app-shell");
  const overlay = shell ? (shell.cloneNode(false) as HTMLElement) : document.createElement("div");
  overlay.classList.add("page-ghost");
  overlay.removeAttribute("id");
  overlay.setAttribute("aria-hidden", "true");
  overlay.inert = true;
  overlay.appendChild(clone);
  document.body.appendChild(overlay);
  const targets = clone.querySelectorAll("*");
  // A fresh layout of the same markup isn't always the same layout: WebKit
  // gives a collapsed `grid-template-rows: 0fr` task editor its content's
  // height on first layout, where the live one had settled at 0, and every
  // row below would drop. Pin whatever came out a different height (all
  // reads first, then all writes, so it costs one extra layout).
  const drifted = heights.flatMap((height, i) =>
    targets[i] instanceof HTMLElement && Math.abs(targets[i].getBoundingClientRect().height - height) > 0.5 ? [i] : []
  );
  for (const i of drifted) (targets[i] as HTMLElement).style.height = `${heights[i]}px`;
  for (const i of scrolled) {
    targets[i].scrollTop = sources[i].scrollTop;
    targets[i].scrollLeft = sources[i].scrollLeft;
  }
  return overlay;
}

/* ---------- the arriving page ----------------------------------------- */

/**
 * Jump the arriving page's own CSS entrances (the launch page-in rise,
 * sections and rows that fade up from 0, several of them staggered) to their
 * end state. They are written for things appearing within a page; under the
 * focus cascade they would make the page arrive twice. Elements that mount
 * later, like a newly added row, still animate.
 */
function settleEntrances(page: Element): void {
  if (typeof CSSAnimation === "undefined") return;
  for (const animation of page.getAnimations({ subtree: true })) {
    if (!(animation instanceof CSSAnimation)) continue;
    if (animation.effect?.getComputedTiming().endTime === Infinity) continue;
    animation.finish();
  }
}

const BLUR = 8; // px of defocus a block starts from
const RISE = 5; // px it settles down from — barely there, the blur carries it
const DURATION = 340;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const LEAD = 16; // the first block starts while the ghost is still clearing
const STEP = 34; // ms between consecutive rows of blocks
const MAX_DELAY = 300; // long pages finish their cascade inside this window
const SAME_ROW = 8; // blocks whose tops sit this close enter together
const MAX_UNITS = 24; // past this, blocks stop splitting (each blur is a layer)
const MAX_KIDS = 12; // a grid of many small cells (the month) enters whole

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

/**
 * The blocks that come into focus: walk down from the page, splitting plain
 * wrappers taller than about a quarter of the screen into their children, and
 * stop at anything smaller, at anything with a surface of its own, and at
 * dense grids. Only blocks on screen take part; the rest are already settled
 * when scrolled to.
 */
function collectUnits(page: Element): Array<{ el: HTMLElement; top: number; left: number }> {
  const viewH = window.innerHeight;
  const units: Array<{ el: HTMLElement; top: number; left: number }> = [];
  const visit = (el: Element) => {
    if (!(el instanceof HTMLElement)) return;
    const style = getComputedStyle(el);
    if (style.display === "contents") {
      Array.from(el.children).forEach(visit);
      return;
    }
    if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.top >= viewH) return;
    const kids = Array.from(el.children);
    const splittable =
      units.length < MAX_UNITS && kids.length > 0 && kids.length <= MAX_KIDS && !hasSurface(style);
    if (rect.height > viewH * 0.26 && splittable) {
      kids.forEach(visit);
      return;
    }
    units.push({ el, top: rect.top, left: rect.left });
  };
  Array.from(page.children).forEach(visit);
  return units;
}

/** Bring the page's on-screen blocks into focus, top to bottom. */
function focusCascade(page: Element): void {
  const units = collectUnits(page).sort((a, b) => a.top - b.top || a.left - b.left);
  const hidden = { opacity: 0, filter: `blur(${BLUR}px)`, translate: `0 ${RISE}px` };
  let row = -1;
  let rowTop = -Infinity;
  for (const { el, top } of units) {
    if (top - rowTop > SAME_ROW) {
      row += 1;
      rowTop = top;
    }
    if (typeof el.animate !== "function") continue;
    // The stagger is baked into the keyframes rather than set as a delay: a
    // delayed animation's backwards fill isn't reliably drawn by WebKit, so
    // later rows could show sharp for a moment before hiding. There is no
    // closing keyframe, so each property settles on the element's own value
    // (a disabled button on its dimmed opacity; the rise uses `translate`,
    // which stacks with any transform the block already has).
    const delay = LEAD + Math.min(row * STEP, MAX_DELAY);
    const total = delay + DURATION;
    el.animate(
      [
        { ...hidden, offset: 0 },
        { ...hidden, offset: delay / total, easing: EASING }
      ],
      { duration: total }
    );
  }
}

/* ---------- the switch ------------------------------------------------ */

/**
 * Run a tab swap with the focus pull. `changed` false (the current tab tapped
 * again) swaps instantly.
 */
export function switchPageAnimated(changed: boolean, swap: () => void): void {
  dropGhost();
  const oldPage = document.querySelector<HTMLElement>(".page-content");
  if (!changed || !oldPage || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    swap();
    return;
  }
  const overlay = makeGhost(oldPage);
  ghost = overlay;
  // flushSync: the new page must be in the DOM (scrolled to the top, its
  // canvases painted) before its blocks are measured, all in this task so no
  // frame shows it unprepared.
  flushSync(swap);
  const page = document.querySelector(".page-content");
  if (page) {
    settleEntrances(page);
    focusCascade(page);
  }
  // The blur comes up fast and the opacity lingers behind it: for the first
  // beat the old page is still there, just out of focus, while the new
  // header is already sharpening through it — no moment where both are faint.
  const fade = overlay.animate(
    [
      { opacity: 1, filter: "blur(0px)" },
      { opacity: 0.7, filter: `blur(${GHOST_BLUR * 0.8}px)`, offset: 0.3 },
      { opacity: 0, filter: `blur(${GHOST_BLUR}px)` }
    ],
    { duration: GHOST_MS, fill: "forwards" }
  );
  fade.finished.then(() => {
    if (ghost === overlay) dropGhost();
  }, () => undefined);
}
