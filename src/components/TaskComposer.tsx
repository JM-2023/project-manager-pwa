import { Plus } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../lib/i18n";
import type { TaskImportance } from "../lib/progress";

const NEXT_IMPORTANCE: Record<TaskImportance, TaskImportance> = { 1: 2, 2: 3, 3: 4, 4: 1 };

interface TaskComposerProps {
  onCreate: (title: string, importance: TaskImportance) => void;
}

/**
 * The day's add row. A task exists only once it has a title, so walking
 * away leaves nothing behind. Return adds the task and clears the field
 * for the next one; leaving the field with text in it adds it too. The
 * chip cycles the importance for the tasks being entered.
 */
export function TaskComposer({ onCreate }: TaskComposerProps) {
  const { m } = useI18n();
  const [title, setTitle] = useState("");
  const [importance, setImportance] = useState<TaskImportance>(2);

  function submit() {
    const clean = title.trim();
    if (!clean) return;
    onCreate(clean, importance);
    setTitle("");
  }

  return (
    <form
      className="task-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="task-composer__field">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={(event) => {
            // Moving to the chip or the add button isn't leaving the row.
            if (!event.currentTarget.form?.contains(event.relatedTarget as Node | null)) submit();
          }}
          placeholder={m.today.addTask}
          aria-label={m.composer.newTaskAria}
          autoComplete="off"
          enterKeyHint="enter"
        />
        <button
          type="button"
          className="task-composer__importance"
          aria-label={`${m.composer.importanceAria}: ${m.composer.importance[importance]}`}
          // A tap keeps the focus (and the iPhone keyboard) in the field.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setImportance(NEXT_IMPORTANCE[importance])}
        >
          P{importance}
        </button>
      </div>
      <button type="submit" aria-label={m.composer.createTask} onPointerDown={(event) => event.preventDefault()}>
        <Plus size={18} aria-hidden="true" />
      </button>
    </form>
  );
}
