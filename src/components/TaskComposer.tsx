import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project, TaskPriority, TaskStatus } from "../lib/types";
import { importancePriority, type TaskImportance } from "../lib/progress";

interface TaskComposerProps {
  projects: Project[];
  defaultProjectId?: string;
  defaultStatus?: TaskStatus;
  defaultStartDate?: string | null;
  showDateInput?: boolean;
  onCreateProject?: (name: string) => string | void;
  onCreate: (input: {
    title: string;
    project_id: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    due_date: string | null;
    start_date: string | null;
    next_action: string | null;
    extra_json?: string | null;
  }) => void;
}

export function TaskComposer({
  projects,
  defaultProjectId = "",
  defaultStatus = "todo",
  defaultStartDate = null,
  showDateInput = true,
  onCreateProject,
  onCreate
}: TaskComposerProps) {
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [importance, setImportance] = useState<TaskImportance>(2);
  const [startDate, setStartDate] = useState(defaultStartDate ?? "");
  const [newProjectName, setNewProjectName] = useState("");

  useEffect(() => {
    setProjectId(defaultProjectId);
  }, [defaultProjectId]);

  useEffect(() => {
    if (defaultStartDate) {
      setStartDate(defaultStartDate);
    }
  }, [defaultStartDate]);

  function createTask() {
    const clean = title.trim();
    if (!clean) {
      return;
    }
    onCreate({
      title: clean,
      project_id: projectId || null,
      status: defaultStatus,
      priority: importancePriority(importance),
      due_date: null,
      start_date: defaultStartDate || startDate || null,
      next_action: null,
      extra_json: JSON.stringify({ importance, progress_percent: 0 })
    });
    setTitle("");
  }

  function createProject() {
    const clean = newProjectName.trim();
    if (!clean || !onCreateProject) {
      return;
    }
    const createdId = onCreateProject(clean);
    if (typeof createdId === "string") {
      setProjectId(createdId);
    }
    setNewProjectName("");
  }

  return (
    <section className="task-composer">
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="New task" aria-label="New task title" />
      <div className="composer-row">
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label="Project">
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select value={importance} onChange={(event) => setImportance(Number(event.target.value) as TaskImportance)} aria-label="Importance">
          <option value={1}>1 core</option>
          <option value={2}>2 maintain</option>
          <option value={3}>3 optional</option>
          <option value={4}>4 defer</option>
        </select>
        {showDateInput ? <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="Task date" /> : null}
        <button type="button" onClick={createTask} aria-label="Create task">
          <Plus size={18} aria-hidden="true" />
        </button>
      </div>
      {onCreateProject ? (
        <div className="composer-project-row">
          <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="New project" aria-label="New project name" />
          <button type="button" onClick={createProject} aria-label="Create project">
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
