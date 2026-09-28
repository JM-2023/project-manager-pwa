import { ArchiveRestore, Check, ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { buildSwatchMap } from "../lib/projectColor";
import type { Project, Task } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { isWorklogTask, progressTone, summarizeWorklogOverview, type WorklogOverview } from "../lib/progress";
import { NO_PROJECT_FILTER } from "../state/appStore";
import { useRemoveTransition } from "../lib/useRemoveTransition";
import { usePresence } from "../lib/usePresence";
import { handleMenuKeyDown } from "../lib/menuKeys";
import { boxOf, buildSlideKeyframes, currentBox, place, px, SLIDE_FRAME_MS, type Box } from "../lib/navIndicator";

const EMPTY_WORKLOG_OVERVIEW = summarizeWorklogOverview([]);

// The chips are wide and stacked, so the pill's stretch is capped (long jumps
// would smear it down the list) and its cross-axis squash kept faint.
const SLAB_SLIDE = { maxStretch: 36, crossScale: 0.25 };

const sameBox = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;

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
  /** Tasks a delete would purge per project, archived ones included. */
  taskCounts: ReadonlyMap<string, number>;
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
  taskCount: number;
  swatch: string;
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

function ProjectRow({ project, summary, taskCount, swatch, active, index, onSelect, onArchive, onDelete, onRename }: ProjectRowProps) {
  const { m } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = usePresence(menuOpen, 300);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
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
      if (!menuRef.current?.contains(event.target as Node) && !popoverRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  // Render above the scroll container so the first/last row's menu and its
  // existing entrance/exit animations have room in either direction.
  useLayoutEffect(() => {
    if (!menu.mounted || menu.closing) return;
    const anchor = menuRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    function position() {
      if (!anchor || !popover) return;
      const rect = anchor.getBoundingClientRect();
      const clip = anchor.closest(".project-list-scroll")?.getBoundingClientRect();
      if (clip && (rect.bottom <= clip.top || rect.top >= clip.bottom)) {
        setMenuOpen(false);
        return;
      }
      popover.style.left = `${Math.max(8, Math.min(rect.right - popover.offsetWidth, window.innerWidth - popover.offsetWidth - 8))}px`;
      popover.style.top = `${Math.max(8, Math.min(rect.bottom - popover.offsetHeight, window.innerHeight - popover.offsetHeight - 8))}px`;
      popover.style.visibility = "visible";
    }
    position();
    popover.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [menu.mounted, menu.closing, confirm]);

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
        <span className="project-color" style={{ backgroundColor: swatch }} />
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
        {menu.mounted ? createPortal(
          <div
            ref={popoverRef}
            className={`task-action-menu project-action-menu${menu.closing ? " is-closing" : ""}`}
            role="menu"
            aria-label={m.projectList.optionsFor(project.name)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                event.preventDefault();
                setMenuOpen(false);
                menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
              } else {
                handleMenuKeyDown(event);
              }
            }}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) menu.onExited();
            }}
          >
            {confirm ? (
              <>
                <span className="task-action-menu__prompt" role="presentation">
                  {confirm === "archive" ? m.projectList.archivePrompt : m.projectList.deletePrompt}
                </span>
                {confirm === "delete" ? (
                  <span className="task-action-menu__warning" role="presentation">
                    {m.projectList.deleteWarning(taskCount)}
                  </span>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className={confirm === "delete" ? "danger" : ""}
                  onClick={runConfirm}
                >
                  <span>{confirm === "archive" ? m.projectList.confirmArchive : m.projectList.confirmDelete}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => setConfirm(null)}>
                  <span>{m.common.cancel}</span>
                </button>
              </>
            ) : (
              <>
                {onRename ? (
                  <button type="button" role="menuitem" onClick={startRename}>
                    <span>{m.common.rename}</span>
                  </button>
                ) : null}
                <button type="button" role="menuitem" onClick={() => setConfirm("archive")}>
                  <span>{m.common.archive}</span>
                </button>
                <button type="button" role="menuitem" className="danger" onClick={() => setConfirm("delete")}>
                  <span>{m.common.delete}</span>
                </button>
              </>
            )}
          </div>, document.body
        ) : null}
      </div>
    </div>
  );
}

interface ArchivedRowProps {
  project: Project;
  swatch: string;
  onUnarchive: (project: Project) => void;
}

function ArchivedRow({ project, swatch, onUnarchive }: ArchivedRowProps) {
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
      <span className="project-color" style={{ backgroundColor: swatch }} />
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
  taskCounts,
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const pickerRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollIdleTimer = useRef<number>();
  const panelId = useId();
  const selectedName = !selectedProjectId ? m.common.allProjects : selectedProjectId === NO_PROJECT_FILTER
    ? m.common.noProject : projects.find((project) => project.id === selectedProjectId)?.name ?? m.common.allProjects;

  const showScrollbar = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.classList.add("is-scrolling");
    window.clearTimeout(scrollIdleTimer.current);
    scrollIdleTimer.current = window.setTimeout(() => scroller.classList.remove("is-scrolling"), 1000);
  }, []);
  useEffect(() => () => window.clearTimeout(scrollIdleTimer.current), []);

  // A sticky sidebar starts below the page header, then moves toward its top
  // inset. Recompute the available space so its bottom stays above the Dock
  // throughout page scrolling, resizing and mobile picker expansion.
  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const header = sidebar.parentElement?.querySelector(".page-header");
    let frame = 0;
    function measure() {
      if (!sidebar) return;
      // Use the header's natural position, not the sticky box's constrained
      // position: changing its height must not feed back into its own limit.
      const inset = Number.parseFloat(getComputedStyle(sidebar).top) || 0;
      const top = Math.ceil(Math.max(inset, (header?.getBoundingClientRect().bottom ?? 0) + 32));
      sidebar.style.setProperty("--project-sidebar-top", `${top}px`);
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(sidebar);
    if (header) observer.observe(header);
    window.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    sidebar.parentElement?.addEventListener("animationend", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      sidebar.parentElement?.removeEventListener("animationend", schedule);
    };
  }, []);

  function selectProject(id: string) {
    onSelect(id);
    setPickerOpen(false);
    if (window.matchMedia("(max-width: 719px)").matches) {
      pickerRef.current?.focus({ preventScroll: true });
    }
  }
  // Live and archived share one assignment pass so an archived project never
  // duplicates a live one's dot.
  const swatches = useMemo(() => buildSwatchMap(projects, archivedProjects), [projects, archivedProjects]);
  const { allSummary, noProjectSummary, summariesByProject } = useMemo(() => {
    const worklogTasks: Task[] = [];
    const tasksWithoutProject: Task[] = [];
    const tasksByProject = new Map<string, Task[]>();

    for (const task of tasks) {
      if (!isWorklogTask(task)) continue;
      worklogTasks.push(task);
      if (!task.project_id) {
        tasksWithoutProject.push(task);
        continue;
      }
      const grouped = tasksByProject.get(task.project_id);
      if (grouped) grouped.push(task);
      else tasksByProject.set(task.project_id, [task]);
    }

    return {
      allSummary: summarizeWorklogOverview(worklogTasks),
      noProjectSummary: summarizeWorklogOverview(tasksWithoutProject),
      summariesByProject: new Map(
        [...tasksByProject].map(([projectId, projectTasks]) => [projectId, summarizeWorklogOverview(projectTasks)])
      )
    };
  }, [tasks]);

  // Selection slab: ONE solid accent block laid UNDER the glass chips. The
  // selected chip clears its own glass so the slab reads as that chip's fill;
  // on a change the slab springs to the new chip with the navigation pill's
  // elastic motion (lib/navIndicator), seen blurred through every chip it
  // passes beneath. Layout shifts re-seat it without motion.
  const listRef = useRef<HTMLDivElement | null>(null);
  const slabRef = useRef<HTMLDivElement | null>(null);
  const slideRef = useRef<Animation | null>(null);
  const selectedRef = useRef(selectedProjectId);
  selectedRef.current = selectedProjectId;

  const slabTarget = useCallback(() => {
    const target = listRef.current?.querySelector<HTMLElement>(`[data-chip-id="${CSS.escape(selectedRef.current)}"]`);
    return target && !target.classList.contains("is-removing") ? target : null;
  }, []);

  // Seat without motion. Mid-slide the inline box already holds the target,
  // so a re-render or resize that doesn't move the chip leaves the spring be.
  const seatSlab = useCallback(() => {
    const slab = slabRef.current;
    if (!slab) return;
    const target = slabTarget();
    if (!target) {
      slab.classList.remove("is-shown");
      return;
    }
    const to = boxOf(target);
    // The inline box, not offset*: those report the spring's animated frame.
    const s = slab.style;
    const placed = { x: parseFloat(s.left) || 0, y: parseFloat(s.top) || 0, w: parseFloat(s.width) || 0, h: parseFloat(s.height) || 0 };
    if (!sameBox(placed, to)) {
      slideRef.current?.cancel();
      place(slab, to);
    }
    if (!slab.classList.contains("is-shown")) {
      // Enter with the selected chip's own cascade beat.
      slab.style.setProperty("--chip-i", target.style.getPropertyValue("--chip-i") || "0");
      slab.classList.add("is-shown");
    }
  }, [slabTarget]);

  // Spring to the newly selected chip. Declared before the re-seat effects so
  // it reads the old position before anything could snap the slab over.
  useLayoutEffect(() => {
    const slab = slabRef.current;
    const target = slabTarget();
    if (!slab || !target || !slab.classList.contains("is-shown")) {
      seatSlab();
      return;
    }
    const from = currentBox(slab);
    const to = boxOf(target);
    slideRef.current?.cancel();
    place(slab, to);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (sameBox(from, to) || reduced || typeof slab.animate !== "function") return;
    const frames = buildSlideKeyframes(from, to, SLAB_SLIDE);
    slideRef.current = slab.animate(frames.map(px), { duration: (frames.length - 1) * SLIDE_FRAME_MS, easing: "linear" });
  }, [selectedProjectId, slabTarget, seatSlab]);

  useLayoutEffect(seatSlab, [seatSlab, projects, archivedProjects, tasks]);

  // Rows collapse (delete/archive) and the viewport resizes under the slab;
  // watching the list's own box re-seats it whenever layout shifts.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(seatSlab);
    observer.observe(list);
    return () => observer.disconnect();
  }, [seatSlab]);

  function createProject() {
    const clean = name.trim();
    if (!clean || !onCreate) {
      return;
    }
    onCreate(clean);
    setName("");
  }

  return (
    <section className={`project-sidebar${pickerOpen ? " is-open" : ""}`} ref={sidebarRef} aria-label={m.projectsPage.title}>
      <button
        ref={pickerRef}
        type="button"
        className="project-picker"
        aria-expanded={pickerOpen}
        aria-controls={panelId}
        onClick={() => setPickerOpen((open) => !open)}
      >
        <span>{m.projectList.chooseProject}</span>
        <strong>{selectedName}</strong>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id={panelId} className="project-sidebar__collapse" onKeyDown={(event) => {
        if (event.key === "Escape" && pickerOpen && !event.defaultPrevented) {
          setPickerOpen(false);
          pickerRef.current?.focus({ preventScroll: true });
        }
      }}>
        <div className="project-sidebar__panel">
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
          <div
            ref={scrollRef}
            className="project-list-scroll"
            role="region"
            aria-label={m.projectList.browseProjects}
            tabIndex={0}
            onScroll={showScrollbar}
            onPointerMove={showScrollbar}
            onPointerEnter={showScrollbar}
            onKeyDown={showScrollbar}
          >
            <div className="project-list" ref={listRef}>
              <div ref={slabRef} className="project-active-slab" aria-hidden="true" />
              <button
                type="button"
                className={!selectedProjectId ? "project-row active" : "project-row"}
                data-chip-id=""
                style={{ "--chip-i": 0 } as CSSProperties}
                onClick={() => selectProject("")}
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
                onClick={() => selectProject(NO_PROJECT_FILTER)}
              >
                <span>{m.common.noProject}</span>
                <strong>{noProjectSummary.averageProgress}%</strong>
                <ProgressMeter value={noProjectSummary.averageProgress} />
              </button>
              {projects.map((project, index) => {
                const summary = summariesByProject.get(project.id) ?? EMPTY_WORKLOG_OVERVIEW;
                return (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    summary={summary}
                    taskCount={taskCounts.get(project.id) ?? 0}
                    swatch={swatches.get(project.id) ?? "var(--chip-accent)"}
                    active={selectedProjectId === project.id}
                    index={index + 2}
                    onSelect={selectProject}
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
                      archivedProjects.map((project) => (
                        <ArchivedRow
                          key={project.id}
                          project={project}
                          swatch={swatches.get(project.id) ?? "var(--chip-accent)"}
                          onUnarchive={onUnarchive}
                        />
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
