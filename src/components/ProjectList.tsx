import { Archive, ArchiveRestore, Check, ChevronDown, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Project, Task } from "../lib/types";
import { isWorklogTask, progressTone, summarizeWorklogOverview, type WorklogOverview } from "../lib/progress";
import { useRemoveTransition } from "../lib/useRemoveTransition";

function ProgressMeter({ value }: { value: number }) {
  return (
    <span
      className={`row-progress tone-${progressTone(value)}`}
      style={{ "--pct": `${Math.max(0, Math.min(100, value))}%` } as CSSProperties}
      aria-hidden="true"
    />
  );
}

interface ProjectListProps {
  projects: Project[];
  archivedProjects: Project[];
  tasks: Task[];
  selectedProjectId: string;
  onSelect: (projectId: string) => void;
  onCreate?: (name: string) => void;
  onArchive: (project: Project) => void;
  onUnarchive: (project: Project) => void;
  onDelete: (project: Project) => void;
  onRename?: (project: Project, name: string) => void;
}

interface ProjectRowProps {
  project: Project;
  summary: WorklogOverview;
  active: boolean;
  onSelect: (projectId: string) => void;
  onArchive: (project: Project) => void;
  onDelete: (project: Project) => void;
  onRename?: (project: Project, name: string) => void;
}

// Two-step confirmation kept inside the popover: the first item click swaps the
// menu over to a confirm/cancel pair so destructive actions never fire on a
// single tap.
type ConfirmAction = "archive" | "delete";

function ProjectRow({ project, summary, active, onSelect, onArchive, onDelete, onRename }: ProjectRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const exitActionRef = useRef<(project: Project) => void>(onDelete);
  const { ref: rowRef, removing, begin: beginRemove, onTransitionEnd } = useRemoveTransition<HTMLDivElement>(
    () => exitActionRef.current(project)
  );

  useEffect(() => {
    setDraft(project.name);
  }, [project.name]);

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

  // Reset the confirm step whenever the menu closes so it reopens on the root view.
  useEffect(() => {
    if (!menuOpen) {
      setConfirm(null);
    }
  }, [menuOpen]);

  function commit() {
    const clean = draft.trim();
    if (clean && clean !== project.name && onRename) {
      onRename(project, clean);
    }
    setEditing(false);
  }

  function startRename() {
    setMenuOpen(false);
    setDraft(project.name);
    setEditing(true);
  }

  function runConfirm() {
    const action = confirm === "archive" ? onArchive : confirm === "delete" ? onDelete : null;
    setMenuOpen(false);
    if (action) {
      exitActionRef.current = action;
      beginRemove();
    }
  }

  if (editing) {
    return (
      <div className="project-row editing">
        <input
          className="project-rename"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              setDraft(project.name);
              setEditing(false);
            }
          }}
          onBlur={commit}
          aria-label={`Rename ${project.name}`}
        />
        <button type="button" className="icon-button" onMouseDown={(event) => event.preventDefault()} onClick={commit} aria-label="Save name">
          <Check size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className={`project-row${active ? " active" : ""}${removing ? " is-removing" : ""}`}
      onTransitionEnd={onTransitionEnd}
    >
      <button type="button" onClick={() => onSelect(project.id)}>
        <span className="project-color" style={{ backgroundColor: project.color ?? "var(--primary)" }} />
        <span>{project.name}</span>
        <strong>{summary.averageProgress}%</strong>
        <ProgressMeter value={summary.averageProgress} />
      </button>
      <div className={`task-menu${menuOpen ? " is-open" : ""}`} ref={menuRef}>
        <button
          type="button"
          className="icon-button task-menu-trigger"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={`Options for ${project.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Options"
        >
          <MoreHorizontal size={17} aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="task-action-menu" role="menu" aria-label={`Options for ${project.name}`}>
            {confirm ? (
              <>
                <span className="task-action-menu__prompt" role="presentation">
                  {confirm === "archive" ? "Archive this project?" : "Delete this project?"}
                </span>
                <button
                  type="button"
                  role="menuitem"
                  className={confirm === "delete" ? "danger" : ""}
                  onClick={runConfirm}
                >
                  {confirm === "archive" ? <Archive size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                  <span>{confirm === "archive" ? "Confirm archive" : "Confirm delete"}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => setConfirm(null)}>
                  <X size={15} aria-hidden="true" />
                  <span>Cancel</span>
                </button>
              </>
            ) : (
              <>
                {onRename ? (
                  <button type="button" role="menuitem" onClick={startRename}>
                    <Pencil size={15} aria-hidden="true" />
                    <span>Rename</span>
                  </button>
                ) : null}
                <button type="button" role="menuitem" onClick={() => setConfirm("archive")}>
                  <Archive size={15} aria-hidden="true" />
                  <span>Archive</span>
                </button>
                <span className="task-action-menu__sep" role="separator" />
                <button type="button" role="menuitem" className="danger" onClick={() => setConfirm("delete")}>
                  <Trash2 size={15} aria-hidden="true" />
                  <span>Delete</span>
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface ArchivedRowProps {
  project: Project;
  onUnarchive: (project: Project) => void;
}

function ArchivedRow({ project, onUnarchive }: ArchivedRowProps) {
  const { ref: rowRef, removing, begin: beginRemove, onTransitionEnd } = useRemoveTransition<HTMLDivElement>(
    () => onUnarchive(project)
  );
  return (
    <div
      ref={rowRef}
      className={`archived-row${removing ? " is-removing" : ""}`}
      onTransitionEnd={onTransitionEnd}
    >
      <span className="project-color" style={{ backgroundColor: project.color ?? "var(--primary)" }} />
      <span className="archived-row__name">{project.name}</span>
      <button
        type="button"
        className="icon-button"
        onClick={beginRemove}
        aria-label={`Restore ${project.name}`}
        title="Move back to projects"
      >
        <ArchiveRestore size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ProjectList({
  projects,
  archivedProjects,
  tasks,
  selectedProjectId,
  onSelect,
  onCreate,
  onArchive,
  onUnarchive,
  onDelete,
  onRename
}: ProjectListProps) {
  const [name, setName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const allSummary = summarizeWorklogOverview(tasks);

  function createProject() {
    const clean = name.trim();
    if (!clean || !onCreate) {
      return;
    }
    onCreate(clean);
    setName("");
  }

  return (
    <section className="project-list">
      {onCreate ? (
        <div className="project-create">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                createProject();
              }
            }}
            placeholder="New project"
            aria-label="New project name"
          />
          <button type="button" onClick={createProject} aria-label="Create project">
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <button type="button" className={!selectedProjectId ? "project-row active" : "project-row"} onClick={() => onSelect("")}>
        <span>All projects</span>
        <strong>{allSummary.averageProgress}%</strong>
        <ProgressMeter value={allSummary.averageProgress} />
      </button>
      {projects.map((project) => {
        const projectTasks = tasks.filter((task) => task.project_id === project.id && isWorklogTask(task));
        const summary = summarizeWorklogOverview(projectTasks);
        return (
          <ProjectRow
            key={project.id}
            project={project}
            summary={summary}
            active={selectedProjectId === project.id}
            onSelect={onSelect}
            onArchive={onArchive}
            onDelete={onDelete}
            onRename={onRename}
          />
        );
      })}

      <div className={`archived-panel${showArchived ? " is-open" : ""}`}>
        <button
          type="button"
          className="archived-toggle"
          onClick={() => setShowArchived((open) => !open)}
          aria-expanded={showArchived}
        >
          <Archive size={15} aria-hidden="true" />
          <span>Archived</span>
          <span className="archived-toggle__count">{archivedProjects.length}</span>
          <ChevronDown className="archived-toggle__chevron" size={16} aria-hidden="true" />
        </button>
        {showArchived ? (
          <div className="archived-list">
            {archivedProjects.length === 0 ? (
              <p className="archived-empty">No archived projects.</p>
            ) : (
              archivedProjects.map((project) => <ArchivedRow key={project.id} project={project} onUnarchive={onUnarchive} />)
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
