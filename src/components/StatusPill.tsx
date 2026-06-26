import type { TaskStatus } from "../lib/types";
import { statusLabel } from "../lib/validation";

interface StatusPillProps {
  status: TaskStatus;
}

export function StatusPill({ status }: StatusPillProps) {
  return <span className={`status-pill status-${status}`}>{statusLabel(status)}</span>;
}
