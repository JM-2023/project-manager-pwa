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
import { addDays, formatDoneMoment, formatGroupDay, todayDate, toDateInput } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import {
  getTaskImportance,
  getTaskProgress,
  importancePriority,
  parseTaskExtra,
  progressStatus,
  progressTone,
  stringifyTaskExtra,
  summarizeProgress,
  worklogBlocker,
  worklogOutput,
  type TaskImportance,
  type TaskProgress
} from "../lib/progress";
import { useToday } from "../lib/useToday";
import { useSpringDisclosure } from "../lib/disclosure";
import { useListMotion } from "../lib/listMotion";
import { coverTrigger, DROP_MOTION, dropFromTrigger, MORPH_MOTION, useFloatingPopover } from "../lib/floatingPopover";
import { handleMenuKeyDown } from "../lib/menuKeys";
import { useMeterDither } from "../lib/meterDither";
import { Marked } from "./Marked";
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
  /** Move the task to another day (the page offers to move it back). */
  onMove: (task: Task, date: string) => void;
  /** How fast its rows move (lib/listMotion): "quick" for a list that
   * changes as fast as the user types. */
  motionPace?: "normal" | "quick";
  /** Split the list into days under sticky headings, in the order the
   * tasks come (the long lists pass them newest first). "progress" heads
   * carry the day's count and weighted progress, "count" only the count. */
  dayGroups?: "progress" | "count";
  /** The search query, lowercased: its matches are marked on the cards. */
  highlight?: string;
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
  // The search query to mark on the card ("" when there is none).
  highlight: string;
  onCreate: (input: Partial<Task> & { title: string }) => void;
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onDelete: (task: Task) => void;
  onMove: (task: Task, date: string) => void;
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setMenuOpen(false), []);
  const menu = useFloatingPopover({ open: menuOpen, close, triggerRef, popoverRef, place: coverTrigger, motion: MORPH_MOTION });

  useEffect(() => {
    if (exiting) setMenuOpen(false);
  }, [exiting]);

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
        >
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
          {/* No confirm step: the page holds the delete back behind an
              undo, which is safer than asking and one tap shorter. */}
          <button type="button" role="menuitem" className="danger" onClick={() => act(onDelete)}>
            <span>{m.taskTable.deleteTask}</span>
          </button>
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
  const menu = useFloatingPopover({ open, close, triggerRef, popoverRef, place: dropFromTrigger, motion: DROP_MOTION });

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
    if (draggingRef.current) wrapRef.current?.setAttribute("data-detent", String(value));
    if (value === targetRef.current) return;
    targetRef.current = value;
    onInput(value);
  }

  // While a drag is on, the 25/50/75 detents show as ticks on the bar and
  // the one it will land on darkens. Attributes, not classes: the row
  // re-renders at every detent and React rewrites className.
  function showTicks(on: boolean) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (on) {
      wrap.setAttribute("data-scrubbing", "");
      wrap.setAttribute("data-detent", String(targetRef.current));
    } else {
      wrap.removeAttribute("data-scrubbing");
    }
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
    showTicks(true);
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
    showTicks(false);
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
        <span className="progress-ticks" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
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

function TaskRowComponent({ task, projects, projectOptions, projectName, showDate, wide, autoFocusTitle, exiting, highlight, onCreate, onUpdate, onDelete, onMove }: TaskRowProps) {
  const { m, lang } = useI18n();
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
    onMove(task, taskDateWithOffset(offset));
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
      {/* A title is one line that wraps: Return saves it and moves on to
          the output field, and a pasted line break becomes a space. */}
      <AutoTextarea
        className="task-table-title"
        value={title}
        onChange={(event) => setTitle(event.target.value.replace(/\s*[\r\n]+\s*/g, " "))}
        onKeyDown={(event) => {
          // Return inside an IME composition picks the candidate (pinyin).
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          commitText();
          rowRef.current?.querySelector<HTMLTextAreaElement>(".tt-output textarea")?.focus();
        }}
        onBlur={commitText}
        rows={1}
        autoFocus={autoFocusTitle}
        enterKeyHint="next"
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
  // The preview line shows the first worklog field that has something in
  // it; while searching, the first one the query matches, so the card says
  // why it is in the results.
  const previewFields: Array<[string, string]> = [
    [m.taskTable.blocker, blocker],
    [m.taskTable.output, output],
    [m.taskTable.nextStep, nextAction],
    ["", notes]
  ];
  const [previewLabel, previewText] =
    (highlight ? previewFields.find(([, text]) => text.toLowerCase().includes(highlight)) : undefined) ??
    previewFields.find(([, text]) => text) ??
    ["", ""];
  const editorId = `task-editor-${task.id}`;
  // Finished: the meta line says when (lib/dates formatDoneMoment).
  const doneMoment = done ? (task.completed_at ? formatDoneMoment(task.completed_at, task.start_date, lang) : "") : "";

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
        <span className="task-summary__meta">
          {/* Importance as a numbered chip: the deep levels solid, the
              light ones outlined, so the weight reads before the words. */}
          <span className={`imp-chip imp-chip--${importance}`}>
            <span aria-hidden="true">{importance}</span>
            <span className="sr-only">{`${m.taskTable.importance} ${importance}`}</span>
          </span>
          <span className="task-summary__project">
            <Marked text={projectName} query={highlight} />
            {done ? ` · ${doneMoment ? m.taskTable.doneAt(doneMoment) : m.taskTable.done}` : ""}
          </span>
        </span>
        <ChevronDown className="task-summary__chevron" size={16} aria-hidden="true" />
        <strong className="task-summary__title">
          {/* Struck through left to right when the task is done. */}
          <span className="task-summary__strike">
            {title ? <Marked text={title} query={highlight} /> : m.taskTable.newTask}
          </span>
        </strong>
        {previewText ? (
          <span ref={previewRef} className="task-summary__preview">
            <span>
              {previewLabel ? `${previewLabel}: ` : ""}
              <Marked text={previewText} query={highlight} />
            </span>
          </span>
        ) : null}
      </button>

      <div className="task-card-progress" onPointerDown={warmEditor} onPointerCancel={editor.cool}>
        <ProgressField variant="card" progress={progress} onInput={setProgress} onCommit={commitProgress} onTap={toggle} onGrab={editor.cool} />
        {/* At 100% the reading turns over to "Done"; both share one cell,
            so the bar keeps its length either way. */}
        <span className="task-card-progress__pct" aria-hidden="true">
          <span className="task-card-progress__num">
            <RollDigits value={progress} text={`${progress}%`} />
          </span>
          <span className="task-card-progress__done">
            <Check size={13} strokeWidth={2.6} />
            {m.taskTable.done}
          </span>
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
    previous.exiting === next.exiting &&
    previous.highlight === next.highlight
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

/** One line of the table: a task, or the heading of the day it is on. */
type TableItem =
  | { kind: "task"; key: string; task: Task }
  | { kind: "day"; key: string; date: string; count: number; percent: number };

const itemKey = (item: TableItem) => item.key;
const dayKey = (date: string) => `day:${date}`;

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
  onMove,
  motionPace = "normal",
  dayGroups,
  highlight = ""
}: TaskTableProps) {
  const { m, lang } = useI18n();
  const today = useToday();
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
  const handlersRef = useRef({ onCreate, onUpdate, onDelete, onMove });
  useLayoutEffect(() => {
    handlersRef.current = { onCreate, onUpdate, onDelete, onMove };
  }, [onCreate, onDelete, onMove, onUpdate]);
  const createFromRow = useCallback<TaskTableProps["onCreate"]>((input) => handlersRef.current.onCreate(input), []);
  const updateFromRow = useCallback<TaskTableProps["onUpdate"]>(
    (task, changes) => handlersRef.current.onUpdate(task, changes),
    []
  );
  const deleteFromRow = useCallback<TaskTableProps["onDelete"]>((task) => handlersRef.current.onDelete(task), []);
  const moveFromRow = useCallback<TaskTableProps["onMove"]>((task, date) => handlersRef.current.onMove(task, date), []);

  // Reset back to the first batch whenever the underlying result set changes
  // (e.g. a new search query or project filter), so the user sees the top.
  const signature = `${tasks.length}:${tasks[0]?.id ?? ""}:${tasks[tasks.length - 1]?.id ?? ""}`;
  const [count, setCount] = useState(INITIAL_BATCH);
  useEffect(() => {
    setCount(INITIAL_BATCH);
  }, [signature]);

  // A batch never ends partway through a day: it runs on to the day's last task.
  let shown = Math.min(count, tasks.length);
  if (dayGroups) {
    const lastDay = shown > 0 ? toDateInput(tasks[shown - 1].start_date) : "";
    while (shown < tasks.length && toDateInput(tasks[shown].start_date) === lastDay) shown += 1;
  }
  const visible = shown >= tasks.length ? tasks : tasks.slice(0, shown);
  const remaining = tasks.length - visible.length;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLElement | null>(null);
  const wide = useWideLayout(wrapRef);

  // The days of the whole result set: a heading counts its day's tasks
  // even before a later batch has mounted all of them.
  const days = useMemo(() => {
    const byDay = new Map<string, Task[]>();
    if (!dayGroups) return byDay;
    for (const task of tasks) {
      const date = toDateInput(task.start_date);
      const list = byDay.get(date);
      if (list) list.push(task);
      else byDay.set(date, [task]);
    }
    return byDay;
  }, [dayGroups, tasks]);
  const items = useMemo(() => {
    const list: TableItem[] = [];
    let day: string | null = null;
    for (const task of visible) {
      const date = toDateInput(task.start_date);
      if (dayGroups && date !== day) {
        day = date;
        const dayTasks = days.get(date) ?? [];
        const summary = dayGroups === "progress" ? summarizeProgress(dayTasks) : null;
        list.push({
          kind: "day",
          key: dayKey(date),
          date,
          count: summary ? summary.taskCount : dayTasks.length,
          percent: summary ? summary.weightedPercent : 0
        });
      }
      list.push({ kind: "task", key: task.id, task });
    }
    return list;
  }, [dayGroups, days, visible]);
  const present = useMemo(() => {
    const keys = new Set(tasks.map((task) => task.id));
    for (const date of days.keys()) keys.add(dayKey(date));
    return keys;
  }, [days, tasks]);
  // Headings arrive, leave and glide with the rows they head (lib/listMotion).
  const rows = useListMotion(items, itemKey, tableRef, present, { pace: motionPace });

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
          setCount((current) => Math.min(Math.max(current, shown) + BATCH_STEP, tasks.length));
        }
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [remaining, shown, tasks.length]);

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
        {rows.map(({ key, item, exiting }) =>
          item.kind === "day" ? (
            <h2
              key={key}
              data-motion-key={key}
              className={`task-day-head${item.date === today ? " is-today" : ""}${exiting ? " is-exiting" : ""}`}
            >
              <span className="task-day-head__date">{formatGroupDay(item.date, today, lang)}</span>
              <span className="task-day-head__stats">
                {dayGroups === "progress" ? m.taskTable.dayStats(item.count, item.percent) : item.count}
              </span>
            </h2>
          ) : (
            <TaskRow
              key={key}
              task={item.task}
              projects={liveProjects}
              projectOptions={projectOptions}
              projectName={liveProjects.find((project) => project.id === item.task.project_id)?.name ?? m.common.noProject}
              showDate={showDate}
              wide={wide}
              autoFocusTitle={item.task.id === focusTaskId}
              exiting={exiting}
              highlight={highlight}
              onCreate={createFromRow}
              onUpdate={updateFromRow}
              onDelete={deleteFromRow}
              onMove={moveFromRow}
            />
          )
        )}
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
