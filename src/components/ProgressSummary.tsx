import type { CSSProperties } from "react";
import { HeroPulse } from "./HeroPulse";
import { RollDigits } from "./RollDigits";
import { useI18n } from "../lib/i18n";
import { progressLabel, progressTone, type ProgressSummary as ProgressSummaryValue } from "../lib/progress";

interface ProgressSummaryProps {
  summary: ProgressSummaryValue;
  label: string;
}

/**
 * The Today hero: one card, two registers.
 *
 * The weighted figure is the only thing on the upper pane — it gets the whole
 * liquid canvas to itself and is set large enough to be read across the room.
 * The day's supporting facts sit under a hairline as a quiet three-up strip,
 * so they are available without competing with the headline. Every figure
 * rolls (RollDigits) rather than swapping, which is what makes an edit to a
 * single task read as the day's number moving.
 */
export function ProgressSummary({ summary, label }: ProgressSummaryProps) {
  const { m } = useI18n();
  return (
    <section className="progress-summary" aria-label={label}>
      <div className="summary-hero" role="img" aria-label={m.progress.heroAria(summary.weightedPercent)}>
        <HeroPulse pct={summary.weightedPercent} />
        <div className="summary-hero__body">
          <span className="summary-hero__label">{m.progress.weighted}</span>
          <strong className="summary-hero__value">
            <RollDigits value={summary.weightedPercent} text={progressLabel(summary.weightedPercent)} />
          </strong>
        </div>
      </div>
      <div className="summary-stats">
        <div className="summary-stat summary-stat--meter">
          <span>{m.progress.core}</span>
          <strong>
            <RollDigits value={summary.corePercent} text={progressLabel(summary.corePercent)} />
          </strong>
          <span
            className={`mini-bar tone-${progressTone(summary.corePercent)}`}
            style={{ "--pct": `${summary.corePercent}%` } as CSSProperties}
            aria-hidden="true"
          />
        </div>
        <div className="summary-stat">
          <span>{m.progress.outputTasks}</span>
          <strong>
            <RollDigits value={summary.outputCount} text={String(summary.outputCount)} />
          </strong>
        </div>
        {/* Blocked is the one figure allowed to change colour: a day with a
            blocker should say so before you read the label. */}
        <div className={`summary-stat${summary.blockedCount > 0 ? " is-blocked" : ""}`}>
          <span>{m.progress.blockedTasks}</span>
          <strong>
            <RollDigits value={summary.blockedCount} text={String(summary.blockedCount)} />
          </strong>
        </div>
      </div>
    </section>
  );
}
