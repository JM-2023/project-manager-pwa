import type { Filters } from "../state/appStore";
import type { NextIdea, NextProject, Project, Task } from "../lib/types";

export interface TaskPageProps {
  projects: Project[];
  archivedProjects: Project[];
  tasks: Task[];
  nextProjects: NextProject[];
  nextIdeas: NextIdea[];
  filters: Filters;
  onFiltersChange: (filters: Partial<Filters>) => void;
  onCreateTask: (input: Partial<Task> & { title: string }) => string;
  onUpdateTask: (task: Task, changes: Partial<Task>) => void;
  /** Removes the task from view at once; the delete lands when its undo lapses. */
  onDeleteTask: (task: Task) => void;
  /** Moves tasks to another day and offers to move them back. */
  onMoveTasks: (tasks: Task[], date: string) => void;
  onCreateProject: (name: string) => string;
  onArchiveProject: (project: Project) => void;
  onUnarchiveProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onRenameProject: (project: Project, name: string) => void;
  onCreateNextProject: (name: string) => string;
  onUpdateNextProject: (project: NextProject, changes: Partial<NextProject>) => void;
  onDeleteNextProject: (project: NextProject) => void;
  onCreateNextIdea: (input: Partial<NextIdea> & { next_project_id: string; title: string }) => void;
  onUpdateNextIdea: (idea: NextIdea, changes: Partial<NextIdea>) => void;
  onDeleteNextIdea: (idea: NextIdea) => void;
}
