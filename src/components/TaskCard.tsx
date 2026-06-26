import { Archive, Ban, CheckCircle2, Circle, Clock3, Hourglass, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DatePicker } from "./DatePicker";
import { StatusPill } from "./StatusPill";
import type { Tag, Task, TaskPriority, TaskStatus, TaskTag } from "../lib/types";
import { formatShortDate } from "../lib/dates";
import { priorityLabel, statusLabel } from "../lib/validation";

interface TaskCardProps {
  task: Task;
  projectName?: string;
  tags: Tag[];
  taskTags: TaskTag[];
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onArchive: (task: Task) => void;
  onDelete: (task: Task) => void;
  onAddTag: (task: Task, tagName: string) => void;
}

const quickStatuses: Array<{ status: TaskStatus; Icon: typeof Circle }> = [
  { status: "todo", Icon: Circle },
  { status: "doing", Icon: Hourglass },
  { status: "waiting", Icon: Clock3 },
  { status: "blocked", Icon: Ban },
  { status: "done", Icon: CheckCircle2 }
];

export function TaskCard({ task, projectName, tags, taskTags, onUpdate, onArchive, onDelete, onAddTag }: TaskCardProps) {
  const [title, setTitle] = useState(task.title);
  const [nextAction, setNextAction] = useState(task.next_action ?? "");
  const [notes, setNotes] = useState(task.notes ?? "");
  const [tagName, setTagName] = useState("");

  useEffect(() => {
    setTitle(task.title);
    setNextAction(task.next_action ?? "");
    setNotes(task.notes ?? "");
  }, [task.id, task.title, task.next_action, task.notes]);

  const attachedTags = useMemo(() => {
    const tagIds = new Set(taskTags.filter((link) => link.task_id === task.id && !link.deleted_at).map((link) => link.tag_id));
    return tags.filter((tag) => tagIds.has(tag.id) && !tag.deleted_at);
  }, [tags, task.id, taskTags]);

  function commitText() {
    const changes: Partial<Task> = {};
    if (title.trim() && title.trim() !== task.title) changes.title = title.trim();
    if (nextAction !== (task.next_action ?? "")) changes.next_action = nextAction || null;
    if (notes !== (task.notes ?? "")) changes.notes = notes || null;
    if (Object.keys(changes).length > 0) {
      onUpdate(task, changes);
    }
  }

  function addTag() {
    const clean = tagName.trim();
    if (!clean) {
      return;
    }
    onAddTag(task, clean);
    setTagName("");
  }

  return (
    <article className={`task-card priority-${task.priority}`}>
      <div className="task-card-top">
        <div>
          <input
            className="task-title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitText}
            aria-label="Task title"
          />
          <div className="task-meta">
            <span>{projectName || "No project"}</span>
            <span>{formatShortDate(task.due_date || task.start_date)}</span>
          </div>
        </div>
        <StatusPill status={task.status} />
      </div>

      <div className="quick-status" aria-label="Quick status">
        {quickStatuses.map(({ status, Icon }) => (
          <button
            key={status}
            type="button"
            className={task.status === status ? "active" : ""}
            onClick={() => onUpdate(task, { status, completed_at: status === "done" ? new Date().toISOString() : null })}
            title={statusLabel(status)}
            aria-label={`Set status to ${statusLabel(status)}`}
          >
            <Icon size={17} aria-hidden="true" />
            <span>{statusLabel(status)}</span>
          </button>
        ))}
      </div>

      <div className="task-controls">
        <label className="field-label">
          <span>Priority</span>
          <select value={task.priority} onChange={(event) => onUpdate(task, { priority: event.target.value as TaskPriority })}>
            <option value="low">{priorityLabel("low")}</option>
            <option value="medium">{priorityLabel("medium")}</option>
            <option value="high">{priorityLabel("high")}</option>
            <option value="urgent">{priorityLabel("urgent")}</option>
          </select>
        </label>
        <DatePicker label="Due" value={task.due_date ?? ""} onChange={(due_date) => onUpdate(task, { due_date })} />
      </div>

      <label className="field-label full">
        <span>Next action</span>
        <textarea value={nextAction} onChange={(event) => setNextAction(event.target.value)} onBlur={commitText} rows={2} />
      </label>

      <details className="task-notes">
        <summary>Notes</summary>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} onBlur={commitText} rows={4} />
      </details>

      <div className="tag-row">
        {attachedTags.map((tag) => (
          <span key={tag.id} className="tag-chip">
            {tag.name}
          </span>
        ))}
        <div className="tag-input">
          <input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="Tag" aria-label="Tag name" />
          <button type="button" onClick={addTag} aria-label="Add tag">
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="task-actions">
        <button type="button" className="ghost-button" onClick={() => onArchive(task)}>
          <Archive size={16} aria-hidden="true" />
          <span>Archive</span>
        </button>
        <button type="button" className="ghost-button danger" onClick={() => onDelete(task)}>
          <Trash2 size={16} aria-hidden="true" />
          <span>Delete</span>
        </button>
      </div>
    </article>
  );
}
