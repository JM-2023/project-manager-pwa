import { Check, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type TextareaHTMLAttributes } from "react";
import { RollDigits } from "../components/RollDigits";
import { useSpringDisclosure } from "../lib/disclosure";
import { useI18n } from "../lib/i18n";
import { useListMotion, type ListMotionOptions } from "../lib/listMotion";
import type { NextIdea, NextProject } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

const EMPTY_IDEAS: NextIdea[] = [];
// Groups and ideas arrive by growing open, the mirror of how they fold out,
// so the groups under an open one glide down as it grows instead of jumping.
const UNFOLD: ListMotionOptions = { enter: "unfold" };
const ideaKey = (idea: NextIdea) => idea.id;
const groupKey = (project: NextProject) => project.id;

// Which groups this device last left open. A per-device convenience: the
// page remounts on every tab switch and would otherwise open all shut.
const OPEN_GROUPS_KEY = "project-manager-next-open";

function readOpenGroups(): Set<string> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveOpenGroups(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable: the groups simply open shut next time.
  }
}

// Adopt synced text before rendering the field, while preserving a local edit.
// Keeping its base alongside the draft prevents an untouched field from
// writing an older value back when it blurs after a sync.
function useSyncedText(source: string) {
  const [draft, setDraft] = useState({ base: source, text: source });
  if (draft.base !== source) {
    setDraft({ base: source, text: draft.text === draft.base ? source : draft.text });
  }
  return [draft.text, (text: string) => setDraft({ base: source, text })] as const;
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

  // Refit when the field's width changes (a resize, the page settling).
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let width = -1;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      element.style.height = "0px";
      element.style.height = `${element.scrollHeight}px`;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <textarea {...props} ref={ref} />;
}

function NextIdeaItem({
  idea,
  exiting,
  onUpdate,
  onDelete
}: {
  idea: NextIdea;
  // The idea is gone from the data and the row is folding out: inert, and
  // the blur that inert causes must not write the snapshot back.
  exiting: boolean;
  onUpdate: (idea: NextIdea, changes: Partial<NextIdea>) => void;
  onDelete: (idea: NextIdea) => void;
}) {
  const { m } = useI18n();
  const [title, setTitle] = useSyncedText(idea.title);
  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;

  function commit() {
    if (exitingRef.current) return;
    const cleanTitle = title.trim();
    setTitle(cleanTitle);
    if (cleanTitle !== idea.title) {
      onUpdate(idea, { title: cleanTitle });
    }
  }

  return (
    <article className={`cache-item${exiting ? " is-exiting" : ""}`} data-idea-id={idea.id} data-motion-key={idea.id}>
      <AutoTextarea value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commit} rows={1} aria-label={m.next.ideaAria} />
      <button type="button" className="icon-button danger" onClick={() => onDelete(idea)} aria-label={m.next.deleteIdea} title={m.common.delete}>
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </article>
  );
}

/** A group's ideas: added ones grow in at the end, deleted ones fold out,
 * and a sync that reorders them glides each to its new place. */
function IdeaList({
  ideas,
  onUpdate,
  onDelete
}: {
  ideas: NextIdea[];
  onUpdate: (idea: NextIdea, changes: Partial<NextIdea>) => void;
  onDelete: (idea: NextIdea) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const present = useMemo(() => new Set(ideas.map(ideaKey)), [ideas]);
  const rows = useListMotion(ideas, ideaKey, listRef, present, UNFOLD);

  return (
    <div ref={listRef} className="cache-items">
      {rows.map(({ key, item, exiting }) => (
        <NextIdeaItem key={key} idea={item} exiting={exiting} onUpdate={onUpdate} onDelete={onDelete} />
      ))}
    </div>
  );
}

function NextProjectSection({
  project,
  ideas,
  open,
  exiting,
  onToggle,
  onCreateIdea,
  onUpdateIdea,
  onDeleteIdea,
  onUpdateProject,
  onDeleteProject
}: {
  project: NextProject;
  ideas: NextIdea[];
  open: boolean;
  // The group is gone from the data and folding out (see NextIdeaItem).
  exiting: boolean;
  onToggle: (project: NextProject) => void;
  onCreateIdea: (project: NextProject, title: string) => void;
  onUpdateIdea: (idea: NextIdea, changes: Partial<NextIdea>) => void;
  onDeleteIdea: (idea: NextIdea) => void;
  onUpdateProject: (project: NextProject, changes: Partial<NextProject>) => void;
  onDeleteProject: (project: NextProject) => void;
}) {
  const { m } = useI18n();
  const nameId = useId();
  const bodyId = useId();
  const [title, setTitle] = useState("");
  const [name, setName] = useSyncedText(project.name);
  const [confirming, setConfirming] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Opens and closes on one spring, like a task card: the body's height,
  // the page's scroll, and the chevron and fields (CSS, from --disclose).
  const body = useSpringDisclosure(open, { block: sectionRef, panel: bodyRef });
  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;
  // A folding group keeps showing the ideas it had: the data dropped them
  // along with it, and they shouldn't fold out a second time inside it.
  const shownIdeasRef = useRef(ideas);
  if (!exiting) shownIdeasRef.current = ideas;
  const shownIdeas = shownIdeasRef.current;

  // A pending delete confirmation doesn't outlive the group closing.
  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  // A press mounts the body shut, so the tap only has to start the motion.
  function warmBody(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.isPrimary && event.button === 0) body.warm();
  }

  function createIdea() {
    const clean = title.trim();
    if (!clean) return;
    onCreateIdea(project, clean);
    setTitle("");
  }

  function renameProject() {
    if (exitingRef.current) return;
    const clean = name.trim();
    if (clean && clean !== project.name) {
      setName(clean);
      onUpdateProject(project, { name: clean });
    } else {
      setName(project.name);
    }
  }

  return (
    <section
      ref={sectionRef}
      className={`cache-section${open ? " is-open" : ""}${exiting ? " is-exiting" : ""}`}
      data-motion-key={project.id}
      aria-labelledby={nameId}
    >
      <div className="cache-section__head">
        <button
          type="button"
          className="cache-section__toggle"
          aria-expanded={open}
          aria-controls={body.mounted ? bodyId : undefined}
          onPointerDown={warmBody}
          onPointerCancel={body.cool}
          onClick={() => onToggle(project)}
        >
          <ChevronRight className="cache-chevron" size={18} aria-hidden="true" />
          <span className="cache-section__name" id={nameId}>
            {project.name}
          </span>
          <span className="cache-count">
            <RollDigits value={shownIdeas.length} text={String(shownIdeas.length)} />
          </span>
        </button>
        {confirming ? (
          <span className="cache-confirm" role="group" aria-label={m.next.confirmDeleteGroup}>
            <button
              type="button"
              className="icon-button danger"
              onClick={() => onDeleteProject(project)}
              aria-label={m.next.confirmDeleteFor(project.name)}
              title={m.common.confirm}
            >
              <Check size={16} aria-hidden="true" />
            </button>
            <button type="button" className="icon-button" onClick={() => setConfirming(false)} aria-label={m.common.cancel} title={m.common.cancel}>
              <X size={16} aria-hidden="true" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="icon-button cache-section__remove"
            onClick={() => setConfirming(true)}
            aria-label={m.next.deleteFor(project.name)}
            title={m.next.deleteGroupTitle}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {body.mounted ? (
        <div ref={bodyRef} id={bodyId} className="cache-section__body">
          <div className="cache-section__inner">
            <div className="cache-section__fields">
              <label className="cache-rename">
                <span>{m.next.projectLabel}</span>
                <input value={name} onChange={(event) => setName(event.target.value)} onBlur={renameProject} aria-label={m.next.renameAria(project.name)} />
              </label>
              <div className="cache-add">
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      createIdea();
                    }
                  }}
                  placeholder={m.next.addIdea}
                  aria-label={m.next.addIdeaFor(project.name)}
                />
                <button type="button" onClick={createIdea} aria-label={m.next.addIdeaAction(project.name)}>
                  <Plus size={18} aria-hidden="true" />
                </button>
              </div>
              <IdeaList ideas={shownIdeas} onUpdate={onUpdateIdea} onDelete={onDeleteIdea} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function NextPage(props: TaskPageProps & { initialIdeaId?: string | null }) {
  const { m } = useI18n();
  const { nextProjects, nextIdeas, onCreateNextProject, onUpdateNextProject, onDeleteNextProject, onCreateNextIdea, onUpdateNextIdea, onDeleteNextIdea } = props;
  const [projectName, setProjectName] = useState("");
  const boardRef = useRef<HTMLElement | null>(null);
  // Open as this device left them, plus the group of an idea a search
  // result jumped to.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => {
    const ids = readOpenGroups();
    const target = props.initialIdeaId ? nextIdeas.find((idea) => idea.id === props.initialIdeaId) : undefined;
    if (target) ids.add(target.next_project_id);
    return ids;
  });
  const presentGroups = useMemo(() => new Set(nextProjects.map(groupKey)), [nextProjects]);
  const groups = useListMotion(nextProjects, groupKey, boardRef, presentGroups, UNFOLD);

  useLayoutEffect(() => {
    const id = props.initialIdeaId;
    if (!id) return;
    const frame = requestAnimationFrame(() => {
      const item = boardRef.current?.querySelector<HTMLElement>(`[data-idea-id="${CSS.escape(id)}"]`);
      if (!item) return;
      item.querySelector("textarea")?.focus({ preventScroll: true });
      item.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.initialIdeaId]);

  const { ideaCount, ideasByProject } = useMemo(() => {
    const grouped = new Map<string, NextIdea[]>();
    let count = 0;
    for (const idea of nextIdeas) {
      if (idea.deleted_at) continue;
      count += 1;
      const projectIdeas = grouped.get(idea.next_project_id);
      if (projectIdeas) projectIdeas.push(idea);
      else grouped.set(idea.next_project_id, [idea]);
    }
    for (const projectIdeas of grouped.values()) {
      projectIdeas.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.title.localeCompare(b.title));
    }
    return { ideaCount: count, ideasByProject: grouped };
  }, [nextIdeas]);

  // Remembered ids of groups that no longer exist are dropped on each write.
  function setGroupOpen(id: string, open: boolean) {
    const next = new Set([...openGroups].filter((key) => presentGroups.has(key)));
    if (open) next.add(id);
    else next.delete(id);
    setOpenGroups(next);
    saveOpenGroups(next);
  }

  // A new group opens straight away: adding ideas is the next thing to do.
  function createProject() {
    const id = onCreateNextProject(projectName);
    setProjectName("");
    setGroupOpen(id, true);
  }

  function createIdea(project: NextProject, title: string) {
    onCreateNextIdea({
      next_project_id: project.id,
      title,
      note: null,
      sort_order: Date.now(),
      extra_json: null
    });
  }

  return (
    <main className="page-content cache-page">
      <header className="page-header">
        <h1>{m.next.title}</h1>
        <p>{m.next.subtitle(ideaCount)}</p>
      </header>
      <section className="cache-add cache-project-add" aria-label={m.next.createProject}>
        <input
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              createProject();
            }
          }}
          placeholder={m.next.newProject}
          aria-label={m.next.newProject}
        />
        <button type="button" onClick={createProject} aria-label={m.next.createProject}>
          <Plus size={18} aria-hidden="true" />
        </button>
      </section>
      <section ref={boardRef} className="cache-board" aria-label={m.next.boardAria}>
        {groups.map(({ key, item: project, exiting }) => (
          <NextProjectSection
            key={key}
            project={project}
            ideas={ideasByProject.get(project.id) ?? EMPTY_IDEAS}
            open={openGroups.has(project.id)}
            exiting={exiting}
            onToggle={(group) => setGroupOpen(group.id, !openGroups.has(group.id))}
            onCreateIdea={createIdea}
            onUpdateIdea={onUpdateNextIdea}
            onDeleteIdea={onDeleteNextIdea}
            onUpdateProject={onUpdateNextProject}
            onDeleteProject={onDeleteNextProject}
          />
        ))}
      </section>
      {nextProjects.length === 0 ? <p className="empty-state">{m.next.noProjects}</p> : null}
    </main>
  );
}
