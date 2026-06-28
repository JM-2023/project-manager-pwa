import { ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, MoreHorizontal, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type TextareaHTMLAttributes
} from "react";
import type { Project, Task } from "../lib/types";
import { addDays, todayDate, toDateInput } from "../lib/dates";
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

interface TaskTableProps {
  tasks: Task[];
  projects: Project[];
  showDate?: boolean;
  onCreate: (input: Partial<Task> & { title: string }) => void;
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onDelete: (task: Task) => void;
}

interface TaskRowProps {
  task: Task;
  projects: Project[];
  showDate: boolean;
  onCreate: (input: Partial<Task> & { title: string }) => void;
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onDelete: (task: Task) => void;
}

const importanceValues: TaskImportance[] = [1, 2, 3, 4];

function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const value = typeof props.value === "string" ? props.value : String(props.value ?? "");

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  return <textarea {...props} ref={ref} />;
}

function TaskRow({ task, projects, showDate, onCreate, onUpdate, onDelete }: TaskRowProps) {
  const [title, setTitle] = useState(task.title);
  const [output, setOutput] = useState(worklogOutput(task));
  const [blocker, setBlocker] = useState(worklogBlocker(task));
  const [nextAction, setNextAction] = useState(task.next_action ?? "");
  const [notes, setNotes] = useState(task.notes ?? "");
  const [progress, setProgress] = useState<TaskProgress>(getTaskProgress(task));
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const previousTaskRef = useRef(task);

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
  }, [blocker, nextAction, notes, output, task, title]);

  useEffect(() => {
    function flushDraft() {
      commitTextRef.current();
    }
    function flushWhenHidden() {
      if (document.visibilityState === "hidden") {
        flushDraft();
      }
    }

    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushDraft);
    window.addEventListener("beforeunload", flushDraft);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushDraft);
      window.removeEventListener("beforeunload", flushDraft);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function closeOnOutsideClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  function updateImportance(value: TaskImportance) {
    const extra = parseTaskExtra(task);
    extra.importance = value;
    onUpdate(task, {
      priority: importancePriority(value),
      extra_json: stringifyTaskExtra(extra)
    });
  }

  function updateProgress(value: TaskProgress) {
    const extra = parseTaskExtra(task);
    extra.progress_percent = value;
    const status = progressStatus(value);
    onUpdate(task, {
      status,
      completed_at: status === "done" ? (task.completed_at ?? new Date().toISOString()) : null,
      extra_json: stringifyTaskExtra(extra)
    });
  }

  function commitProgress(value: TaskProgress) {
    if (value !== getTaskProgress(task)) {
      updateProgress(value);
    }
  }

  function taskDateWithOffset(offset: number): string {
    return addDays(toDateInput(task.start_date) || todayDate(), offset);
  }

  function copyTask(offset: number) {
    const targetDate = taskDateWithOffset(offset);
    onCreate({
      title: task.title,
      project_id: task.project_id ?? null,
      description: task.description ?? null,
      status: task.status,
      priority: task.priority,
      due_date: task.due_date ?? null,
      start_date: targetDate,
      next_action: task.next_action ?? null,
      notes: task.notes ?? null,
      source: "app",
      external_key: null,
      extra_json: task.extra_json ?? null
    });
    setMenuOpen(false);
  }

  function moveTask(offset: number) {
    onUpdate(task, { start_date: taskDateWithOffset(offset) });
    setMenuOpen(false);
  }

  const importance = getTaskImportance(task);

  return (
    <div className={`task-table-row importance-${importance}${showDate ? " with-date" : ""}`}>
      <label className="tt-cell tt-importance">
        <span className="tt-label">重要程度</span>
        <select
          className={`task-table-importance imp-${importance}`}
          value={importance}
          onChange={(event) => updateImportance(Number(event.target.value) as TaskImportance)}
          aria-label="Importance"
        >
          {importanceValues.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      <label className="tt-cell tt-project">
        <span className="tt-label">Project</span>
        <select
          value={task.project_id ?? ""}
          onChange={(event) => onUpdate(task, { project_id: event.target.value || null })}
          aria-label="Project"
        >
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      <label className="tt-cell tt-task">
        <span className="tt-label">Task</span>
        <AutoTextarea
          className="task-table-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitText}
          rows={1}
          placeholder="New task…"
          aria-label="Task"
        />
      </label>

      <div className="tt-cell tt-progress">
        <span className="tt-label">Progress</span>
        <div className={`task-table-progress tone-${progressTone(progress)}`} style={{ "--pct": `${progress}%` } as CSSProperties}>
          <span className="progress-badge">{progress}%</span>
          <input
            type="range"
            className="progress-slider"
            min={0}
            max={100}
            step={25}
            value={progress}
            onChange={(event) => setProgress(Number(event.target.value) as TaskProgress)}
            onPointerUp={(event) => commitProgress(Number((event.target as HTMLInputElement).value) as TaskProgress)}
            onKeyUp={(event) => commitProgress(Number((event.target as HTMLInputElement).value) as TaskProgress)}
            aria-label="Progress"
            aria-valuetext={`${progress}%`}
          />
        </div>
      </div>

      {showDate ? (
        <label className="tt-cell tt-date">
          <span className="tt-label">Date</span>
          <input
            type="date"
            value={task.start_date ?? ""}
            onChange={(event) => onUpdate(task, { start_date: event.target.value || null })}
            aria-label="Date"
          />
        </label>
      ) : null}

      <label className="tt-cell tt-output">
        <span className="tt-label">今日产出</span>
        <AutoTextarea value={output} onChange={(event) => setOutput(event.target.value)} onBlur={commitText} rows={1} aria-label="Output" />
      </label>

      <label className="tt-cell tt-blocker">
        <span className="tt-label">卡住的地方</span>
        <AutoTextarea value={blocker} onChange={(event) => setBlocker(event.target.value)} onBlur={commitText} rows={1} aria-label="Blocked" />
      </label>

      <label className="tt-cell tt-next">
        <span className="tt-label">明天第一步</span>
        <AutoTextarea value={nextAction} onChange={(event) => setNextAction(event.target.value)} onBlur={commitText} rows={1} aria-label="Tomorrow first step" />
      </label>

      <div className="tt-cell tt-notes">
        <span className="tt-label">Notes</span>
        <div className="task-table-note-cell">
          <AutoTextarea value={notes} onChange={(event) => setNotes(event.target.value)} onBlur={commitText} rows={1} aria-label="Note" />
          <div className={`task-menu${menuOpen ? " is-open" : ""}`} ref={menuRef}>
            <button type="button" className="icon-button task-menu-trigger" onClick={() => setMenuOpen((open) => !open)} aria-label="Task actions" aria-haspopup="menu" aria-expanded={menuOpen}>
              <MoreHorizontal size={17} aria-hidden="true" />
            </button>
            {menuOpen ? (
              <div className="task-action-menu" role="menu" aria-label="Task actions">
                <button type="button" role="menuitem" onClick={() => copyTask(-1)}>
                  <ArrowLeftToLine size={15} aria-hidden="true" />
                  <span>Copy to yesterday</span>
                </button>
                <button type="button" role="menuitem" onClick={() => copyTask(1)}>
                  <ArrowRightToLine size={15} aria-hidden="true" />
                  <span>Copy to tomorrow</span>
                </button>
                <button type="button" role="menuitem" onClick={() => moveTask(-1)}>
                  <ArrowLeft size={15} aria-hidden="true" />
                  <span>Move to yesterday</span>
                </button>
                <button type="button" role="menuitem" onClick={() => moveTask(1)}>
                  <ArrowRight size={15} aria-hidden="true" />
                  <span>Move to tomorrow</span>
                </button>
                <span className="task-action-menu__sep" role="separator" />
                <button type="button" role="menuitem" className="danger" onClick={() => { onDelete(task); setMenuOpen(false); }}>
                  <Trash2 size={15} aria-hidden="true" />
                  <span>Delete task</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// Render rows in small batches instead of mounting the whole worklog at once.
// Each row is expensive (3 selects, 5 auto-sizing textareas, SVG icons), so a
// full-corpus view (Projects/Search) mounting ~150+ rows in one synchronous
// paint can exhaust mobile Safari's renderer and crash the page. We mount an
// initial batch and append more as the bottom sentinel scrolls into view.
const INITIAL_BATCH = 40;
const BATCH_STEP = 40;

export function TaskTable({ tasks, projects, showDate = true, onCreate, onUpdate, onDelete }: TaskTableProps) {
  const liveProjects = useMemo(() => projects.filter((project) => !project.deleted_at && project.archived === 0), [projects]);

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
    <section className="task-table-wrap" aria-label="Task table">
      <div className="task-table">
        <div className={`task-table-header${showDate ? " with-date" : ""}`} aria-hidden="true">
          <span>重要程度</span>
          <span>Project</span>
          <span>Task</span>
          <span>Progress</span>
          {showDate ? <span>Date</span> : null}
          <span>今日产出</span>
          <span>卡住的地方</span>
          <span>明天第一步</span>
          <span>Notes</span>
        </div>
        {visible.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            projects={liveProjects}
            showDate={showDate}
            onCreate={onCreate}
            onUpdate={onUpdate}
            onDelete={onDelete}
          />
        ))}
      </div>
      {remaining > 0 ? (
        <>
          <div ref={sentinelRef} className="task-table-sentinel" aria-hidden="true" />
          <p className="table-more">Showing {visible.length} of {tasks.length}. Scroll for more, or search to narrow down.</p>
        </>
      ) : null}
    </section>
  );
}
