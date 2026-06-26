import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { isProjectCacheTask, parseTaskExtra, stringifyTaskExtra } from "../lib/progress";
import type { Project, Task } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

function projectItems(tasks: Task[], project: Project): Task[] {
  return tasks
    .filter((task) => !task.deleted_at && task.archived === 0 && task.project_id === project.id && isProjectCacheTask(task))
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
}

function CacheItem({
  task,
  onUpdate,
  onDelete
}: {
  task: Task;
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onDelete: (task: Task) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");

  function commit() {
    const changes: Partial<Task> = {};
    const cleanTitle = title.trim();
    if (cleanTitle && cleanTitle !== task.title) {
      changes.title = cleanTitle;
    }
    if (notes !== (task.notes ?? "")) {
      changes.notes = notes || null;
    }
    if (Object.keys(changes).length > 0) {
      onUpdate(task, changes);
    }
  }

  return (
    <article className="cache-item">
      <textarea value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commit} rows={2} aria-label="Next item" />
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} onBlur={commit} rows={1} placeholder="Note" aria-label="Next item note" />
      <button type="button" className="icon-button danger" onClick={() => onDelete(task)} aria-label="Delete next item" title="Delete">
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </article>
  );
}

function CacheColumn({
  project,
  items,
  onCreate,
  onUpdate,
  onDelete
}: {
  project: Project;
  items: Task[];
  onCreate: (project: Project, title: string) => void;
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onDelete: (task: Task) => void;
}) {
  const [title, setTitle] = useState("");

  function createItem() {
    const clean = title.trim();
    if (!clean) return;
    onCreate(project, clean);
    setTitle("");
  }

  return (
    <section className="cache-column">
      <header>
        <h2>{project.name}</h2>
        <span>{items.length}</span>
      </header>
      <div className="cache-add">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Next thing to remember" aria-label={`New item for ${project.name}`} />
        <button type="button" onClick={createItem} aria-label={`Add item for ${project.name}`}>
          <Plus size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="cache-items">
        {items.map((task) => (
          <CacheItem key={task.id} task={task} onUpdate={onUpdate} onDelete={onDelete} />
        ))}
        {items.length === 0 ? <p className="empty-state">No saved ideas yet.</p> : null}
      </div>
    </section>
  );
}

export function NextPage(props: TaskPageProps) {
  const { projects, tasks, onCreateTask, onUpdateTask, onDeleteTask } = props;
  const liveProjects = useMemo(() => projects.filter((project) => !project.deleted_at && project.archived === 0), [projects]);
  const cacheTasks = useMemo(() => tasks.filter((task) => !task.deleted_at && task.archived === 0 && isProjectCacheTask(task)), [tasks]);

  function createCacheItem(project: Project, title: string) {
    const extra = {
      cache_item: true,
      source_sheet: "项目缓存",
      cache_project: project.name
    };
    onCreateTask({
      title,
      project_id: project.id,
      status: "todo",
      priority: "medium",
      start_date: null,
      due_date: null,
      next_action: null,
      notes: null,
      source: "project_cache",
      external_key: `project-cache:${project.id}:${Date.now()}`,
      extra_json: stringifyTaskExtra(extra)
    });
  }

  function updateCacheItem(task: Task, changes: Partial<Task>) {
    const extra = parseTaskExtra(task);
    extra.cache_item = true;
    extra.source_sheet = "项目缓存";
    onUpdateTask(task, {
      ...changes,
      source: "project_cache",
      start_date: null,
      due_date: null,
      extra_json: stringifyTaskExtra(extra)
    });
  }

  return (
    <main className="page-content cache-page">
      <header className="page-header">
        <h1>Next</h1>
        <p>{cacheTasks.length} saved ideas and future tasks</p>
      </header>
      <section className="cache-board" aria-label="Project cache">
        {liveProjects.map((project) => (
          <CacheColumn
            key={project.id}
            project={project}
            items={projectItems(tasks, project)}
            onCreate={createCacheItem}
            onUpdate={updateCacheItem}
            onDelete={onDeleteTask}
          />
        ))}
      </section>
    </main>
  );
}
