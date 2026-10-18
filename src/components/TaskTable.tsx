import { ArrowRight, Check, ChevronDown, ChevronUp, Copy, MoreHorizontal } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes
} from "react";
import { createPortal } from "react-dom";
import type { Project, Task } from "../lib/types";
import { addDays, todayDate, toDateInput } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import {
  getTaskImportance,
  getTaskProgress,
  importancePriority,
  parseTaskExtra,
  progressStatus,
  progressTone,
  stringifyTaskExtra,
  worklogBlocker,
  worklogOutput,
  type TaskImportance,
  type TaskProgress
} from "../lib/progress";
import { useSpringDisclosure } from "../lib/disclosure";
import { useListMotion } from "../lib/listMotion";
import { usePresence } from "../lib/usePresence";
import { handleMenuKeyDown } from "../lib/menuKeys";
import { useMeterDither } from "../lib/meterDither";
import { RollDigits } from "./RollDigits";
import { SegControl, type SegOption } from "./SegControl";

interface TaskTableProps {
  tasks: Task[];
  projects: Project[];
  showDate?: boolean;
  // When set, the matching row's title field focuses on mount (used by the
  // Today page so a freshly added task is immediately typeable).
  focusTaskId?: string | null;
  onCreate: (input: Partial<Task> & { title: string }) => void;
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onDelete: (task: Task) => void;
  /** How fast its rows move (lib/listMotion): "quick" for a list that
   * changes as fast as the user types. */
  motionPace?: "normal" | "quick";
}

interface TaskRowProps {
  task: Task;
  // Live projects, for the card's project picker.
  projects: Project[];
  projectOptions: ReactNode;
  projectName: string;
  showDate: boolean;
  // The table is in its wide spreadsheet layout: the row is a line of
  // editable cells instead of a card.
  wide: boolean;
  autoFocusTitle?: boolean;
  // The task is gone from the data and the row is folding out
  // (lib/listMotion): inert, and it must not write anything back.
  exiting: boolean;
  onCreate: (input: Partial<Task> & { title: string }) => void;
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onDelete: (task: Task) => void;
}

const importanceValues: TaskImportance[] = [1, 2, 3, 4];

type ImportanceId = "1" | "2" | "3" | "4";
const importanceOptions: Array<SegOption<ImportanceId>> = importanceValues.map((value) => ({
  id: String(value) as ImportanceId,
  label: String(value)
}));

function fitTextarea(element: HTMLTextAreaElement): void {
  element.style.height = "0px";
  // style.height is border-box while scrollHeight measures the content box.
  element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
}

const textareaWidths = new WeakMap<HTMLTextAreaElement, number>();
let textareaObserver: ResizeObserver | null = null;
let observedTextareaCount = 0;

function observeTextarea(element: HTMLTextAreaElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  if (!textareaObserver) {
    textareaObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const textarea = entry.target as HTMLTextAreaElement;
        const width = textarea.clientWidth;
        if (textareaWidths.get(textarea) !== width) {
          textareaWidths.set(textarea, width);
          fitTextarea(textarea);
        }
      }
    });
  }
  textareaWidths.set(element, element.clientWidth);
  textareaObserver.observe(element);
  observedTextareaCount += 1;

  return () => {
    textareaObserver?.unobserve(element);
    textareaWidths.delete(element);
    observedTextareaCount -= 1;
    if (observedTextareaCount === 0) {
      textareaObserver?.disconnect();
      textareaObserver = null;
    }
  };
}

const draftFlushers = new Set<() => void>();

function flushAllDrafts(): void {
  for (const flush of draftFlushers) flush();
}

function flushDraftsWhenHidden(): void {
  if (document.visibilityState === "hidden") flushAllDrafts();
}

function registerDraftFlusher(flush: () => void): () => void {
  const first = draftFlushers.size === 0;
  draftFlushers.add(flush);
  if (first) {
    document.addEventListener("visibilitychange", flushDraftsWhenHidden);
    window.addEventListener("pagehide", flushAllDrafts);
    window.addEventListener("beforeunload", flushAllDrafts);
  }

  return () => {
    draftFlushers.delete(flush);
    if (draftFlushers.size === 0) {
      document.removeEventListener("visibilitychange", flushDraftsWhenHidden);
      window.removeEventListener("pagehide", flushAllDrafts);
      window.removeEventListener("beforeunload", flushAllDrafts);
    }
  };
}

function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const value = typeof props.value === "string" ? props.value : String(props.value ?? "");

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    fitTextarea(element);
  }, [value]);

  // Re-measure when the column narrows/widens (window resize, card <-> table
  // layout switch). One observer serves every mounted textarea.
  useEffect(() => {
    const element = ref.current;
    return element ? observeTextarea(element) : undefined;
  }, []);

  return <textarea {...props} ref={ref} />;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ---------- floating popovers (task actions, project picker) ----------- */

type Placement = (anchor: DOMRect, popover: HTMLElement) => { left: number; top: number; up?: boolean };

const VIEW_EDGE = 8;
const clampLeft = (left: number, width: number) => Math.max(VIEW_EDGE, Math.min(left, window.innerWidth - width - VIEW_EDGE));
const clampTop = (top: number, height: number) => Math.max(VIEW_EDGE, Math.min(top, window.innerHeight - height - VIEW_EDGE));

/** Over the trigger, grown out of its bottom-right corner. */
const coverTrigger: Placement = (anchor, popover) => ({
  left: clampLeft(anchor.right - popover.offsetWidth, popover.offsetWidth),
  top: clampTop(anchor.bottom - popover.offsetHeight, popover.offsetHeight)
});

/** Dropped below the trigger, left edges aligned; above it when the view
 * has no room underneath. */
const dropFromTrigger: Placement = (anchor, popover) => {
  const height = popover.offsetHeight;
  const below = anchor.bottom + 6;
  const up = below + height > window.innerHeight - VIEW_EDGE && anchor.top - 6 - height >= VIEW_EDGE;
  return {
    left: clampLeft(anchor.left, popover.offsetWidth),
    top: clampTop(up ? anchor.top - 6 - height : below, height),
    up
  };
};

interface FloatingPopoverOptions {
  open: boolean;
  close: () => void;
  triggerRef: RefObject<HTMLButtonElement>;
  popoverRef: RefObject<HTMLDivElement>;
  place: Placement;
  // Content swaps (a confirm step) that should re-place and re-focus.
  layoutKey?: unknown;
}

/**
 * A popover portaled to <body> so no clipped card or table can cut it off:
 * mounted through its exit animation, closed by an outside press or Escape,
 * and kept placed against its trigger as the page scrolls or resizes. It
 * closes if the trigger scrolls out of view. On open, focus lands on the
 * checked item, or the first.
 */
function useFloatingPopover({ open, close, triggerRef, popoverRef, place, layoutKey }: FloatingPopoverOptions) {
  const presence = usePresence(open, 300);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    // pointerdown, not mousedown: a press that cancels its compatibility
    // mouse events (the table's meter does) must still close the popover.
    function closeOnOutsidePress(event: PointerEvent) {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) closeRef.current();
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      closeRef.current();
      triggerRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, triggerRef, popoverRef]);

  useLayoutEffect(() => {
    if (!presence.mounted || presence.closing) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    function position() {
      if (!trigger || !popover) return;
      const rect = trigger.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
        closeRef.current();
        return;
      }
      const { left, top, up } = place(rect, popover);
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
      // An attribute, not a class: React rewrites className on the closing render.
      popover.dataset.side = up ? "up" : "down";
      popover.style.visibility = "visible";
    }
    position();
    (popover.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? popover.querySelector<HTMLButtonElement>("button"))?.focus({
      preventScroll: true
    });
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    observer.observe(trigger);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
    // `place` is a module-level constant per caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence.mounted, presence.closing, layoutKey, triggerRef, popoverRef]);

  return presence;
}

interface TaskMenuProps {
  // A folding row closes its menu; the actions would act on a stale task.
  exiting: boolean;
  // Leave out the next-day pair (the card's footer has them as buttons).
  nextDay?: boolean;
  onCopy: (offset: number) => void;
  onMove: (offset: number) => void;
  onDelete: () => void;
}

function TaskMenu({ exiting, nextDay = true, onCopy, onMove, onDelete }: TaskMenuProps) {
  const { m } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setMenuOpen(false), []);
  const menu = useFloatingPopover({ open: menuOpen, close, triggerRef, popoverRef, place: coverTrigger, layoutKey: confirmingDelete });

  useEffect(() => {
    if (exiting) setMenuOpen(false);
  }, [exiting]);

  // Reset the delete-confirm step whenever the menu closes so it reopens on
  // the root view (same two-step pattern as ProjectList).
  useEffect(() => {
    if (!menuOpen) {
      setConfirmingDelete(false);
    }
  }, [menuOpen]);

  function act(action: () => void) {
    setMenuOpen(false);
    action();
  }

  return (
    <div className={`task-menu${menuOpen ? " is-open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button task-menu-trigger"
        onClick={() => setMenuOpen((open) => !open)}
        aria-label={m.taskTable.taskActions}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>
      {menu.mounted ? createPortal(
        <div
          ref={popoverRef}
          className={`task-action-menu task-action-menu--floating${menu.closing ? " is-closing" : ""}`}
          role="menu"
          aria-label={m.taskTable.taskActions}
          onKeyDown={handleMenuKeyDown}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) menu.onExited();
          }}
        >
          {confirmingDelete ? (
            <>
              <span className="task-action-menu__prompt" role="presentation">
                {m.taskTable.deletePrompt}
              </span>
              <button type="button" role="menuitem" className="danger" onClick={() => act(onDelete)}>
                <span>{m.taskTable.confirmDelete}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => setConfirmingDelete(false)}>
                <span>{m.common.cancel}</span>
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => act(() => onCopy(-1))}>
                <span>{m.taskTable.copyToPrevDay}</span>
              </button>
              {nextDay ? (
                <button type="button" role="menuitem" onClick={() => act(() => onCopy(1))}>
                  <span>{m.taskTable.copyToNextDay}</span>
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={() => act(() => onMove(-1))}>
                <span>{m.taskTable.moveToPrevDay}</span>
              </button>
              {nextDay ? (
                <button type="button" role="menuitem" onClick={() => act(() => onMove(1))}>
                  <span>{m.taskTable.moveToNextDay}</span>
                </button>
              ) : null}
              <button type="button" role="menuitem" className="danger" onClick={() => setConfirmingDelete(true)}>
                <span>{m.taskTable.deleteTask}</span>
              </button>
            </>
          )}
        </div>,
        document.body
      ) : null}
    </div>
  );
}

interface ProjectPickerProps {
  // The visible field label, so the trigger reads "Project, <name>".
  labelId: string;
  value: string | null;
  projects: Project[];
  disabled: boolean;
  onChange: (projectId: string | null) => void;
}

/** The card's project field: a button showing the project, opening the
 * app's own menu (the native select is a system wheel on iPhone). */
function ProjectPicker({ labelId, value, projects, disabled, onChange }: ProjectPickerProps) {
  const { m } = useI18n();
  const valueId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const menu = useFloatingPopover({ open, close, triggerRef, popoverRef, place: dropFromTrigger });

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const current = projects.find((project) => project.id === value) ?? null;
  const choices = [{ id: null, name: m.common.noProject }, ...projects.map((project) => ({ id: project.id, name: project.name }))];

  function choose(id: string | null) {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    if (id !== (current?.id ?? null)) onChange(id);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`task-project-trigger${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
      >
        <span id={valueId}>{current?.name ?? m.common.noProject}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {menu.mounted ? createPortal(
        <div
          ref={popoverRef}
          className={`task-action-menu task-action-menu--floating task-project-menu${menu.closing ? " is-closing" : ""}`}
          role="menu"
          aria-label={m.common.project}
          style={{ minWidth: triggerRef.current?.offsetWidth }}
          onKeyDown={handleMenuKeyDown}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) menu.onExited();
          }}
        >
          {choices.map((choice) => {
            const checked = choice.id === (current?.id ?? null);
            return (
              <button key={choice.id ?? ""} type="button" role="menuitemradio" aria-checked={checked} onClick={() => choose(choice.id)}>
                <span>{choice.name}</span>
                {checked ? <Check size={15} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>,
        document.body
      ) : null}
    </>
  );
}

/* ---------- progress meter -------------------------------------------- */

const DETENT = 25;
// The display chases its target on a frame-rate-independent damped ease
// (`1 - exp(-k·dt)`): fast off the mark, easing to rest without overshoot.
const SETTLE_K = 14; // onto a detent: release, keys, a synced value
const DRAG_K = 40; // under the finger: close behind it, so a grab never jumps
// Travel before a press counts as a drag. Below it a press is a tap; past
// it, a mostly-vertical move is the page scrolling and the meter lets go.
const DRAG_SLOP = 6;

const snapProgress = (value: number) => (Math.round(value / DETENT) * DETENT) as TaskProgress;

interface ProgressFieldProps {
  progress: TaskProgress;
  // Every detent the drag or a key passes through (drives the summary).
  onInput: (value: TaskProgress) => void;
  // The gesture ended on this detent.
  onCommit: (value: TaskProgress) => void;
  // "cell": the wide table's labelled cell with a live % badge, where a
  // press sets the value like any slider. "card": a bare meter on the
  // closed card, where only a sideways drag changes the value and a tap is
  // handed to onTap (it opens the card).
  variant?: "cell" | "card";
  onTap?: () => void;
  // The press has become a drag (it won't be a tap).
  onGrab?: () => void;
}

function ProgressField({ progress, onInput, onCommit, variant = "cell", onTap, onGrab }: ProgressFieldProps) {
  const { m } = useI18n();
  // The visible fill/badge chase the value on a damped ease each frame, so
  // the meter has weight instead of snapping between the 25% detents. The
  // gesture is the app's own (pointer events on a wider hit strip, with
  // touch-action letting vertical swipes scroll the page); the range input
  // underneath stays for keyboard and assistive tech only.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const meterRef = useRef<HTMLSpanElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const badgeRef = useRef<HTMLSpanElement | null>(null);
  const targetRef = useRef<TaskProgress>(progress);
  const displayRef = useRef<number>(progress);
  const chaseRef = useRef({ to: progress as number, k: SETTLE_K });
  const rafRef = useRef(0);
  const draggingRef = useRef(false);
  const gestureRef = useRef<{ id: number; x: number; y: number; live: boolean } | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  // While dragging, pixels break off the fill's end and fly right; on
  // release they stream back into place (lib/meterDither).
  const ditherRef = useRef<HTMLCanvasElement | null>(null);
  const dither = useMeterDither(ditherRef, {
    value: displayRef,
    target: targetRef,
    dragging: draggingRef
  });

  // Paint one frame of fill/badge.
  const paint = useCallback((value: number) => {
    displayRef.current = value;
    wrapRef.current?.style.setProperty("--pct", `${value}%`);
    if (sliderRef.current) sliderRef.current.value = String(value);
    if (badgeRef.current) badgeRef.current.textContent = `${Math.round(value)}%`;
    dither.current?.kick();
  }, [dither]);

  // One loop serves both rates; retargeting mid-flight just updates chaseRef.
  const glideTo = useCallback(
    (to: number, k = SETTLE_K) => {
      chaseRef.current = { to, k };
      if (reducedMotion()) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        paint(to);
        return;
      }
      if (rafRef.current) return;
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        const { to: target, k: rate } = chaseRef.current;
        const current = displayRef.current;
        const next = current + (target - current) * (1 - Math.exp(-rate * dt));
        if (Math.abs(target - next) < 0.35) {
          rafRef.current = 0;
          paint(target);
          return;
        }
        paint(next);
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [paint]
  );

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Keyboard steps, external updates and releases glide to the detent; a
  // live drag is chased toward the finger instead.
  useEffect(() => {
    targetRef.current = progress;
    if (!draggingRef.current) glideTo(progress);
  }, [progress, glideTo]);

  // Assistive tech adjusts the native input and ends with `change`.
  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    const handleChange = () => {
      if (!draggingRef.current) onCommitRef.current(targetRef.current);
    };
    slider.addEventListener("change", handleChange);
    return () => slider.removeEventListener("change", handleChange);
  }, []);

  function valueAt(clientX: number): number {
    const rect = meterRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return targetRef.current;
    return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  }

  // Head for a detent; the summary follows every one passed.
  function aim(value: TaskProgress) {
    if (value === targetRef.current) return;
    targetRef.current = value;
    onInput(value);
  }

  function track(clientX: number) {
    const raw = valueAt(clientX);
    aim(snapProgress(raw));
    glideTo(raw, DRAG_K);
  }

  function grab(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gesture.live = true;
    draggingRef.current = true;
    onGrab?.();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone; the drag ends on its own events.
    }
    track(event.clientX);
  }

  function release() {
    draggingRef.current = false;
    glideTo(targetRef.current);
    onCommit(targetRef.current);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    gestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, live: false };
    // A mouse on the table cell is an ordinary slider: the press sets the
    // value and starts the drag.
    if (variant === "cell" && event.pointerType === "mouse") {
      event.preventDefault();
      sliderRef.current?.focus({ preventScroll: true });
      grab(event);
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    if (gesture.live) {
      track(event.clientX);
      return;
    }
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (Math.abs(dy) > Math.abs(dx)) {
      gestureRef.current = null;
      return;
    }
    grab(event);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.live) {
      release();
      return;
    }
    if (variant === "card") {
      onTap?.();
      return;
    }
    aim(snapProgress(valueAt(event.clientX)));
    glideTo(targetRef.current);
    onCommit(targetRef.current);
  }

  // The browser took the touch for a scroll, or capture was lost mid-drag.
  function handlePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.live) release();
  }

  const meter = (
    <span
      className="progress-hit"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
    >
      <span ref={meterRef} className="progress-meter">
        <span className="progress-meter__fill" />
        <canvas ref={ditherRef} className="progress-meter__dither" aria-hidden="true" />
        {/* No step attribute: a stepped input quantizes programmatic writes,
          which would snap the fill out of the damped glide. Keys step
          manually. */}
        <input
          ref={sliderRef}
          type="range"
          className="progress-slider"
          min={0}
          max={100}
          defaultValue={progress}
          onChange={(event) => {
            if (draggingRef.current) return;
            aim(snapProgress(Number(event.target.value)));
          }}
          onKeyDown={(event) => {
            const delta =
              event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp"
                ? DETENT
                : event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown"
                  ? -DETENT
                  : event.key === "Home"
                    ? -100
                    : event.key === "End"
                      ? 100
                      : 0;
            if (delta === 0) return;
            event.preventDefault();
            aim(Math.max(0, Math.min(100, targetRef.current + delta)) as TaskProgress);
          }}
          onKeyUp={() => onCommit(targetRef.current)}
          aria-label={m.taskTable.progressHeader}
          aria-valuetext={`${progress}%`}
        />
      </span>
    </span>
  );

  if (variant === "card") {
    return (
      <div
        ref={wrapRef}
        className={`task-card-meter tone-${progressTone(progress)}`}
        style={{ "--pct": `${displayRef.current}%` } as CSSProperties}
      >
        {meter}
      </div>
    );
  }

  return (
    <div className="tt-cell tt-progress">
      <span className="tt-label">{m.taskTable.progressHeader}</span>
      <div
        ref={wrapRef}
        className={`task-table-progress tone-${progressTone(progress)}`}
        style={{ "--pct": `${displayRef.current}%` } as CSSProperties}
      >
        <span ref={badgeRef} className="progress-badge">
          {Math.round(displayRef.current)}%
        </span>
        {meter}
      </div>
    </div>
  );
}

/* ---------- rows ------------------------------------------------------ */

function TaskRowComponent({ task, projects, projectOptions, projectName, showDate, wide, autoFocusTitle, exiting, onCreate, onUpdate, onDelete }: TaskRowProps) {
  const { m } = useI18n();
  const [expanded, setExpanded] = useState(Boolean(autoFocusTitle || !task.title.trim()));
  const [title, setTitle] = useState(task.title);
  const [output, setOutput] = useState(worklogOutput(task));
  const [blocker, setBlocker] = useState(worklogBlocker(task));
  const [nextAction, setNextAction] = useState(task.next_action ?? "");
  const [notes, setNotes] = useState(task.notes ?? "");
  const [progress, setProgress] = useState<TaskProgress>(getTaskProgress(task));
  const [copied, setCopied] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLSpanElement | null>(null);
  // Open and close run on one spring: the editor's height, the preview
  // folding away, the chevron and fields (CSS, from --disclose) and the
  // page's scroll, so the row stays in view (lib/disclosure).
  const editor = useSpringDisclosure(expanded, { block: rowRef, panel: editorRef, fold: previewRef });
  const projectLabelId = useId();
  // The value most recently handed to onUpdate and not yet reflected in the
  // task prop. A release can arrive through several events at once (pointer
  // up and the input's own change); only the first may create a mutation.
  const progressCommitRef = useRef<TaskProgress | null>(null);
  const previousTaskRef = useRef(task);
  // A folding row holds a snapshot of a task that no longer exists (or has
  // moved away); a late draft commit would write it back.
  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;

  useEffect(() => {
    const previous = previousTaskRef.current;
    const nextOutput = worklogOutput(task);
    const nextBlocker = worklogBlocker(task);
    const nextProgress = getTaskProgress(task);

    if (task.id !== previous.id) {
      setTitle(task.title);
      setOutput(nextOutput);
      setBlocker(nextBlocker);
      setNextAction(task.next_action ?? "");
      setNotes(task.notes ?? "");
      setProgress(nextProgress);
      previousTaskRef.current = task;
      return;
    }

    const previousOutput = worklogOutput(previous);
    const previousBlocker = worklogBlocker(previous);
    const previousProgress = getTaskProgress(previous);
    setTitle((current) => (current === previous.title ? task.title : current));
    setOutput((current) => (current === previousOutput ? nextOutput : current));
    setBlocker((current) => (current === previousBlocker ? nextBlocker : current));
    setNextAction((current) => (current === (previous.next_action ?? "") ? task.next_action ?? "" : current));
    setNotes((current) => (current === (previous.notes ?? "") ? task.notes ?? "" : current));
    setProgress((current) => (current === previousProgress ? nextProgress : current));
    previousTaskRef.current = task;
  }, [task]);

  const commitText = useCallback(() => {
    if (exitingRef.current) return;
    const changes: Partial<Task> = {};
    const extra = parseTaskExtra(task);
    if (title.trim() !== task.title) changes.title = title.trim();
    if (output !== worklogOutput(task)) extra.daily_output = output || undefined;
    if (blocker !== worklogBlocker(task)) extra.blocker = blocker || undefined;
    if (nextAction !== (task.next_action ?? "")) changes.next_action = nextAction || null;
    if (notes !== (task.notes ?? "")) changes.notes = notes || null;
    const nextExtra = stringifyTaskExtra(extra);
    if (nextExtra !== (task.extra_json ?? null)) changes.extra_json = nextExtra;
    if (Object.keys(changes).length > 0) {
      onUpdate(task, changes);
    }
  }, [blocker, nextAction, notes, onUpdate, output, task, title]);

  const commitTextRef = useRef(commitText);

  useEffect(() => {
    commitTextRef.current = commitText;
  }, [commitText]);

  useEffect(() => {
    if (exiting) return;
    const changed =
      title.trim() !== task.title ||
      output !== worklogOutput(task) ||
      blocker !== worklogBlocker(task) ||
      nextAction !== (task.next_action ?? "") ||
      notes !== (task.notes ?? "");
    if (!changed) {
      return;
    }
    const timer = window.setTimeout(() => commitTextRef.current(), 1200);
    return () => window.clearTimeout(timer);
  }, [blocker, exiting, nextAction, notes, output, task, title]);

  useEffect(() => registerDraftFlusher(() => commitTextRef.current()), []);

  // The copy lands on another day, out of this view: the button confirms it.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  function updateImportance(value: TaskImportance) {
    const extra = parseTaskExtra(task);
    extra.importance = value;
    onUpdate(task, {
      priority: importancePriority(value),
      extra_json: stringifyTaskExtra(extra)
    });
  }

  function commitProgress(value: TaskProgress) {
    if (value === getTaskProgress(task) || value === progressCommitRef.current) return;
    progressCommitRef.current = value;
    const extra = parseTaskExtra(task);
    extra.progress_percent = value;
    const status = progressStatus(value);
    onUpdate(task, {
      status,
      completed_at: status === "done" ? (task.completed_at ?? new Date().toISOString()) : null,
      extra_json: stringifyTaskExtra(extra)
    });
  }

  // Once the task carries the committed value the guard has done its job.
  useEffect(() => {
    if (progressCommitRef.current !== null && getTaskProgress(task) === progressCommitRef.current) {
      progressCommitRef.current = null;
    }
  }, [task]);

  function taskDateWithOffset(offset: number): string {
    return addDays(toDateInput(task.start_date) || todayDate(), offset);
  }

  function copyTask(offset: number) {
    onCreate({
      title: task.title,
      project_id: task.project_id ?? null,
      description: task.description ?? null,
      status: task.status,
      priority: task.priority,
      due_date: task.due_date ?? null,
      start_date: taskDateWithOffset(offset),
      next_action: task.next_action ?? null,
      notes: task.notes ?? null,
      source: "app",
      external_key: null,
      extra_json: task.extra_json ?? null
    });
  }

  // On a day-scoped list the moved row leaves the view; the list folds it out.
  function moveTask(offset: number) {
    onUpdate(task, { start_date: taskDateWithOffset(offset) });
  }

  function toggle() {
    commitText();
    setExpanded((value) => !value);
  }

  // A press on the summary or the meter mounts the editor shut, so the tap
  // that follows only has to start the motion. A press that turns into a
  // scroll (cancelled) or a meter drag (grabbed) lets it go again, so a
  // drag doesn't re-render a hidden editor at every detent.
  function warmEditor(event: ReactPointerEvent<HTMLElement>) {
    if (event.isPrimary && event.button === 0) editor.warm();
  }

  function collapseFromFooter() {
    commitText();
    setExpanded(false);
    rowRef.current?.querySelector<HTMLButtonElement>(".task-summary")?.focus({ preventScroll: true });
  }

  const importance = getTaskImportance(task);
  const done = progress >= 100;
  const rowClass = `task-table-row importance-${importance}${showDate ? " with-date" : ""}${exiting ? " is-exiting" : ""}${
    expanded ? " is-expanded" : ""
  }${done ? " is-done" : ""}`;

  const titleField = (
    <label className="tt-cell tt-task">
      <span className="tt-label">{m.taskTable.task}</span>
      <AutoTextarea
        className="task-table-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commitText}
        rows={1}
        autoFocus={autoFocusTitle}
        placeholder={m.taskTable.newTask}
        aria-label={m.taskTable.task}
      />
    </label>
  );

  const dateField = showDate ? (
    <label className="tt-cell tt-date">
      <span className="tt-label">{m.taskTable.date}</span>
      <input
        type="date"
        value={task.start_date ?? ""}
        onChange={(event) => onUpdate(task, { start_date: event.target.value || null })}
        aria-label={m.taskTable.date}
      />
    </label>
  ) : null;

  const proseFields = (
    <>
      <label className="tt-cell tt-output">
        <span className="tt-label">{m.taskTable.output}</span>
        <AutoTextarea value={output} onChange={(event) => setOutput(event.target.value)} onBlur={commitText} rows={1} aria-label={m.taskTable.output} />
      </label>

      <label className="tt-cell tt-blocker">
        <span className="tt-label">{m.taskTable.blocker}</span>
        <AutoTextarea
          className={blocker ? "is-filled" : undefined}
          value={blocker}
          onChange={(event) => setBlocker(event.target.value)}
          onBlur={commitText}
          rows={1}
          aria-label={m.taskTable.blocker}
        />
      </label>

      <label className="tt-cell tt-next">
        <span className="tt-label">{m.taskTable.nextStep}</span>
        <AutoTextarea value={nextAction} onChange={(event) => setNextAction(event.target.value)} onBlur={commitText} rows={1} aria-label={m.taskTable.nextStep} />
      </label>
    </>
  );

  const notesField = (
    <AutoTextarea value={notes} onChange={(event) => setNotes(event.target.value)} onBlur={commitText} rows={1} placeholder={m.common.notes} aria-label={m.taskTable.noteAria} />
  );

  // Wide spreadsheet: the row is its cells, all editable in place.
  if (wide) {
    return (
      <div ref={rowRef} data-motion-key={task.id} className={rowClass}>
        <label className="tt-cell tt-importance">
          <span className="tt-label">{m.taskTable.importance}</span>
          <select
            className={`task-table-importance imp-${importance}`}
            value={importance}
            onChange={(event) => updateImportance(Number(event.target.value) as TaskImportance)}
            aria-label={m.taskTable.importance}
          >
            {importanceValues.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="tt-cell tt-project">
          <span className="tt-label">{m.common.project}</span>
          <select
            value={task.project_id ?? ""}
            onChange={(event) => onUpdate(task, { project_id: event.target.value || null })}
            aria-label={m.common.project}
          >
            <option value="">{m.common.noProject}</option>
            {projectOptions}
          </select>
        </label>

        {titleField}
        <ProgressField progress={progress} onInput={setProgress} onCommit={commitProgress} />
        {dateField}
        {proseFields}

        <div className="tt-cell tt-notes">
          <span className="tt-label">{m.common.notes}</span>
          <div className="task-table-note-cell">
            {notesField}
            <TaskMenu exiting={exiting} onCopy={copyTask} onMove={moveTask} onDelete={() => onDelete(task)} />
          </div>
        </div>
      </div>
    );
  }

  // Card. Closed, it is something to act on, not just a door to a form: a tap
  // opens it, a sideways drag on its meter sets the progress. Open, it adds
  // the fields that need typing and the actions for the task.
  const preview = blocker ? `${m.taskTable.blocker}: ${blocker}` : output ? `${m.taskTable.output}: ${output}` : nextAction ? `${m.taskTable.nextStep}: ${nextAction}` : notes;
  const editorId = `task-editor-${task.id}`;

  return (
    <div ref={rowRef} data-motion-key={task.id} className={rowClass}>
      <button
        type="button"
        className="task-summary"
        aria-expanded={expanded}
        aria-controls={editor.mounted ? editorId : undefined}
        onPointerDown={warmEditor}
        onPointerCancel={editor.cool}
        onClick={toggle}
      >
        <span className="task-summary__meta">{projectName}{showDate && task.start_date ? ` · ${task.start_date}` : ""} · P{importance}</span>
        <ChevronDown className="task-summary__chevron" size={16} aria-hidden="true" />
        <strong className="task-summary__title">{title || m.taskTable.newTask}</strong>
        {preview ? (
          <span ref={previewRef} className="task-summary__preview">
            <span>{preview}</span>
          </span>
        ) : null}
      </button>

      <div className="task-card-progress" onPointerDown={warmEditor} onPointerCancel={editor.cool}>
        <ProgressField variant="card" progress={progress} onInput={setProgress} onCommit={commitProgress} onTap={toggle} onGrab={editor.cool} />
        <span className="task-card-progress__pct" aria-hidden="true">
          <RollDigits value={progress} text={`${progress}%`} />
        </span>
      </div>

      {editor.mounted ? (
        <div ref={editorRef} className="task-editor" id={editorId}>
          <div className="task-editor__fields">
            <div className="task-card-attrs">
              <div className="tt-cell tt-importance">
                <span className="tt-label">{m.taskTable.importance}</span>
                <SegControl
                  className="task-importance-seg"
                  options={importanceOptions}
                  value={String(importance) as ImportanceId}
                  onChange={(id) => updateImportance(Number(id) as TaskImportance)}
                  ariaLabel={m.taskTable.importance}
                />
              </div>
              <div className="tt-cell tt-project">
                <span className="tt-label" id={projectLabelId}>
                  {m.common.project}
                </span>
                <ProjectPicker
                  labelId={projectLabelId}
                  value={task.project_id ?? null}
                  projects={projects}
                  disabled={exiting}
                  onChange={(projectId) => onUpdate(task, { project_id: projectId })}
                />
              </div>
            </div>

            {titleField}
            {dateField}
            {proseFields}

            <label className="tt-cell tt-notes">
              <span className="tt-label">{m.common.notes}</span>
              {notesField}
            </label>

            <div className="task-card-actions">
              <button type="button" className="task-card-action" onClick={() => moveTask(1)}>
                <ArrowRight size={14} aria-hidden="true" />
                <span>{m.taskTable.quickMoveNext}</span>
              </button>
              <button
                type="button"
                className={`task-card-action${copied ? " is-confirmed" : ""}`}
                onClick={() => {
                  copyTask(1);
                  setCopied(true);
                }}
              >
                {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                <span>{m.taskTable.quickCopyNext}</span>
              </button>
              <div className="task-card-actions__end">
                <TaskMenu exiting={exiting} nextDay={false} onCopy={copyTask} onMove={moveTask} onDelete={() => onDelete(task)} />
                <button type="button" className="icon-button task-card-collapse" aria-label={m.taskTable.collapseDetails} onClick={collapseFromFooter}>
                  <ChevronUp size={17} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function taskRowPropsEqual(previous: Readonly<TaskRowProps>, next: Readonly<TaskRowProps>): boolean {
  return (
    previous.task === next.task &&
    previous.projects === next.projects &&
    previous.projectOptions === next.projectOptions &&
    previous.projectName === next.projectName &&
    previous.showDate === next.showDate &&
    previous.wide === next.wide &&
    previous.autoFocusTitle === next.autoFocusTitle &&
    previous.exiting === next.exiting
  );
}

// Parent pages recreate their action functions whenever App sync status
// changes. TaskTable passes stable forwarding callbacks below, so callback
// identity is intentionally omitted from this semantic comparison.
const TaskRow = memo(TaskRowComponent, taskRowPropsEqual);

// Render rows in small batches instead of mounting the whole worklog at once.
// A wide-table row is expensive (3 selects, 5 auto-sizing textareas, a canvas),
// so a full-corpus view (Projects/Search) mounting ~150+ rows in one
// synchronous paint can exhaust mobile Safari's renderer and crash the page.
// We mount an initial batch and append more as the bottom sentinel scrolls
// into view.
const INITIAL_BATCH = 40;
const BATCH_STEP = 40;

// Keep in step with `@container tasktable (min-width: 881px)` in app.css.
const WIDE_MIN_WIDTH = 881;
// The last layout seen, so a remounted table (a new day, another project)
// starts in the right mode instead of correcting itself a frame later.
let lastWide = false;

const taskKey = (task: Task) => task.id;

/** Whether the table is in its wide spreadsheet layout. The switch is a CSS
 * container query on the wrap; this mirrors it so rows render as cells or
 * as cards to match. */
function useWideLayout(wrapRef: RefObject<HTMLElement>): boolean {
  const [wide, setWide] = useState(lastWide);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = (width: number) => {
      lastWide = width >= WIDE_MIN_WIDTH;
      setWide(lastWide);
    };
    update(wrap.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [wrapRef]);
  return wide;
}

export function TaskTable({
  tasks,
  projects,
  showDate = true,
  focusTaskId,
  onCreate,
  onUpdate,
  onDelete,
  motionPace = "normal"
}: TaskTableProps) {
  const { m } = useI18n();
  const liveProjects = useMemo(() => projects.filter((project) => !project.deleted_at && project.archived === 0), [projects]);
  const projectOptions = useMemo(
    () =>
      liveProjects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      )),
    [liveProjects]
  );
  const handlersRef = useRef({ onCreate, onUpdate, onDelete });
  useLayoutEffect(() => {
    handlersRef.current = { onCreate, onUpdate, onDelete };
  }, [onCreate, onDelete, onUpdate]);
  const createFromRow = useCallback<TaskTableProps["onCreate"]>((input) => handlersRef.current.onCreate(input), []);
  const updateFromRow = useCallback<TaskTableProps["onUpdate"]>(
    (task, changes) => handlersRef.current.onUpdate(task, changes),
    []
  );
  const deleteFromRow = useCallback<TaskTableProps["onDelete"]>((task) => handlersRef.current.onDelete(task), []);

  // Reset back to the first batch whenever the underlying result set changes
  // (e.g. a new search query or project filter), so the user sees the top.
  const signature = `${tasks.length}:${tasks[0]?.id ?? ""}:${tasks[tasks.length - 1]?.id ?? ""}`;
  const [count, setCount] = useState(INITIAL_BATCH);
  useEffect(() => {
    setCount(INITIAL_BATCH);
  }, [signature]);

  const visible = count >= tasks.length ? tasks : tasks.slice(0, count);
  const remaining = tasks.length - visible.length;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLElement | null>(null);
  const wide = useWideLayout(wrapRef);
  const present = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);
  const rows = useListMotion(visible, taskKey, tableRef, present, { pace: motionPace });

  useEffect(() => {
    if (remaining <= 0) {
      return;
    }
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setCount((current) => Math.min(current + BATCH_STEP, tasks.length));
        }
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [remaining, tasks.length]);

  return (
    <section ref={wrapRef} className={`task-table-wrap${rows.length === 0 ? " is-empty" : ""}`} aria-label={m.taskTable.tableAria}>
      <div className="task-table" ref={tableRef}>
        <div className={`task-table-header${showDate ? " with-date" : ""}`} aria-hidden="true">
          <span>{m.taskTable.importance}</span>
          <span>{m.common.project}</span>
          <span>{m.taskTable.task}</span>
          <span>{m.taskTable.progressHeader}</span>
          {showDate ? <span>{m.taskTable.date}</span> : null}
          <span>{m.taskTable.output}</span>
          <span>{m.taskTable.blocker}</span>
          <span>{m.taskTable.nextStep}</span>
          <span>{m.common.notes}</span>
        </div>
        {rows.map(({ key, item: task, exiting }) => (
          <TaskRow
            key={key}
            task={task}
            projects={liveProjects}
            projectOptions={projectOptions}
            projectName={liveProjects.find((project) => project.id === task.project_id)?.name ?? m.common.noProject}
            showDate={showDate}
            wide={wide}
            autoFocusTitle={task.id === focusTaskId}
            exiting={exiting}
            onCreate={createFromRow}
            onUpdate={updateFromRow}
            onDelete={deleteFromRow}
          />
        ))}
      </div>
      {remaining > 0 ? (
        <>
          <div ref={sentinelRef} className="task-table-sentinel" aria-hidden="true" />
          <p className="table-more">{m.taskTable.showing(visible.length, tasks.length)}</p>
        </>
      ) : null}
    </section>
  );
}
