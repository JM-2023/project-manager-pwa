import { Archive, Check, Pencil, Plus } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { Project, Task } from "../lib/types";
import { isWorklogTask, progressTone, summarizeWorklogOverview, type WorklogOverview } from "../lib/progress";

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
  tasks: Task[];
  selectedProjectId: string;
  onSelect: (projectId: string) => void;
  onCreate?: (name: string) => void;
  onArchive: (project: Project) => void;
  onRename?: (project: Project, name: string) => void;
}

interface ProjectRowProps {
  project: Project;
  summary: WorklogOverview;
  active: boolean;
  onSelect: (projectId: string) => void;
  onArchive: (project: Project) => void;
  onRename?: (project: Project, name: string) => void;
}

function ProjectRow({ project, summary, active, onSelect, onArchive, onRename }: ProjectRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);

  useEffect(() => {
    setDraft(project.name);
  }, [project.name]);

  function commit() {
    const clean = draft.trim();
    if (clean && clean !== project.name && onRename) {
      onRename(project, clean);
    }
    setEditing(false);
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
    <div className={active ? "project-row active" : "project-row"}>
      <button type="button" onClick={() => onSelect(project.id)}>
        <span className="project-color" style={{ backgroundColor: project.color ?? "var(--primary)" }} />
        <span>{project.name}</span>
        <strong>{summary.averageProgress}%</strong>
      </button>
      {onRename ? (
        <button type="button" className="icon-button" onClick={() => { setDraft(project.name); setEditing(true); }} aria-label={`Rename ${project.name}`} title="Rename">
          <Pencil size={15} aria-hidden="true" />
        </button>
      ) : null}
      <button type="button" className="icon-button" onClick={() => onArchive(project)} aria-label={`Archive ${project.name}`} title="Archive">
        <Archive size={16} aria-hidden="true" />
      </button>
      <ProgressMeter value={summary.averageProgress} />
    </div>
  );
}

export function ProjectList({ projects, tasks, selectedProjectId, onSelect, onCreate, onArchive, onRename }: ProjectListProps) {
  const [name, setName] = useState("");
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
            onRename={onRename}
          />
        );
      })}
    </section>
  );
}
