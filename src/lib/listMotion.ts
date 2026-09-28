import { useLayoutEffect, useReducer, useRef, type RefObject } from "react";

/**
 * One motion layer for a keyed list: rows that arrive fade in, rows that
 * leave fold shut, and rows whose position changes glide there (FLIP) —
 * whatever caused the change: a local edit, a re-sort, a roll-over, or a
 * sync from another device.
 *
 * The data can drop an item immediately; the layer keeps rendering it in its
 * old slot, flagged `exiting`, until its fold lands. Rows are found by
 * `data-motion-key` inside `containerRef`, so row components need no wiring
 * beyond that attribute and honouring `exiting` (inert, no writes).
 *
 * Positions are read during render, while the DOM still shows the previous
 * commit, and again in a layout effect after it, so every move starts from
 * where the row visibly was, including mid-animation.
 */

export interface MotionEntry<T> {
  key: string;
  item: T;
  exiting: boolean;
}

interface Committed<T> {
  mounted: boolean;
  entries: MotionEntry<T>[];
  present: ReadonlySet<string>;
  sig: string;
}

interface Box {
  top: number;
  left: number;
  height: number;
}

const MOVE_MS = 380;
const ENTER_MS = 360;
const EXIT_MS = 380;
const FADE_MS = 220;
const STAGGER_MS = 36;
const MAX_STAGGER_MS = 240;
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

const moves = new WeakMap<HTMLElement, Animation>();
const exits = new WeakMap<Element, Animation[]>();

function settle(node: HTMLElement): void {
  moves.delete(node);
  node.classList.remove("is-moving");
  node.style.zIndex = "";
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function nodesIn(container: HTMLElement | null): Map<string, HTMLElement> {
  const nodes = new Map<string, HTMLElement>();
  if (!container) return nodes;
  for (const node of container.querySelectorAll<HTMLElement>("[data-motion-key]")) {
    const key = node.dataset.motionKey;
    if (key) nodes.set(key, node);
  }
  return nodes;
}

function boxOf(node: Element): Box {
  const rect = node.getBoundingClientRect();
  return { top: rect.top, left: rect.left, height: rect.height };
}

function onScreen(box: Box): boolean {
  return box.top + box.height > 0 && box.top < window.innerHeight;
}

function scrollParent(node: HTMLElement): Element | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return document.scrollingElement;
}

/** Fold a block shut: its box collapses to nothing while its content fades
 * ahead of it, so neighbours glide over an emptying gap rather than crush a
 * card. The stagger is baked into the keyframes (WebKit doesn't reliably draw
 * a delayed animation's backwards fill). Both animations hold their end state
 * until the caller unmounts or cancels them. */
function fold(node: HTMLElement, delay: number): Animation[] {
  const style = getComputedStyle(node);
  const open = {
    height: style.height,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
    borderTopWidth: style.borderTopWidth,
    borderBottomWidth: style.borderBottomWidth
  };
  const shut = {
    height: "0px",
    paddingTop: "0px",
    paddingBottom: "0px",
    marginTop: "0px",
    marginBottom: "0px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px"
  };
  const total = delay + EXIT_MS;
  const start = delay / total;
  const box = node.animate(
    [
      { ...open, offset: 0 },
      { ...open, offset: start, easing: EASE_OUT },
      { ...shut, offset: 1 }
    ],
    { duration: total, fill: "forwards" }
  );
  const fade = node.animate(
    [
      { opacity: 1, scale: "1", offset: 0 },
      { opacity: 1, scale: "1", offset: start, easing: EASE },
      { opacity: 0, scale: "0.98", offset: (delay + FADE_MS) / total },
      { opacity: 0, scale: "0.98", offset: 1 }
    ],
    { duration: total, fill: "forwards" }
  );
  return [box, fade];
}

/**
 * The rows to render: `items` in order, plus every row still folding out,
 * each kept behind whatever preceded it in the previous render. A row that
 * left `items` becomes an exit only if the data no longer holds it
 * (`present`); one whose fold has landed (`done`) is dropped.
 */
export function mergeExits<T>(
  previous: readonly MotionEntry<T>[],
  items: readonly T[],
  keyOf: (item: T) => string,
  present: ReadonlySet<string>,
  done: ReadonlySet<string>
): MotionEntry<T>[] {
  const live = new Set(items.map(keyOf));
  const leaving = new Map<string, T>();
  const behind = new Map<string | null, string[]>();
  let after: string | null = null;
  for (const entry of previous) {
    if (live.has(entry.key)) {
      after = entry.key;
      continue;
    }
    const still = entry.exiting ? !done.has(entry.key) : !present.has(entry.key);
    if (!still) continue;
    leaving.set(entry.key, entry.item);
    const list = behind.get(after) ?? [];
    list.push(entry.key);
    behind.set(after, list);
    after = entry.key;
  }
  const entries: MotionEntry<T>[] = [];
  const emitBehind = (anchor: string | null) => {
    for (const key of behind.get(anchor) ?? []) {
      entries.push({ key, item: leaving.get(key)!, exiting: true });
      emitBehind(key);
    }
  };
  emitBehind(null);
  for (const item of items) {
    const key = keyOf(item);
    entries.push({ key, item, exiting: false });
    emitBehind(key);
  }
  return entries;
}

export function useListMotion<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  containerRef: RefObject<HTMLElement>,
  /** Every key the data still holds. A row missing from `items` but still
   * present (paged out, not deleted) drops without an exit, and a row that
   * joins `items` from here (paged in) arrives without an entrance. */
  present: ReadonlySet<string>
): MotionEntry<T>[] {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const committedRef = useRef<Committed<T>>({ mounted: false, entries: [], present: new Set(), sig: "" });
  const doneRef = useRef(new Set<string>());
  const firstRef = useRef<{ boxes: Map<string, Box>; scrollTop: number } | null>(null);
  const tableAnimsRef = useRef<Animation[] | null>(null);

  // ---- render: merge the live items with the rows still folding out ----
  const committed = committedRef.current;
  const entries = mergeExits(committed.entries, items, keyOf, present, doneRef.current);
  const sig = entries.map((entry) => (entry.exiting ? `~${entry.key}` : entry.key)).join("|");
  if (sig !== committed.sig && committed.mounted) {
    const boxes = new Map<string, Box>();
    for (const [key, node] of nodesIn(containerRef.current)) boxes.set(key, boxOf(node));
    firstRef.current = { boxes, scrollTop: document.scrollingElement?.scrollTop ?? 0 };
  }

  // ---- commit: play what changed -----------------------------------------
  useLayoutEffect(() => {
    const previous = committedRef.current;
    const measured = firstRef.current;
    firstRef.current = null;
    // WebKit drops the page back to the top when keyed rows are reordered
    // (the DOM moves alone do it, before any of this code runs). A re-sort
    // must never move the page: put it back before the frame is painted.
    const scroller = document.scrollingElement;
    if (measured && scroller && scroller.scrollTop !== measured.scrollTop) {
      scroller.scrollTop = measured.scrollTop;
    }
    const first = measured?.boxes;
    committedRef.current = { mounted: true, entries, present, sig };
    const rendered = new Set(entries.map((entry) => entry.key));
    for (const key of doneRef.current) if (!rendered.has(key)) doneRef.current.delete(key);

    const container = containerRef.current;
    const liveCount = entries.filter((entry) => !entry.exiting).length;
    const exitingKeys = entries.filter((entry) => entry.exiting).map((entry) => entry.key);
    const exitingNow = new Set(exitingKeys);

    // The whole table folds when its last rows leave; any other state
    // releases it (it is hidden once empty, or back in use).
    if (tableAnimsRef.current && !(liveCount === 0 && exitingKeys.length > 0)) {
      for (const animation of tableAnimsRef.current) animation.cancel();
      tableAnimsRef.current = null;
      container?.classList.remove("is-folding");
    }

    if (sig === previous.sig || !previous.mounted) return;
    const nodes = nodesIn(container);
    const wasExiting = new Set(previous.entries.filter((entry) => entry.exiting).map((entry) => entry.key));
    const wasRendered = new Set(previous.entries.map((entry) => entry.key));

    // A row that came back mid-fold (undo, a sync reverting a delete) is the
    // same node: unfold it where it stands.
    for (const [key, node] of nodes) {
      if (!wasExiting.has(key) || exitingNow.has(key)) continue;
      for (const animation of exits.get(node) ?? []) animation.cancel();
      exits.delete(node);
      node.inert = false;
    }

    const newExits = exitingKeys.filter((key) => !wasExiting.has(key));
    for (const key of newExits) {
      const node = nodes.get(key);
      if (node) node.inert = true;
    }

    const finish = (keys: string[]) => {
      for (const key of keys) doneRef.current.add(key);
      rerender();
    };

    if (reducedMotion() || !container) {
      if (exitingKeys.length > 0) finish(exitingKeys);
      return;
    }

    // Leaving: the last rows take the table with them; otherwise each row
    // folds on its own, a beat after the one above it.
    if (liveCount === 0 && exitingKeys.length > 0) {
      if (!tableAnimsRef.current) {
        container.classList.add("is-folding");
        const anims = fold(container, 0);
        tableAnimsRef.current = anims;
        anims[0].finished.then(() => finish(exitingKeys), () => undefined);
      }
    } else {
      let order = 0;
      for (const key of newExits) {
        const node = nodes.get(key);
        if (!node || !onScreen(boxOf(node))) {
          finish([key]);
          continue;
        }
        const anims = fold(node, Math.min(order * STAGGER_MS, MAX_STAGGER_MS));
        order += 1;
        exits.set(node, anims);
        anims[0].finished.then(() => finish([key]), () => undefined);
      }
    }

    if (!first) return;

    // Moves start from where each row is now drawn, so a move interrupted by
    // another lands smoothly: drop the running offset only after measuring.
    for (const [key, node] of nodes) {
      if (!first.has(key)) continue;
      moves.get(node)?.cancel();
      settle(node);
    }

    // Keep the row being edited under the user's hand: if a re-sort would
    // carry it off screen, scroll with it and let the rest of the list move.
    const active = document.activeElement;
    const anchor = active && container.contains(active) ? active.closest<HTMLElement>("[data-motion-key]") : null;
    const anchorKey = anchor?.dataset.motionKey;
    const anchorFirst = anchorKey ? first.get(anchorKey) : undefined;
    if (anchor && anchorFirst && !anchor.inert) {
      const now = boxOf(anchor);
      const leavesView = now.top < 0 || now.top > window.innerHeight - Math.min(now.height, 120);
      if (Math.abs(now.top - anchorFirst.top) > 1 && leavesView) {
        scrollParent(anchor)?.scrollBy({ top: now.top - anchorFirst.top, behavior: "instant" });
      }
    }

    const fromEmpty = previous.entries.length === 0;
    if (fromEmpty && liveCount > 0) {
      container.animate([{ opacity: 0, translate: "0 6px" }, { opacity: 1, translate: "0 0" }], {
        duration: ENTER_MS,
        easing: EASE_OUT
      });
      return;
    }

    const moving: Array<{ node: HTMLElement; dx: number; dy: number }> = [];
    for (const entry of entries) {
      const node = nodes.get(entry.key);
      if (!node) continue;
      const from = first.get(entry.key);
      const now = boxOf(node);
      const entering = !entry.exiting && !wasRendered.has(entry.key) && !previous.present.has(entry.key);
      if (entering) {
        if (onScreen(now)) {
          node.animate([{ opacity: 0, scale: "0.98" }, { opacity: 1, scale: "1" }], {
            duration: ENTER_MS,
            easing: EASE_OUT
          });
        }
        continue;
      }
      if (!from || newExits.includes(entry.key)) continue;
      const dx = from.left - now.left;
      const dy = from.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      if (!onScreen(from) && !onScreen(now)) continue;
      moving.push({ node, dx, dy });
    }
    // Rows are tinted glass over the ground; while they cross, each is made
    // solid (is-moving) and the one travelling furthest passes over the rest.
    moving.sort((a, b) => Math.abs(b.dy) - Math.abs(a.dy));
    moving.forEach(({ node, dx, dy }, index) => {
      node.classList.add("is-moving");
      if (index === 0) node.style.zIndex = "3";
      const move = node.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], {
        duration: MOVE_MS,
        easing: EASE_OUT
      });
      moves.set(node, move);
      move.finished.then(() => {
        if (moves.get(node) === move) settle(node);
      }, () => undefined);
    });
  });

  return entries;
}
