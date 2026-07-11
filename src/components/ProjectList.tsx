import { Archive, ArchiveRestore, Check, ChevronDown, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Project, Task } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { isWorklogTask, progressTone, summarizeWorklogOverview, type WorklogOverview } from "../lib/progress";
import { NO_PROJECT_FILTER } from "../state/appStore";
import { useRemoveTransition } from "../lib/useRemoveTransition";
import { usePresence } from "../lib/usePresence";

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
  /** Position in the chip stack, for the entrance cascade. */
  index: number;
  onSelect: (projectId: string) => void;
  onArchive: (project: Project) => void;
  onDelete: (project: Project) => void;
  onRename?: (project: Project, name: string) => void;
}

// Two-step confirmation kept inside the popover: the first item click swaps the
// menu over to a confirm/cancel pair so destructive actions never fire on a
// single tap.
type ConfirmAction = "archive" | "delete";

function ProjectRow({ project, summary, active, index, onSelect, onArchive, onDelete, onRename }: ProjectRowProps) {
  const { m } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = usePresence(menuOpen, 300);
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

  const chipStyle = { "--chip-i": index } as CSSProperties;

  if (editing) {
    return (
      <div className="project-row editing" data-chip-id={project.id} style={chipStyle}>
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
          aria-label={m.projectList.renameAria(project.name)}
        />
        <button type="button" className="icon-button" onMouseDown={(event) => event.preventDefault()} onClick={commit} aria-label={m.projectList.saveName}>
          <Check size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className={`project-row${active ? " active" : ""}${removing ? " is-removing" : ""}`}
      data-chip-id={project.id}
      style={chipStyle}
      onTransitionEnd={onTransitionEnd}
    >
      <button type="button" onClick={() => onSelect(project.id)}>
        <span className="project-color" style={{ backgroundColor: project.color ?? "var(--chip-accent)" }} />
        <span>{project.name}</span>
        <strong>{summary.averageProgress}%</strong>
        <ProgressMeter value={summary.averageProgress} />
      </button>
      <div className={`task-menu${menuOpen ? " is-open" : ""}`} ref={menuRef}>
        <button
          type="button"
          className="icon-button task-menu-trigger"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={m.projectList.optionsFor(project.name)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={m.projectList.options}
        >
          <MoreHorizontal size={17} aria-hidden="true" />
        </button>
        {menu.mounted ? (
          <div
            className={`task-action-menu${menu.closing ? " is-closing" : ""}`}
            role="menu"
            aria-label={m.projectList.optionsFor(project.name)}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) menu.onExited();
            }}
          >
            {confirm ? (
              <>
                <span className="task-action-menu__prompt" role="presentation">
                  {confirm === "archive" ? m.projectList.archivePrompt : m.projectList.deletePrompt}
                </span>
                <button
                  type="button"
                  role="menuitem"
                  className={confirm === "delete" ? "danger" : ""}
                  onClick={runConfirm}
                >
                  {confirm === "archive" ? <Archive size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                  <span>{confirm === "archive" ? m.projectList.confirmArchive : m.projectList.confirmDelete}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => setConfirm(null)}>
                  <X size={15} aria-hidden="true" />
                  <span>{m.common.cancel}</span>
                </button>
              </>
            ) : (
              <>
                {onRename ? (
                  <button type="button" role="menuitem" onClick={startRename}>
                    <Pencil size={15} aria-hidden="true" />
                    <span>{m.common.rename}</span>
                  </button>
                ) : null}
                <button type="button" role="menuitem" onClick={() => setConfirm("archive")}>
                  <Archive size={15} aria-hidden="true" />
                  <span>{m.common.archive}</span>
                </button>
                <span className="task-action-menu__sep" role="separator" />
                <button type="button" role="menuitem" className="danger" onClick={() => setConfirm("delete")}>
                  <Trash2 size={15} aria-hidden="true" />
                  <span>{m.common.delete}</span>
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
  const { m } = useI18n();
  const { ref: rowRef, removing, begin: beginRemove, onTransitionEnd } = useRemoveTransition<HTMLDivElement>(
    () => onUnarchive(project)
  );
  return (
    <div
      ref={rowRef}
      className={`archived-row${removing ? " is-removing" : ""}`}
      onTransitionEnd={onTransitionEnd}
    >
      <span className="project-color" style={{ backgroundColor: project.color ?? "var(--chip-accent)" }} />
      <span className="archived-row__name">{project.name}</span>
      <button
        type="button"
        className="icon-button"
        onClick={() => beginRemove()}
        aria-label={m.projectList.restore(project.name)}
        title={m.projectList.restoreTitle}
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
  const { m } = useI18n();
  const [name, setName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const allSummary = summarizeWorklogOverview(tasks);
  const noProjectSummary = summarizeWorklogOverview(tasks.filter((task) => !task.project_id));

  // Selection ring: ONE absolutely-positioned element that glides from the
  // previously active chip to the newly selected one on a spring, instead of
  // each chip flashing its own border on/off. First placement lands without
  // a transition so the ring doesn't fly in from the top on mount.
  const listRef = useRef<HTMLElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const ringArmedRef = useRef(false);

  const positionRing = useCallback(() => {
    const list = listRef.current;
    const ring = ringRef.current;
    if (!list || !ring) return;
    const target = list.querySelector<HTMLElement>(`[data-chip-id="${CSS.escape(selectedProjectId)}"]`);
    if (!target || target.classList.contains("is-removing")) {
      ring.style.opacity = "0";
      return;
    }
    ring.style.opacity = "1";
    // Frame the chip's border box exactly: offsetLeft/offsetWidth matter on
    // desktop, where the scrolling list adds an 8px padding inset that a
    // left/right-stretched ring would overhang. Width applies instantly
    // (it only changes with the viewport); the glide lives on transform.
    ring.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop}px)`;
    ring.style.width = `${target.offsetWidth}px`;
    ring.style.height = `${target.offsetHeight}px`;
    if (!ringArmedRef.current) {
      ring.style.transition = "none";
      void ring.offsetHeight;
      ring.style.transition = "";
      ringArmedRef.current = true;
    }
  }, [selectedProjectId]);

  useLayoutEffect(positionRing, [positionRing, projects, archivedProjects, tasks]);

  // Rows collapse (delete/archive) and the viewport resizes under the ring;
  // watching the list's own box re-seats it whenever layout shifts.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => positionRing());
    observer.observe(list);
    return () => observer.disconnect();
  }, [positionRing]);

  function createProject() {
    const clean = name.trim();
    if (!clean || !onCreate) {
      return;
    }
    onCreate(clean);
    setName("");
  }

  return (
    <section className="project-list" ref={listRef}>
      <div ref={ringRef} className="project-active-ring" aria-hidden="true" />
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
            placeholder={m.composer.newProject}
            aria-label={m.composer.newProjectAria}
          />
          <button type="button" onClick={createProject} aria-label={m.composer.createProject}>
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className={!selectedProjectId ? "project-row active" : "project-row"}
        data-chip-id=""
        style={{ "--chip-i": 0 } as CSSProperties}
        onClick={() => onSelect("")}
      >
        <span>{m.common.allProjects}</span>
        <strong>{allSummary.averageProgress}%</strong>
        <ProgressMeter value={allSummary.averageProgress} />
      </button>
      <button
        type="button"
        className={selectedProjectId === NO_PROJECT_FILTER ? "project-row active" : "project-row"}
        data-chip-id={NO_PROJECT_FILTER}
        style={{ "--chip-i": 1 } as CSSProperties}
        onClick={() => onSelect(NO_PROJECT_FILTER)}
      >
        <span>{m.common.noProject}</span>
        <strong>{noProjectSummary.averageProgress}%</strong>
        <ProgressMeter value={noProjectSummary.averageProgress} />
      </button>
      {projects.map((project, index) => {
        const projectTasks = tasks.filter((task) => task.project_id === project.id && isWorklogTask(task));
        const summary = summarizeWorklogOverview(projectTasks);
        return (
          <ProjectRow
            key={project.id}
            project={project}
            summary={summary}
            active={selectedProjectId === project.id}
            index={index + 2}
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
          <span>{m.projectList.archived}</span>
          <span className="archived-toggle__count">{archivedProjects.length}</span>
          <ChevronDown className="archived-toggle__chevron" size={16} aria-hidden="true" />
        </button>
        {/* Always mounted: the wrapper's grid-row tweens 0fr -> 1fr so the
            panel unfolds/refolds instead of popping; visibility gates focus. */}
        <div className="archived-collapse">
          <div className="archived-list" aria-hidden={!showArchived}>
            {archivedProjects.length === 0 ? (
              <p className="archived-empty">{m.projectList.noArchived}</p>
            ) : (
              archivedProjects.map((project) => <ArchivedRow key={project.id} project={project} onUnarchive={onUnarchive} />)
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
