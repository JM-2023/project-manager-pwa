import { Check, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type TextareaHTMLAttributes } from "react";
import { useI18n } from "../lib/i18n";
import type { NextIdea, NextProject } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

const EMPTY_IDEAS: NextIdea[] = [];

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

function NextIdeaItem({
  idea,
  onUpdate,
  onDelete
}: {
  idea: NextIdea;
  onUpdate: (idea: NextIdea, changes: Partial<NextIdea>) => void;
  onDelete: (idea: NextIdea) => void;
}) {
  const { m } = useI18n();
  const [title, setTitle] = useState(idea.title);

  function commit() {
    const cleanTitle = title.trim();
    if (cleanTitle !== idea.title) {
      onUpdate(idea, { title: cleanTitle });
    }
  }

  return (
    <article className="cache-item">
      <AutoTextarea value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commit} rows={1} aria-label={m.next.ideaAria} />
      <button type="button" className="icon-button danger" onClick={() => onDelete(idea)} aria-label={m.next.deleteIdea} title={m.common.delete}>
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </article>
  );
}

function NextProjectSection({
  project,
  ideas,
  onCreateIdea,
  onUpdateIdea,
  onDeleteIdea,
  onUpdateProject,
  onDeleteProject
}: {
  project: NextProject;
  ideas: NextIdea[];
  onCreateIdea: (project: NextProject, title: string) => void;
  onUpdateIdea: (idea: NextIdea, changes: Partial<NextIdea>) => void;
  onDeleteIdea: (idea: NextIdea) => void;
  onUpdateProject: (project: NextProject, changes: Partial<NextProject>) => void;
  onDeleteProject: (project: NextProject) => void;
}) {
  const { m } = useI18n();
  const [title, setTitle] = useState("");
  const [name, setName] = useState(project.name);
  const [confirming, setConfirming] = useState(false);

  function createIdea() {
    const clean = title.trim();
    if (!clean) return;
    onCreateIdea(project, clean);
    setTitle("");
  }

  function renameProject() {
    const clean = name.trim();
    if (clean && clean !== project.name) {
      onUpdateProject(project, { name: clean });
    } else {
      setName(project.name);
    }
  }

  function stop(event: { preventDefault: () => void; stopPropagation: () => void }) {
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <details className="cache-section">
      <summary className="cache-section__head">
        <ChevronRight className="cache-chevron" size={18} aria-hidden="true" />
        <span className="cache-section__name">{project.name}</span>
        <span className="cache-count">{ideas.length}</span>
        {confirming ? (
          <span className="cache-confirm" role="group" aria-label={m.next.confirmDeleteGroup}>
            <button
              type="button"
              className="icon-button danger"
              onClick={(event) => {
                stop(event);
                onDeleteProject(project);
              }}
              aria-label={m.next.confirmDeleteFor(project.name)}
              title={m.common.confirm}
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
              aria-label={m.common.cancel}
              title={m.common.cancel}
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
            aria-label={m.next.deleteFor(project.name)}
            title={m.next.deleteGroupTitle}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </summary>
      <div className="cache-section__body">
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
        <div className="cache-items">
          {ideas.map((idea) => (
            <NextIdeaItem key={idea.id} idea={idea} onUpdate={onUpdateIdea} onDelete={onDeleteIdea} />
          ))}
          {ideas.length === 0 ? <p className="empty-state">{m.next.noIdeas}</p> : null}
        </div>
      </div>
    </details>
  );
}

export function NextPage(props: TaskPageProps) {
  const { m } = useI18n();
  const { nextProjects, nextIdeas, onCreateNextProject, onUpdateNextProject, onDeleteNextProject, onCreateNextIdea, onUpdateNextIdea, onDeleteNextIdea } = props;
  const [projectName, setProjectName] = useState("");
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

  function createProject() {
    onCreateNextProject(projectName);
    setProjectName("");
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
      <section className="cache-board" aria-label={m.next.boardAria}>
        {nextProjects.map((project) => (
          <NextProjectSection
            key={project.id}
            project={project}
            ideas={ideasByProject.get(project.id) ?? EMPTY_IDEAS}
            onCreateIdea={createIdea}
            onUpdateIdea={onUpdateNextIdea}
            onDeleteIdea={onDeleteNextIdea}
            onUpdateProject={onUpdateNextProject}
            onDeleteProject={onDeleteNextProject}
          />
        ))}
        {nextProjects.length === 0 ? <p className="empty-state">{m.next.noProjects}</p> : null}
      </section>
    </main>
  );
}
