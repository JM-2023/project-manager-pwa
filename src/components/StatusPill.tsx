import { useI18n } from "../lib/i18n";
import type { TaskStatus } from "../lib/types";

interface StatusPillProps {
  status: TaskStatus;
}

export function StatusPill({ status }: StatusPillProps) {
  const { m } = useI18n();
  return <span className={`status-pill status-${status}`}>{m.status[status]}</span>;
}
