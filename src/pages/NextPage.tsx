import { Check, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type TextareaHTMLAttributes } from "react";
import type { NextIdea, NextProject } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

function projectIdeas(ideas: NextIdea[], project: NextProject): NextIdea[] {
  return ideas
    .filter((idea) => !idea.deleted_at && idea.next_project_id === project.id)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.title.localeCompare(b.title));
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

function NextIdeaItem({
  idea,
  onUpdate,
  onDelete
}: {
  idea: NextIdea;
  onUpdate: (idea: NextIdea, changes: Partial<NextIdea>) => void;
  onDelete: (idea: NextIdea) => void;
}) {
  const [title, setTitle] = useState(idea.title);

  function commit() {
    const cleanTitle = title.trim();
    if (cleanTitle !== idea.title) {
      onUpdate(idea, { title: cleanTitle });
    }
  }

  return (
    <article className="cache-item">
      <AutoTextarea value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commit} rows={1} aria-label="Next idea" />
      <button type="button" className="icon-button danger" onClick={() => onDelete(idea)} aria-label="Delete next idea" title="Delete">
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
          <span className="cache-confirm" role="group" aria-label="Confirm delete Next project">
            <button
              type="button"
              className="icon-button danger"
              onClick={(event) => {
                stop(event);
                onDeleteProject(project);
              }}
              aria-label={`Confirm delete ${project.name}`}
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
            aria-label={`Delete ${project.name}`}
            title="Delete Next project"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </summary>
      <div className="cache-section__body">
        <label className="cache-rename">
          <span>Project</span>
          <input value={name} onChange={(event) => setName(event.target.value)} onBlur={renameProject} aria-label={`Rename ${project.name}`} />
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
            placeholder="Add an idea"
            aria-label={`New idea for ${project.name}`}
          />
          <button type="button" onClick={createIdea} aria-label={`Add idea for ${project.name}`}>
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="cache-items">
          {ideas.map((idea) => (
            <NextIdeaItem key={idea.id} idea={idea} onUpdate={onUpdateIdea} onDelete={onDeleteIdea} />
          ))}
          {ideas.length === 0 ? <p className="empty-state">No saved ideas yet.</p> : null}
        </div>
      </div>
    </details>
  );
}

export function NextPage(props: TaskPageProps) {
  const { nextProjects, nextIdeas, onCreateNextProject, onUpdateNextProject, onDeleteNextProject, onCreateNextIdea, onUpdateNextIdea, onDeleteNextIdea } = props;
  const [projectName, setProjectName] = useState("");
  const ideaCount = useMemo(() => nextIdeas.filter((idea) => !idea.deleted_at).length, [nextIdeas]);

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
        <h1>Next</h1>
        <p>{ideaCount} saved ideas and future tasks</p>
      </header>
      <section className="cache-add cache-project-add" aria-label="Create Next project">
        <input
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              createProject();
            }
          }}
          placeholder="New Next project"
          aria-label="New Next project"
        />
        <button type="button" onClick={createProject} aria-label="Create Next project">
          <Plus size={18} aria-hidden="true" />
        </button>
      </section>
      <section className="cache-board" aria-label="Next idea board">
        {nextProjects.map((project) => (
          <NextProjectSection
            key={project.id}
            project={project}
            ideas={projectIdeas(nextIdeas, project)}
            onCreateIdea={createIdea}
            onUpdateIdea={onUpdateNextIdea}
            onDeleteIdea={onDeleteNextIdea}
            onUpdateProject={onUpdateNextProject}
            onDeleteProject={onDeleteNextProject}
          />
        ))}
        {nextProjects.length === 0 ? <p className="empty-state">No Next projects yet. Create one above to save future ideas.</p> : null}
      </section>
    </main>
  );
}
