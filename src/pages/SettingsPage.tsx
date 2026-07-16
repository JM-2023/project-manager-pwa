import { KeyRound, LogOut, RefreshCcw, RotateCcw, Smartphone } from "lucide-react";
import { useState } from "react";
import { BackupControls } from "../components/BackupControls";
import { ChangePasscode } from "../components/ChangePasscode";
import { ExportButton } from "../components/ExportButton";
import { ImportWizard } from "../components/ImportWizard";
import { SegControl } from "../components/SegControl";
import { ThemeToggle } from "../components/ThemeToggle";
import { useHeroAnimation, type HeroAnimation } from "../lib/heroAnimation";
import { useMeterStyle, type MeterStyle } from "../lib/meterStyle";
import { useI18n, type Language } from "../lib/i18n";
import { usePresence } from "../lib/usePresence";
import type { ImportResponse, ImportRow, MutationConflict, SessionResponse } from "../lib/types";
import type { WorklogOverview } from "../lib/progress";

const HERO_ANIM_OPTIONS: HeroAnimation[] = ["flow", "shimmer"];
const METER_STYLE_OPTIONS: MeterStyle[] = ["glass", "flat"];

// The language names are proper nouns: each option always shows in its own
// language, whatever the current UI language is.
const LANGUAGE_OPTIONS: Array<{ id: Language; label: string }> = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" }
];

/** Data-health headline state, worst first. */
type HeroState = "error" | "conflict" | "pending" | "ok";

interface SettingsPageProps {
  taskCount: number;
  projectCount: number;
  pendingCount: number;
  lastSync: string | null;
  lastExport: string | null;
  syncError: string | null;
  conflicts: MutationConflict[];
  session: SessionResponse | null;
  worklogOverview: WorklogOverview;
  onImport: (filename: string, rows: ImportRow[]) => Promise<ImportResponse>;
  onExported: (timestamp: string) => void;
  onSync: () => void;
  onForceResync: () => void;
  onLogout: () => void;
}

export function SettingsPage({
  taskCount,
  projectCount,
  pendingCount,
  lastSync,
  lastExport,
  syncError,
  conflicts,
  session,
  worklogOverview,
  onImport,
  onExported,
  onSync,
  onForceResync,
  onLogout
}: SettingsPageProps) {
  const { m, lang, setLang } = useI18n();
  const r2Enabled = Boolean(session?.features.r2Backups);
  const passcodeEnabled = session?.features.authMode === "local_password";
  const [heroAnim, setHeroAnim] = useHeroAnimation();
  const [meterStyle, setMeterStyle] = useMeterStyle();
  const [changingPasscode, setChangingPasscode] = useState(false);
  const passcodeOverlay = usePresence(changingPasscode, 360);

  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const heroAnimLabels: Record<HeroAnimation, string> = { flow: m.settings.heroFlow, shimmer: m.settings.heroShimmer };
  const meterStyleLabels: Record<MeterStyle, string> = { glass: m.settings.meterGlass, flat: m.settings.meterFlat };

  const heroState: HeroState = syncError
    ? "error"
    : conflicts.length > 0
      ? "conflict"
      : pendingCount > 0
        ? "pending"
        : "ok";
  const heroTitle =
    heroState === "error"
      ? m.settings.syncError
      : heroState === "conflict"
        ? m.settings.statusConflicts(conflicts.length)
        : heroState === "pending"
          ? m.settings.statusPending(pendingCount)
          : m.settings.statusSynced;

  const formatStamp = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : m.settings.never;

  const stats: Array<{ label: string; value: string }> = [
    { label: m.settings.recordDays, value: String(worklogOverview.recordDays) },
    { label: m.settings.taskCount, value: String(worklogOverview.taskCount) },
    { label: m.settings.avgProgress, value: `${worklogOverview.averageProgress}%` },
    { label: m.settings.outputDays, value: String(worklogOverview.outputDays) },
    { label: m.settings.projects, value: String(projectCount) }
  ];

  function handleForceResync() {
    const confirmed = window.confirm(m.settings.forceResyncConfirm);
    if (confirmed) {
      onForceResync();
    }
  }

  return (
    <main className="page-content settings-page">
      <header className="page-header">
        <div className="page-header__title">
          <h1>{m.settings.title}</h1>
          <p>{session?.user.email ?? m.settings.signedIn}</p>
        </div>
      </header>

      {/* The page leads with the one thing that matters here: is the data
          safe? One surface — status headline + evidence above the divider,
          the accumulated stats as a quiet strip below it. */}
      <section className="settings-hero" data-state={heroState}>
        <div className="settings-hero__status">
          <div className="settings-hero__lead">
            <div className="settings-hero__headline">
              <span className="settings-hero__dot" aria-hidden="true" />
              <h2>{heroTitle}</h2>
            </div>
            <p className="settings-hero__meta">
              {m.settings.lastSync} {formatStamp(lastSync)} · {m.settings.lastExport} {formatStamp(lastExport)}
            </p>
            {syncError ? <p className="settings-hero__detail settings-hero__detail--error">{syncError}</p> : null}
            {heroState !== "pending" && pendingCount > 0 ? (
              <p className="settings-hero__detail">{m.settings.statusPending(pendingCount)}</p>
            ) : null}
            {conflicts.length > 0 ? (
              <div className="settings-hero__conflicts" aria-label={m.settings.conflictDetails}>
                {conflicts.map((conflict) => (
                  <small key={`${conflict.id}:${conflict.reason}`}>
                    {[conflict.entity, conflict.recordId, conflict.reason].filter(Boolean).join(" · ")}
                  </small>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" className="secondary-button" onClick={onSync}>
            <RefreshCcw size={17} aria-hidden="true" />
            <span>{m.settings.syncNow}</span>
          </button>
        </div>
        <div className="settings-hero__stats">
          {stats.map((stat) => (
            <div key={stat.label} className="settings-stat">
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__label">{m.settings.groupPreferences}</h2>
        <div className="settings-card">
          <div className="settings-card__section">
            <div className="settings-row">
              <span>{m.theme.label}</span>
              <ThemeToggle />
            </div>
          </div>
          <div className="settings-card__section">
            <div className="settings-row">
              <span>{m.settings.heroAnim}</span>
              <SegControl
                ariaLabel={m.settings.heroAnim}
                value={heroAnim}
                onChange={setHeroAnim}
                vtName="seg-hero"
                options={HERO_ANIM_OPTIONS.map((option) => ({ id: option, label: heroAnimLabels[option] }))}
              />
            </div>
            <p className="settings-hint">{m.settings.heroHint}</p>
          </div>
          <div className="settings-card__section">
            <div className="settings-row">
              <span>{m.settings.meterStyle}</span>
              <SegControl
                ariaLabel={m.settings.meterStyle}
                value={meterStyle}
                onChange={setMeterStyle}
                vtName="seg-meters"
                options={METER_STYLE_OPTIONS.map((option) => ({ id: option, label: meterStyleLabels[option] }))}
              />
            </div>
            <p className="settings-hint">{m.settings.meterHint}</p>
          </div>
          <div className="settings-card__section">
            <div className="settings-row">
              <span>{m.settings.appLanguage}</span>
              <SegControl
                ariaLabel={m.settings.appLanguage}
                value={lang}
                onChange={setLang}
                vtName="seg-language"
                options={LANGUAGE_OPTIONS.map((option) => ({
                  id: option.id,
                  label: option.label,
                  lang: option.id === "zh" ? "zh-CN" : "en"
                }))}
              />
            </div>
            <p className="settings-hint">{m.settings.languageHint}</p>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__label">{m.settings.groupData}</h2>
        <div className="settings-card">
          <div className="settings-card__section">
            <div className="export-actions">
              <ImportWizard onImport={onImport} />
              <ExportButton r2Enabled={r2Enabled} onExported={onExported} />
            </div>
          </div>
          <div className="settings-card__section">
            <BackupControls onRestored={onForceResync} />
            <p className="settings-hint">{m.settings.backupHint}</p>
          </div>
          <div className="settings-card__section">
            <button type="button" className="ghost-button" onClick={handleForceResync}>
              <RotateCcw size={16} aria-hidden="true" />
              <span>{m.settings.forceResync}</span>
            </button>
            <p className="settings-hint">{m.settings.forceResyncHint}</p>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__label">{m.settings.groupAccount}</h2>
        <div className="settings-card">
          {passcodeEnabled ? (
            <div className="settings-card__section">
              <button type="button" className="secondary-button" onClick={() => setChangingPasscode(true)}>
                <KeyRound size={17} aria-hidden="true" />
                <span>{m.settings.changePasscode}</span>
              </button>
              <p className="settings-hint">{m.settings.passcodeHint}</p>
            </div>
          ) : null}
          <div className="settings-card__section">
            <button type="button" className="ghost-button danger" onClick={onLogout}>
              <LogOut size={16} aria-hidden="true" />
              <span>{m.settings.signOut}</span>
            </button>
          </div>
        </div>
      </section>

      <p className="settings-footnote">
        <Smartphone size={18} aria-hidden="true" />
        <span>{m.settings.installNote}</span>
      </p>

      {passcodeOverlay.mounted ? (
        <ChangePasscode
          onClose={() => setChangingPasscode(false)}
          closing={passcodeOverlay.closing}
          onExited={passcodeOverlay.onExited}
        />
      ) : null}
    </main>
  );
}
