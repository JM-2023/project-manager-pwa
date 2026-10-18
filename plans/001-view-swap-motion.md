# 001 — Rewrite the content-swap layer: a mount is no longer an entrance

- **Status**: DONE (implemented 2026-10-18, not yet committed; acceptance 13/13, iPhone feel check pending)
- **Commit**: df779a3
- **Severity**: HIGH
- **Category**: Purpose & frequency; Cohesion & tokens (two clocks on one switch); Interruptibility
- **Estimated scope**: 7 source files (`src/styles/app.css`, `src/lib/pageTransition.ts`, `src/lib/listMotion.ts`, `src/components/TaskTable.tsx`, `src/pages/TodayPage.tsx`, `src/pages/SearchPage.tsx`, `src/pages/ProjectsPage.tsx`), about 150 changed lines. The acceptance script `plans/001-verify.cjs` is already written.

## Problem

In this app, whether something "plays an entrance" is decided by whether React mounts it, not by what the user did. Many page blocks carry a mount-time CSS animation (`animation: fade-up var(--t-slow) var(--ease) both`, opacity 0→1 plus a 10px rise over 300ms). The pages also use `key=` remounts to swap content ("swapping the list without motion"). In practice every remount replays that entrance and runs alongside the JS motion on its own clock. `pageTransition.ts` already has a `settleEntrances()` whose only job is to cancel these entrances on tab switches, which is a patch for this same root cause.

Per-frame measurements in Playwright WebKit at 393×852 (`plans/001-verify.cjs` reports 9 of 13 checks failing on the current code):

| Scenario | Frequency | Measured now |
|---|---|---|
| Today day switch (‹ ›) | 5–30 times/day, in bursts | `.page-body` slides sideways 180ms (18px, opacity 0.22→1). The list inside it starts again from **opacity 0** and rises vertically 10px over **300ms**. Two directions, two clocks, and the list lands about 130ms later than everything else. |
| Today tab tapped from a later date | Several times/day | Going back in time still enters **from the right**, because the direction is the last arrow's `navDir`. Crossing midnight has the same problem. |
| Search typing / filters | Every keystroke | The whole result list goes **opacity 1 → 0.04 → 1** and rises 9px over 300ms. Typing "abc" blinks it three times. Rows that no longer match vanish instantly. |
| A row coming back mid-fold (backspace, undo, sync reverting) | Frequent once search goes through listMotion | It jumps back to full height in the first frame (107.8px of 107.8px). |
| All rows leave, then come back | Search with no match, then backspace | The whole table jumps back (4791px of 4791px). |
| Projects page project switch | Several times/day | The whole list fades in from 0.23 and rises 8px over 300ms. This is a different language from the tab switch ("rows land one by one"). |
| Cold launch | 1/day | `.page-content`'s `page-in` (5px, 180ms) and its children's own `fade-up` (10px, 300ms) stack: two rises. |

Current code:

```css
/* src/styles/app.css:1595-1603 — current */
.progress-summary {
  margin-bottom: 32px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-xl);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  animation: fade-up var(--t-slow) var(--ease) both;
}
```

```css
/* src/styles/app.css:1762-1767 — current */
.task-table-wrap {
  width: 100%;
  container-type: inline-size;
  container-name: tasktable;
  animation: fade-up var(--t-slow) var(--ease) both;
}
```

```css
/* src/styles/app.css:2633 — current */
.search-results { animation: fade-up var(--t-slow) var(--ease) both; }
```

```tsx
// src/pages/TodayPage.tsx:22-26 — current
  const viewDate = selectedDate ?? today;
  const [navDir, setNavDir] = useState<NavDirection>(1);
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodySettledRef = useRef(false);
```

```tsx
// src/pages/TodayPage.tsx:62-81 — current
  function goTo(date: string, dir: NavDirection) {
    setNavDir(dir);
    onDateChange(date);
  }

  // The day's content travels with the navigation: everything under the
  // header slides in from the direction you went. No remount — the summary
  // canvas and table state stay live; opacity/transform only.
  useLayoutEffect(() => {
    if (!bodySettledRef.current) {
      bodySettledRef.current = true;
      return;
    }
    const el = bodyRef.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(
      [{ opacity: 0.22, transform: `translateX(${navDir * 18}px)` }, { opacity: 1, transform: "none" }],
      { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }
    );
  }, [viewDate, navDir]);
```

```tsx
// src/pages/TodayPage.tsx:94-97 — current
          dir={navDir}
          onPrev={() => goTo(addDays(viewDate, -1), -1)}
          onNext={() => goTo(addDays(viewDate, 1), 1)}
          onHome={() => goTo(today, viewDate > today ? -1 : 1)}
```

```tsx
// src/pages/TodayPage.tsx:123-126 — current (the comment is wrong: the remount does have motion)
      {/* Mounted even when the day empties, so its last rows can fold out;
          keyed by day, so switching days swaps the list without motion. */}
      <TaskTable
        key={viewDate}
```

```tsx
// src/pages/SearchPage.tsx:109-110 — current
      <div key={scope} className="search-results">
      {scope === "tasks" ? <TaskTable key={[query, filters.projectId, filters.status, filters.priority].join("|")} tasks={filtered} projects={projects} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} /> :
```

```tsx
// src/pages/ProjectsPage.tsx:28-31, 39, 57 — current
  const selectedProjectId = filters.projectId;
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [selectedProjectId]);
  …
    <main className="page-content project-page">
  …
      <TaskTable key={selectedProjectId} tasks={projectTasks} projects={projects} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} />
```

```ts
// src/lib/listMotion.ts:294-301 — current: a row that comes back mid-fold snaps to full height when its fold is cancelled, even though the comment says otherwise
    // A row that came back mid-fold (undo, a sync reverting a delete) is the
    // same node: unfold it where it stands.
    for (const [key, node] of nodes) {
      if (!wasExiting.has(key) || exitingNow.has(key)) continue;
      for (const animation of exits.get(node) ?? []) animation.cancel();
      exits.delete(node);
      node.inert = false;
    }
```

```ts
// src/lib/listMotion.ts:281-287 — current: when the whole table is mid-fold and rows come back, cancelling the fold also snaps it
    if (tableAnimsRef.current && !(liveCount === 0 && exitingKeys.length > 0)) {
      for (const animation of tableAnimsRef.current) animation.cancel();
      tableAnimsRef.current = null;
      container?.classList.remove("is-folding");
    }
```

## Target

One rule: **something appears because the user meant it to, and every switch has exactly one motion on one clock.** Blocks inside a swapped region carry no mount animation of their own. The code that performs the swap moves them.

| Scenario | Target motion (exact values) |
|---|---|
| Day switch, from any entry point (‹ ›, title back to today, Today tab, midnight) | The whole `.page-body` moves as one sheet: `translateX(±18px → 0)` and `opacity 0.22 → 1`, **180ms**, `cubic-bezier(0.23, 1, 0.32, 1)`. These values stay as they are. The list and the empty-day note get no motion of their own. **Direction comes from the dates**: a later date gives +1 (enters from the right), an earlier date gives −1 (enters from the left). |
| Search typing / filters | Stop remounting the table; `listMotion` filters in place at the **quick pace**. A row that no longer matches folds in **240ms** (content fade 140ms, no stagger). A new match appears in **220ms**. Surviving rows glide **240ms** into place. Rows that still match never fade. |
| A row coming back mid-fold | It grows back from its current height and opacity: 220ms at the quick pace, 360ms at the normal pace, `cubic-bezier(0.23, 1, 0.32, 1)`. |
| Whole table coming back mid-fold | Same as above: the table opens again from its current height. |
| Project switch; search scope (tasks ⇄ ideas) switch | The same language as a tab switch (`pageTransition`'s settle): on-screen blocks get opacity 0→own over **170ms** `cubic-bezier(0.2, 0.7, 0.3, 1)` and translate `0 10px → own` over **320ms** `cubic-bezier(0.2, 0.9, 0.25, 1)`, with a **24ms** stagger between rows (capped at 6 rows) and a 16ms head start. These are all the existing constants. |
| Cold launch | Only `.page-content`'s `page-in` (5px, 180ms) plays; the blocks inside it no longer rise a second time. |
| `prefers-reduced-motion: reduce` | Every swap above is instant (no slide, settle, or fold), as the JS engines already do today. |

**Why search uses a quick pace instead of the default.** Typing runs at roughly 150–250ms per key. The default exit is 380ms plus up to 240ms of stagger, so at the old pace the list would trail the input by more than half a second. The quick pace keeps every leg within 240ms, which fits the AUDIT budget for dropdowns and lists (150–250ms). Note: the comparison animation shown earlier in chat used the default pace. This plan deliberately makes it faster.

## Repo conventions to follow

- **Adjusting state during render** (not in an effect), so values decided in the same commit apply in the same frame. Copy `src/lib/disclosure.ts:495-499`:
  ```ts
  const [wasExpanded, setWasExpanded] = useState(expanded);
  if (wasExpanded !== expanded) {
    setWasExpanded(expanded);
    if (!expanded) setHeld(true);
  }
  ```
- Comments are full English sentences that say **why**, in the voice of the existing comments in `listMotion.ts` and `pageTransition.ts`. Don't add comments that restate what the code does.
- WAAPI uses `el.animate(...)`. Never add a CSS `transition` to something a JS clock drives (that is a second clock).
- Every JS motion engine checks `window.matchMedia("(prefers-reduced-motion: reduce)")` itself. `listMotion` uses its `reducedMotion()` helper (`listMotion.ts:67-69`).
- Curves stay literal in TS. `listMotion.ts:54-55` already defines `EASE` / `EASE_OUT`. Don't add CSS tokens or new curves.

## Steps

### Step 1 — CSS: remove three mount entrances (`src/styles/app.css`)

1. `.progress-summary` (1595-1603): delete only the line `  animation: fade-up var(--t-slow) var(--ease) both;`. Leave the other declarations unchanged.
2. `.task-table-wrap` (1762-1767): delete the `animation` line and add this comment above the rule:
   ```css
   /* No entrance of its own: the page's arrival (page-in, a tab switch's
      settle) or the swap that brought it (the day slide, a project or scope
      settle) moves it. A mount animation here replays on every keyed remount. */
   .task-table-wrap {
     width: 100%;
     container-type: inline-size;
     container-name: tasktable;
   }
   ```
3. Line 2633 `.search-results { animation: fade-up var(--t-slow) var(--ease) both; }`: delete the whole line (the rule has nothing else).

Don't touch any other `animation:` rule (see Boundaries).

### Step 2 — `src/lib/pageTransition.ts`: share the settle with in-page swaps

Split `settleIn` (109-129) into a shared `landUnits` plus the original `settleIn`, and export a new `settleRegion`. Replace 109-129 with:

```ts
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
```

Leave `collectUnits`, `land`, `settleEntrances`, `switchPageAnimated` and all constants unchanged.

### Step 3 — `src/lib/listMotion.ts`: a quick pace, and reopening from where it stands

3a. Replace the options and constants (40-55) with:

```ts
export interface ListMotionOptions {
  /** How an arriving row appears. "fade": it fades up in place and its
   * neighbours glide aside (FLIP). "unfold": its box grows open from
   * nothing, the mirror of the exit fold, so whatever sits below the list
   * glides down with it instead of jumping. */
  enter?: "fade" | "unfold";
  /** "quick" for a list that changes as fast as the user types (search
   * results): every leg lands within 240ms and exits fold together, so the
   * list keeps up with the keystrokes instead of trailing them. */
  pace?: "normal" | "quick";
}

interface Pace {
  move: number;
  enter: number;
  exit: number;
  fade: number;
  stagger: number;
  maxStagger: number;
}

const PACES: Record<"normal" | "quick", Pace> = {
  normal: { move: 380, enter: 360, exit: 380, fade: 220, stagger: 36, maxStagger: 240 },
  quick: { move: 240, enter: 220, exit: 240, fade: 140, stagger: 0, maxStagger: 0 }
};
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
```

(The old `MOVE_MS`, `ENTER_MS`, `EXIT_MS`, `FADE_MS`, `STAGGER_MS` and `MAX_STAGGER_MS` are deleted. Every use goes through `pace.*` as shown below.)

3b. Add one type and one function after `openBox` (after 116-128):

```ts
/** Where a block is drawn right now, mid-fold included. */
interface Opening {
  box: typeof SHUT;
  opacity: string;
  scale: string;
}

/** Read where a folding block has got to, before its fold is let go, so it
 * can open again from there instead of snapping back to full size. */
function openingFrom(node: HTMLElement): Opening {
  const style = getComputedStyle(node);
  return { box: openBox(node), opacity: style.opacity, scale: style.scale === "none" ? "1" : style.scale };
}
```

3c. `fold` (135-157): change the signature to `function fold(node: HTMLElement, delay: number, pace: Pace): Animation[]`. Inside, change `EXIT_MS` to `pace.exit` and `FADE_MS` to `pace.fade`. Nothing else changes.

3d. Replace `unfold` (159-184) with the version below (adds `pace` and an optional `from`, and clears `min-height` while it grows; wide-table rows have `min-height: 54px`, which would otherwise hold a growing row at 54px):

```ts
/** Grow a block open: from nothing (the exit fold played backwards, with
 * the content fading in once there is room for it), or from where a fold
 * that was let go had got to. It clips while it grows so nothing spills
 * over the rows below, and lets go when the box lands. Call it before
 * measuring the rows after this one: from its first frame the layout below
 * already starts from the box it grows from. */
function unfold(node: HTMLElement, pace: Pace, from?: Opening): void {
  enters.get(node)?.cancel();
  const open = openBox(node);
  node.style.overflow = "hidden";
  node.style.minHeight = "0px";
  const box = node.animate([from?.box ?? SHUT, open], { duration: pace.enter, easing: EASE_OUT });
  node.animate(
    from
      ? [
          { opacity: from.opacity, scale: from.scale, easing: EASE_OUT },
          { opacity: 1, scale: "1" }
        ]
      : [
          { opacity: 0, scale: "0.98", offset: 0 },
          { opacity: 0, scale: "0.98", offset: 0.2, easing: EASE },
          { opacity: 1, scale: "1", offset: 1 }
        ],
    { duration: pace.enter }
  );
  enters.set(node, box);
  const release = () => {
    if (enters.get(node) !== box) return;
    enters.delete(node);
    node.style.overflow = "";
    node.style.minHeight = "";
  };
  box.finished.then(release, release);
}
```

3e. In `useListMotion` (232 onward), right after `const unfolds = options.enter === "unfold";`, add:

```ts
  const pace = PACES[options.pace ?? "normal"];
```

3f. Replace the whole-table release (281-287) with:

```ts
    // The whole table folds when its last rows leave; any other state
    // releases it (it is hidden once empty, or back in use). Rows coming
    // back before the fold lands open it again from where it has got to.
    if (tableAnimsRef.current && !(liveCount === 0 && exitingKeys.length > 0)) {
      const from = container && liveCount > 0 && !reducedMotion() ? openingFrom(container) : null;
      for (const animation of tableAnimsRef.current) animation.cancel();
      tableAnimsRef.current = null;
      container?.classList.remove("is-folding");
      if (container && from) unfold(container, pace, from);
    }
```

(The original comment block at 281-282 is replaced by the one above. Don't keep both.)

3g. Replace the mid-fold return (294-301) with:

```ts
    // A row that came back mid-fold (undo, a sync reverting a delete, a
    // search query taken back) is the same node: it opens again from where
    // its fold has got to.
    for (const [key, node] of nodes) {
      if (!wasExiting.has(key) || exitingNow.has(key)) continue;
      node.inert = false;
      const anims = exits.get(node);
      if (!anims) continue;
      exits.delete(node);
      const from = reducedMotion() ? null : openingFrom(node);
      for (const animation of anims) animation.cancel();
      if (from) unfold(node, pace, from);
    }
```

3h. Remaining call sites, changed exactly as follows:
- 324: `const anims = fold(container, 0);` becomes `const anims = fold(container, 0, pace);`
- 336: `const anims = fold(node, Math.min(order * STAGGER_MS, MAX_STAGGER_MS));` becomes `const anims = fold(node, Math.min(order * pace.stagger, pace.maxStagger), pace);`
- 368: `if (unfolds) unfold(container);` becomes `if (unfolds) unfold(container, pace);`
- 371-372: in the `container.animate(...)` options, `duration: ENTER_MS` becomes `duration: pace.enter`
- 389: `if (unfolds) unfold(node);` becomes `if (unfolds) unfold(node, pace);`
- 391-392: in the `node.animate(...)` options, `duration: ENTER_MS` becomes `duration: pace.enter`
- 411-412: in the move's `node.animate(...)` options, `duration: MOVE_MS` becomes `duration: pace.move`

After this, the file must not contain any of `MOVE_MS`, `ENTER_MS`, `EXIT_MS`, `FADE_MS`, `STAGGER_MS` or `MAX_STAGGER_MS` (check with `grep -n _MS src/lib/listMotion.ts`; nothing should print).

### Step 4 — `src/components/TaskTable.tsx`: pass the pace through

1. Add one field at the end of `interface TaskTableProps` (42-52):
   ```ts
     /** How fast its rows move (lib/listMotion): "quick" for a list that
      * changes as fast as the user types. */
     motionPace?: "normal" | "quick";
   ```
2. Add `motionPace = "normal"` to the `TaskTable` destructuring (1197-1205), after `onDelete`.
3. Line 1243 `const rows = useListMotion(visible, taskKey, tableRef, present);` becomes:
   ```ts
   const rows = useListMotion(visible, taskKey, tableRef, present, { pace: motionPace });
   ```

Change nothing else, especially not the `signature`/`count` paging logic.

### Step 5 — `src/pages/TodayPage.tsx`: direction from the dates, one sheet

1. Replace 22-26 with:
   ```tsx
     const viewDate = selectedDate ?? today;
     // Which way the view moved, read from the dates themselves (ISO dates
     // sort as text), so every way to another day (the arrows, the title, the
     // Today tab, midnight) slides and rolls from the side it came from.
     // Decided during render, so the title's roll and the body's slide both
     // see it in the commit that changes the day.
     const [shownDate, setShownDate] = useState(viewDate);
     const [navDir, setNavDir] = useState<NavDirection>(1);
     if (shownDate !== viewDate) {
       setShownDate(viewDate);
       setNavDir(viewDate > shownDate ? 1 : -1);
     }
     const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
     const bodyRef = useRef<HTMLDivElement | null>(null);
     const bodySettledRef = useRef(false);
     const bodySlideRef = useRef<Animation | null>(null);
   ```
2. Delete `goTo` (62-65) and replace the effect (67-81) with:
   ```tsx
     // The new day arrives as one sheet: everything under the header slides
     // in from the direction you went, on one clock. The day's list is
     // remounted (keyed by day) but has no entrance of its own; an empty-day
     // note that mounts with it would fade on a clock of its own, so it is
     // finished here and rides the slide too. A press mid-slide starts the
     // next day's slide over.
     useLayoutEffect(() => {
       if (!bodySettledRef.current) {
         bodySettledRef.current = true;
         return;
       }
       const el = bodyRef.current;
       if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
       for (const note of el.querySelectorAll(".empty-state")) {
         for (const animation of note.getAnimations()) animation.finish();
       }
       bodySlideRef.current?.cancel();
       bodySlideRef.current = el.animate(
         [{ opacity: 0.22, transform: `translateX(${navDir * 18}px)` }, { opacity: 1, transform: "none" }],
         { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }
       );
     }, [viewDate, navDir]);
   ```
3. Replace the `DateSwitcher` handlers (95-97) with:
   ```tsx
             onPrev={() => onDateChange(addDays(viewDate, -1))}
             onNext={() => onDateChange(addDays(viewDate, 1))}
             onHome={() => onDateChange(today)}
   ```
   `dir={navDir}` (94) stays.
4. Fix the comment at 123-124 to:
   ```tsx
         {/* Mounted even when the day empties, so its last rows can fold out.
             Keyed by day: each day is its own list, so a day switch swaps it
             whole and it rides the body's slide (it has no entrance of its own). */}
   ```

### Step 6 — `src/pages/SearchPage.tsx`: typing filters in place

1. Change the import on line 4 to `import { useLayoutEffect, useMemo, useRef, useState } from "react";`, and add after line 1 (the `TaskTable` import):
   ```ts
   import { settleRegion } from "../lib/pageTransition";
   ```
2. Right after line 12 `const [scope, setScope] = …`, add:
   ```tsx
     const resultsRef = useRef<HTMLDivElement | null>(null);
     const shownScopeRef = useRef(scope);
     // The other scope's results settle in the way a page does on a tab
     // switch. The page's own arrival is the tab switch's, so the first run
     // lands nothing.
     useLayoutEffect(() => {
       if (shownScopeRef.current === scope) return;
       shownScopeRef.current = scope;
       settleRegion(resultsRef.current);
     }, [scope]);
   ```
3. Replace 109-110 with (only the `TaskTable` part of the ternary changes; the `:` branch after it stays as it is):
   ```tsx
         {/* One table for every query: typing filters it in place (lib/listMotion
             at the quick pace), so rows that still match never re-enter. */}
         <div key={scope} ref={resultsRef} className="search-results">
         {scope === "tasks" ? <TaskTable motionPace="quick" tasks={filtered} projects={projects} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} /> :
   ```

### Step 7 — `src/pages/ProjectsPage.tsx`: settle on project switch

1. Change the import on line 3 to `import { useLayoutEffect, useMemo, useRef } from "react";`, and add one line after the existing `../lib/progress` import:
   ```ts
   import { settleRegion } from "../lib/pageTransition";
   ```
2. Replace 28-31 with:
   ```tsx
     const selectedProjectId = filters.projectId;
     const pageRef = useRef<HTMLElement | null>(null);
     const shownProjectRef = useRef(selectedProjectId);
     useLayoutEffect(() => {
       window.scrollTo({ top: 0, behavior: "instant" });
       // Another project's tasks settle in the way a page does on a tab
       // switch (lib/pageTransition), measured after the scroll reset. The
       // page's own arrival is the tab switch's, so the first run lands nothing.
       if (shownProjectRef.current === selectedProjectId) return;
       shownProjectRef.current = selectedProjectId;
       settleRegion(pageRef.current?.querySelector(".task-table-wrap") ?? null);
     }, [selectedProjectId]);
   ```
3. Line 39 `<main className="page-content project-page">` becomes `<main ref={pageRef} className="page-content project-page">`. `key={selectedProjectId}` on line 57 stays.

## Boundaries

- **Don't touch** `src/lib/disclosure.ts`, `src/pages/NextPage.tsx`, `src/components/ProjectList.tsx` or `src/pages/CalendarPage.tsx`. Another session (`one-spring-disclosure`, in its own worktree) is moving all expand/collapse onto one spring. Both changes edit `app.css`; this plan edits only the three rules in Step 1.
- **Don't change** tab-switch behaviour: keep `settleEntrances()`, `switchPageAnimated()` and every constant in `pageTransition.ts`. `settleEntrances()` stays as a safety net for the other mount entrances.
- **Don't change** any value of the Today slide (18px, 0.22, 180ms, curve), the settle values, or listMotion's normal-pace values. They have already been tuned with the user.
- **Don't remove** other mount entrances. These are known gaps for a later plan: `.settings-*` and `.project-row` staggered entrances (still stacked at cold launch); `.cache-item`'s `scale-in` (ideas in the Search ideas scope just disappear when filtered); `.empty-state`'s `fade-in` (still used for in-place appearance); the `.cal-*` swap keyframes on the calendar; and `.mapping-panel`.
- **Don't change** TaskTable's paging (`signature`/`count`), markup structure, or anything outside the files listed.
- No new dependencies. Don't deploy. Don't commit or push without asking the user first.
- If any "current code" excerpt doesn't match what you find (the code has drifted since `df779a3`), **STOP and report** rather than improvising.

## Verification

- **Mechanical**:
  - `npm test`: all pass (existing `listMotion.test.ts` covers `mergeExits`; this plan doesn't change its behaviour).
  - `npm run build` (`tsc --noEmit && vite build`): passes with no type errors and refreshes `dist/`.
  - `grep -n _MS src/lib/listMotion.ts` prints nothing.
- **Acceptance script** (per-frame, Playwright WebKit):
  1. After the build, start the `pages-dev` dev server (`.claude/launch.json`, port 8788; use preview_start with name `pages-dev`, or run that configuration's wrangler command directly).
  2. `PM_PASSCODE=<local dev passcode> NO_PROXY='*' node plans/001-verify.cjs`
  3. On the current code it reports **4/13 passed**. Expected afterwards: **13/13 passed**, exit code 0. (If the first row on Projects starts below the screen, that check prints a SKIP line and the total is 12/12.) Each FAIL line carries the frame and value at fault; fix from that, don't loosen the thresholds.
- **Feel check** (WebKit locally; once deployed, on the user's iPhone Safari):
  - Press › several times quickly on Today: the summary card, the two buttons and the list move as **one piece** in the same direction, and the list never "arrives late" or rises from below.
  - Go forward 2 days, then tap Today in the Dock: it comes in **from the left**.
  - Type a few letters quickly in Search: matching rows **never blink**; rows that drop out fold away and rows below slide up, keeping pace with your typing.
  - Type a letter and backspace at once: a folding row **grows back from where it was**, never snapping to full height.
  - Switch projects on Projects: rows land top-down one after another, the same feel as switching tabs.
  - Reload the page (cold launch): the list and summary rise once only, no double rise.
  - Turn on "Reduce motion" (Mac System Settings → Accessibility → Display, or Settings → Accessibility → Motion on iPhone): all of the above switch instantly; the script's reduced-motion check covers the day switch.
- **Done when**: tests and build pass, `001-verify.cjs` reports 13/13, and the user has checked the feel on iPhone.
