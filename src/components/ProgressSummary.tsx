import type { CSSProperties } from "react";
import { progressLabel, progressTone, type ProgressSummary as ProgressSummaryValue } from "../lib/progress";

interface ProgressSummaryProps {
  summary: ProgressSummaryValue;
  label: string;
}

export function ProgressSummary({ summary, label }: ProgressSummaryProps) {
  return (
    <section className="progress-summary" aria-label={label}>
      <div className="summary-hero">
        <span>核心任务进度</span>
        <div
          className={`metric-ring tone-${progressTone(summary.corePercent)}`}
          style={{ "--pct": `${summary.corePercent}%` } as CSSProperties}
          role="img"
          aria-label={`核心任务进度 ${summary.corePercent}%`}
        >
          <strong>{progressLabel(summary.corePercent)}</strong>
        </div>
      </div>
      <div className="summary-meter">
        <span>加权推进</span>
        <strong>{progressLabel(summary.weightedPercent)}</strong>
        <span
          className={`mini-bar tone-${progressTone(summary.weightedPercent)}`}
          style={{ "--pct": `${summary.weightedPercent}%` } as CSSProperties}
          aria-hidden="true"
        />
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
