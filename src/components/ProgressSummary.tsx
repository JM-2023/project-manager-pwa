import { progressLabel, type ProgressSummary as ProgressSummaryValue } from "../lib/progress";

interface ProgressSummaryProps {
  summary: ProgressSummaryValue;
  label: string;
}

export function ProgressSummary({ summary, label }: ProgressSummaryProps) {
  return (
    <section className="progress-summary" aria-label={label}>
      <div>
        <span>核心任务进度</span>
        <strong>{progressLabel(summary.corePercent)}</strong>
      </div>
      <div>
        <span>加权推进</span>
        <strong>{progressLabel(summary.weightedPercent)}</strong>
      </div>
      <div>
        <span>有产出任务数</span>
        <strong>{summary.outputCount}</strong>
      </div>
      <div>
        <span>Blocked 数</span>
        <strong>{summary.blockedCount}</strong>
      </div>
      <div>
        <span>今日判断</span>
        <strong>{summary.judgement}</strong>
      </div>
    </section>
  );
}
