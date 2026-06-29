import { Check, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type TextareaHTMLAttributes } from "react";
import { isProjectCacheTask, parseTaskExtra, stringifyTaskExtra } from "../lib/progress";
import type { Project, Task } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

function projectItems(tasks: Task[], project: Project): Task[] {
  return tasks
    .filter((task) => !task.deleted_at && task.archived === 0 && task.project_id === project.id && isProjectCacheTask(task))
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
}

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

  function commit() {
    const cleanTitle = title.trim();
    if (cleanTitle && cleanTitle !== task.title) {
      onUpdate(task, { title: cleanTitle });
    }
  }

  return (
    <article className="cache-item">
      <AutoTextarea value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commit} rows={1} aria-label="Next item" />
      <button type="button" className="icon-button danger" onClick={() => onDelete(task)} aria-label="Delete next item" title="Delete">
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </article>
  );
}

function CacheSection({
  project,
  items,
  onCreate,
  onUpdate,
  onDelete,
  onDeleteProject
}: {
  project: Project;
  items: Task[];
  onCreate: (project: Project, title: string) => void;
  onUpdate: (task: Task, changes: Partial<Task>) => void;
  onDelete: (task: Task) => void;
  onDeleteProject: (project: Project) => void;
}) {
  const [title, setTitle] = useState("");
  const [confirming, setConfirming] = useState(false);

  function createItem() {
    const clean = title.trim();
    if (!clean) return;
    onCreate(project, clean);
    setTitle("");
  }

  // Clicks inside <summary> must not toggle the details element.
  function stop(event: { preventDefault: () => void; stopPropagation: () => void }) {
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <details className="cache-section">
      <summary className="cache-section__head">
        <ChevronRight className="cache-chevron" size={18} aria-hidden="true" />
        <span className="cache-section__name">{project.name}</span>
        <span className="cache-count">{items.length}</span>
        {confirming ? (
          <span className="cache-confirm" role="group" aria-label="Confirm remove from Next">
            <button
              type="button"
              className="icon-button danger"
              onClick={(event) => {
                stop(event);
                onDeleteProject(project);
              }}
              aria-label={`Confirm remove ${project.name} from Next`}
              title="Confirm"
            >
              <Check size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={(event) => {
                stop(event);
                setConfirming(false);
              }}
              aria-label="Cancel"
              title="Cancel"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="icon-button cache-section__remove"
            onClick={(event) => {
              stop(event);
              setConfirming(true);
            }}
            aria-label={`Remove ${project.name} from Next`}
            title="Remove from Next"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </summary>
      <div className="cache-section__body">
        <div className="cache-add">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                createItem();
              }
            }}
            placeholder="Add an idea"
            aria-label={`New item for ${project.name}`}
          />
          <button type="button" onClick={createItem} aria-label={`Add item for ${project.name}`}>
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="cache-items">
          {items.map((task) => (
            <CacheItem key={task.id} task={task} onUpdate={onUpdate} onDelete={onDelete} />
          ))}
          {items.length === 0 ? <p className="empty-state">No saved ideas yet.</p> : null}
        </div>
      </div>
    </details>
  );
}

const NEXT_HIDDEN_KEY = "project-manager-next-hidden";

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(NEXT_HIDDEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function NextPage(props: TaskPageProps) {
  const { projects, tasks, onCreateTask, onUpdateTask, onDeleteTask } = props;
  // Projects the user removed from Next. This is a Next-only view preference —
  // the project itself stays live on the Projects tab; only its section here
  // (and its saved ideas) are dropped.
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const liveProjects = useMemo(
    () => projects.filter((project) => !project.deleted_at && project.archived === 0 && !hidden.has(project.id)),
    [projects, hidden]
  );
  const cacheTasks = useMemo(() => tasks.filter((task) => !task.deleted_at && task.archived === 0 && isProjectCacheTask(task)), [tasks]);

  function removeProjectFromNext(project: Project) {
    // Drop this project's saved ideas, then hide its section from Next.
    projectItems(tasks, project).forEach((item) => onDeleteTask(item));
    setHidden((prev) => {
      const next = new Set(prev);
      next.add(project.id);
      try {
        localStorage.setItem(NEXT_HIDDEN_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore persistence failures — view preference only */
      }
      return next;
    });
  }

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
          <CacheSection
            key={project.id}
            project={project}
            items={projectItems(tasks, project)}
            onCreate={createCacheItem}
            onUpdate={updateCacheItem}
            onDelete={onDeleteTask}
            onDeleteProject={removeProjectFromNext}
          />
        ))}
        {liveProjects.length === 0 ? <p className="empty-state">No projects yet — create one on the Projects tab.</p> : null}
      </section>
    </main>
  );
}
