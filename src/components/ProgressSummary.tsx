import type { CSSProperties } from "react";
import { HeroPulse } from "./HeroPulse";
import { useI18n } from "../lib/i18n";
import { progressLabel, progressTone, type ProgressSummary as ProgressSummaryValue } from "../lib/progress";

interface ProgressSummaryProps {
  summary: ProgressSummaryValue;
  label: string;
}

export function ProgressSummary({ summary, label }: ProgressSummaryProps) {
  const { m } = useI18n();
  return (
    <section className="progress-summary" aria-label={label}>
      <div
        className="summary-hero"
        role="img"
        aria-label={m.progress.heroAria(summary.weightedPercent)}
      >
        <HeroPulse pct={summary.weightedPercent} />
        <span className="summary-hero__label">{m.progress.weighted}</span>
        <strong className="summary-hero__value">{progressLabel(summary.weightedPercent)}</strong>
      </div>
      <div className="summary-meter">
        <span>{m.progress.core}</span>
        <strong>{progressLabel(summary.corePercent)}</strong>
        <span
          className={`mini-bar tone-${progressTone(summary.corePercent)}`}
          style={{ "--pct": `${summary.corePercent}%` } as CSSProperties}
          aria-hidden="true"
        />
      </div>
      <div>
        <span>{m.progress.outputTasks}</span>
        <strong>{summary.outputCount}</strong>
      </div>
      <div>
        <span>{m.progress.blockedTasks}</span>
        <strong>{summary.blockedCount}</strong>
      </div>
      <div>
        <span>{m.progress.judgementLabel}</span>
        <strong>{m.judgement[summary.judgement]}</strong>
      </div>
    </section>
  );
}
