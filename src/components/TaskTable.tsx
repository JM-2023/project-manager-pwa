import { Archive, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type TextareaHTMLAttributes } from "react";
import type { Project, Task } from "../lib/types";
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
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onArchive: (task: Task) => void;
  onDelete: (task: Task) => void;
}

interface TaskRowProps {
  task: Task;
  projects: Project[];
  showDate: boolean;
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onArchive: (task: Task) => void;
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

function TaskRow({ task, projects, showDate, onUpdate, onArchive, onDelete }: TaskRowProps) {
  const [title, setTitle] = useState(task.title);
  const [output, setOutput] = useState(worklogOutput(task));
  const [blocker, setBlocker] = useState(worklogBlocker(task));
  const [nextAction, setNextAction] = useState(task.next_action ?? "");
  const [notes, setNotes] = useState(task.notes ?? "");
  const [progress, setProgress] = useState<TaskProgress>(getTaskProgress(task));

  useEffect(() => {
    setTitle(task.title);
    setOutput(worklogOutput(task));
    setBlocker(worklogBlocker(task));
    setNextAction(task.next_action ?? "");
    setNotes(task.notes ?? "");
    setProgress(getTaskProgress(task));
  }, [task.id, task.title, task.next_action, task.notes, task.extra_json, task.status]);

  function commitText() {
    const changes: Partial<Task> = {};
    const extra = parseTaskExtra(task);
    if (title.trim() && title.trim() !== task.title) changes.title = title.trim();
    if (output !== worklogOutput(task)) extra.daily_output = output || undefined;
    if (blocker !== worklogBlocker(task)) extra.blocker = blocker || undefined;
    if (nextAction !== (task.next_action ?? "")) changes.next_action = nextAction || null;
    if (notes !== (task.notes ?? "")) changes.notes = notes || null;
    const nextExtra = stringifyTaskExtra(extra);
    if (nextExtra !== (task.extra_json ?? null)) changes.extra_json = nextExtra;
    if (Object.keys(changes).length > 0) {
      onUpdate(task, changes);
    }
  }

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
          <button type="button" className="icon-button" onClick={() => onArchive(task)} aria-label="Archive task" title="Archive">
            <Archive size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button danger" onClick={() => onDelete(task)} aria-label="Delete task" title="Delete">
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Cap rendered rows so a large imported worklog can't exhaust mobile Safari's
// renderer (each row mounts several auto-sizing fields). Filter to narrow down.
const ROW_CAP = 150;

export function TaskTable({ tasks, projects, showDate = true, onUpdate, onArchive, onDelete }: TaskTableProps) {
  const liveProjects = useMemo(() => projects.filter((project) => !project.deleted_at && project.archived === 0), [projects]);
  const visible = tasks.length > ROW_CAP ? tasks.slice(0, ROW_CAP) : tasks;
  const hidden = tasks.length - visible.length;

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
            onUpdate={onUpdate}
            onArchive={onArchive}
            onDelete={onDelete}
          />
        ))}
      </div>
      {hidden > 0 ? (
        <p className="table-more">Showing {visible.length} of {tasks.length}. Use search or filters to narrow down {hidden} more.</p>
      ) : null}
    </section>
  );
}
