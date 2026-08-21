import { KeyRound, LogOut, RefreshCcw, RotateCcw, Smartphone } from "lucide-react";
import { useState } from "react";
import { BackgroundToggle } from "../components/BackgroundToggle";
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
import type { SyncStatus } from "../state/appStore";
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
type HeroState = "error" | "conflict" | "offline" | "loading" | "syncing" | "pending" | "queued" | "ok";

interface HeroStatusInput {
  online: boolean;
  syncStatus: SyncStatus;
  syncError: string | null;
  conflictCount: number;
  pendingCount: number;
}

export function resolveSettingsHeroState({
  online,
  syncStatus,
  syncError,
  conflictCount,
  pendingCount
}: HeroStatusInput): HeroState {
  if (syncError || syncStatus === "error") return "error";
  if (conflictCount > 0) return "conflict";
  if (!online || syncStatus === "offline") return "offline";
  if (syncStatus === "loading") return "loading";
  if (syncStatus === "syncing") return "syncing";
  if (syncStatus === "queued") return "queued";
  if (pendingCount > 0) return "pending";
  return "ok";
}

interface SettingsPageProps {
  taskCount: number;
  projectCount: number;
  pendingCount: number;
  online: boolean;
  syncStatus: SyncStatus;
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
  online,
  syncStatus,
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

  const offline = !online || syncStatus === "offline";
  const heroState = resolveSettingsHeroState({
    online,
    syncStatus,
    syncError,
    conflictCount: conflicts.length,
    pendingCount
  });
  const heroTitle = ({
    error: m.settings.syncError,
    conflict: m.settings.statusConflicts(conflicts.length),
    offline: m.offline.offline,
    loading: m.settings.statusLoading,
    syncing: m.offline.syncing(pendingCount),
    pending: m.settings.statusPending(pendingCount),
    queued: m.settings.statusQueued,
    ok: m.settings.statusSynced
  } satisfies Record<HeroState, string>)[heroState];

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
      <p className="settings-eyebrow">{m.settings.title}</p>

      {/* The page leads with the one thing that matters here: is the data
          safe? The sync state IS the page title; the evidence lines hang
          under it and the accumulated stats close the block over the page's
          first hairline. */}
      <header className="settings-head" data-state={heroState}>
        <div className="settings-head__row">
          <div className="settings-head__lead" role="status" aria-live="polite" aria-atomic="true">
            <div className="settings-head__headline">
              <span className="settings-head__dot" aria-hidden="true" />
              <h1>{heroTitle}</h1>
            </div>
            {syncError ? (
              <p className="settings-head__detail">
                <strong>{m.settings.errorLabel}</strong>
                {syncError}
              </p>
            ) : null}
            {offline && heroState !== "offline" ? <p className="settings-head__detail">{m.offline.offline}</p> : null}
            {heroState !== "pending" && heroState !== "syncing" && pendingCount > 0 ? (
              <p className="settings-head__detail">{m.settings.statusPending(pendingCount)}</p>
            ) : null}
            {conflicts.length > 0 ? (
              <div className="settings-head__conflicts" aria-label={m.settings.conflictDetails}>
                {conflicts.map((conflict) => (
                  <small key={`${conflict.id}:${conflict.reason}`}>
                    {[conflict.entity, conflict.recordId, conflict.reason].filter(Boolean).join(" · ")}
                  </small>
                ))}
              </div>
            ) : null}
            <p className="settings-head__meta">
              <span>
                {m.settings.lastSync} {formatStamp(lastSync)}
              </span>
              <span>
                {m.settings.lastExport} {formatStamp(lastExport)}
              </span>
            </p>
          </div>
          <button type="button" className="secondary-button" onClick={onSync}>
            <RefreshCcw size={17} aria-hidden="true" />
            <span>{m.settings.syncNow}</span>
          </button>
        </div>
        <div className="settings-head__stats">
          {stats.map((stat) => (
            <div key={stat.label} className="settings-stat">
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>
      </header>

      <section className="settings-group">
        <h2 className="settings-group__label">{m.settings.groupPreferences}</h2>
        <div className="settings-group__body settings-group__body--appearance">
          <div className="settings-item settings-item--row">
            <span className="settings-item__label">{m.theme.label}</span>
            <ThemeToggle />
          </div>
          <div className="settings-item settings-item--row">
            <div className="settings-item__text">
              <span className="settings-item__label">{m.settings.background}</span>
              <p className="settings-hint">{m.settings.backgroundHint}</p>
            </div>
            <BackgroundToggle />
          </div>
          <div className="settings-item settings-item--row">
            <div className="settings-item__text">
              <span className="settings-item__label">{m.settings.meterStyle}</span>
              <p className="settings-hint">{m.settings.meterHint}</p>
            </div>
            <SegControl
              ariaLabel={m.settings.meterStyle}
              value={meterStyle}
              onChange={setMeterStyle}
              vtName="seg-meters"
              options={METER_STYLE_OPTIONS.map((option) => ({ id: option, label: meterStyleLabels[option] }))}
            />
          </div>
          <div className="settings-item settings-item--row">
            <div className="settings-item__text">
              <span className="settings-item__label">{m.settings.heroAnim}</span>
              <p className="settings-hint">{m.settings.heroHint}</p>
            </div>
            <SegControl
              ariaLabel={m.settings.heroAnim}
              value={heroAnim}
              onChange={setHeroAnim}
              vtName="seg-hero"
              options={HERO_ANIM_OPTIONS.map((option) => ({ id: option, label: heroAnimLabels[option] }))}
            />
          </div>
          <div className="settings-item settings-item--row">
            <div className="settings-item__text">
              <span className="settings-item__label">{m.settings.appLanguage}</span>
              <p className="settings-hint">{m.settings.languageHint}</p>
            </div>
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
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__label">{m.settings.groupData}</h2>
        <div className="settings-group__body">
          <div className="settings-item">
            <span className="settings-item__label">{m.settings.excelTitle}</span>
            <div className="export-actions">
              <ImportWizard onImport={onImport} />
              <ExportButton r2Enabled={r2Enabled} onExported={onExported} />
            </div>
          </div>
          <div className="settings-item">
            <span className="settings-item__label">{m.settings.jsonTitle}</span>
            <p className="settings-hint">{m.settings.backupHint}</p>
            <BackupControls onRestored={onForceResync} />
          </div>
          <div className="settings-item">
            <span className="settings-item__label">{m.settings.forceResync}</span>
            <p className="settings-hint">{m.settings.forceResyncHint}</p>
            <div className="export-actions">
              <button type="button" className="ghost-button" onClick={handleForceResync}>
                <RotateCcw size={16} aria-hidden="true" />
                <span>{m.settings.forceResync}</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__label">{m.settings.groupAccount}</h2>
        <div className="settings-group__body">
          <div className="settings-item">
            <span className="settings-item__label settings-item__label--wrap">
              {session?.user.email ?? m.settings.signedIn}
            </span>
            {session ? (
              <p className="settings-item__sub">{passcodeEnabled ? m.settings.accountStatus : m.settings.signedIn}</p>
            ) : null}
          </div>
          {passcodeEnabled ? (
            <div className="settings-item">
              <span className="settings-item__label">{m.settings.passcodeTitle}</span>
              <p className="settings-hint">{m.settings.passcodeHint}</p>
              <div className="export-actions">
                <button type="button" className="secondary-button" onClick={() => setChangingPasscode(true)}>
                  <KeyRound size={17} aria-hidden="true" />
                  <span>{m.settings.changePasscode}</span>
                </button>
              </div>
            </div>
          ) : null}
          <div className="settings-item">
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
