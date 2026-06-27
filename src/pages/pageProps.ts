import type { Filters } from "../state/appStore";
import type { Project, Tag, Task, TaskTag } from "../lib/types";

export interface TaskPageProps {
  projects: Project[];
  tasks: Task[];
  tags: Tag[];
  taskTags: TaskTag[];
  filters: Filters;
  onFiltersChange: (filters: Partial<Filters>) => void;
  onCreateTask: (input: Partial<Task> & { title: string }) => void;
  onUpdateTask: (task: Task, changes: Partial<Task>) => void;
  onArchiveTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onAddTag: (task: Task, tagName: string) => void;
  onCreateProject: (name: string) => string;
  onArchiveProject: (project: Project) => void;
  onRenameProject: (project: Project, name: string) => void;
}
