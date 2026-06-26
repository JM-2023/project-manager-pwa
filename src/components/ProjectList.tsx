import { Archive, Plus } from "lucide-react";
import { useState } from "react";
import type { Project, Task } from "../lib/types";
import { isWorklogTask, summarizeWorklogOverview } from "../lib/progress";

interface ProjectListProps {
  projects: Project[];
  tasks: Task[];
  selectedProjectId: string;
  onSelect: (projectId: string) => void;
  onCreate?: (name: string) => void;
  onArchive: (project: Project) => void;
}

export function ProjectList({ projects, tasks, selectedProjectId, onSelect, onCreate, onArchive }: ProjectListProps) {
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
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="New project" aria-label="New project name" />
          <button type="button" onClick={createProject} aria-label="Create project">
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <button type="button" className={!selectedProjectId ? "project-row active" : "project-row"} onClick={() => onSelect("")}>
        <span>All projects</span>
        <strong>{allSummary.averageProgress}%</strong>
      </button>
      {projects.map((project) => {
        const projectTasks = tasks.filter((task) => task.project_id === project.id && isWorklogTask(task));
        const summary = summarizeWorklogOverview(projectTasks);
        return (
          <div key={project.id} className={selectedProjectId === project.id ? "project-row active" : "project-row"}>
            <button type="button" onClick={() => onSelect(project.id)}>
              <span className="project-color" style={{ backgroundColor: project.color ?? "#1f6f68" }} />
              <span>{project.name}</span>
              <strong>{summary.averageProgress}%</strong>
            </button>
            <button type="button" className="icon-button" onClick={() => onArchive(project)} aria-label={`Archive ${project.name}`}>
              <Archive size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
