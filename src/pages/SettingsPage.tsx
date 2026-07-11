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
import type { ImportResponse, ImportRow, SessionResponse } from "../lib/types";
import type { WorklogOverview } from "../lib/progress";

const HERO_ANIM_OPTIONS: HeroAnimation[] = ["flow", "shimmer"];
const METER_STYLE_OPTIONS: MeterStyle[] = ["glass", "flat"];

// The language names are proper nouns: each option always shows in its own
// language, whatever the current UI language is.
const LANGUAGE_OPTIONS: Array<{ id: Language; label: string }> = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" }
];

interface SettingsPageProps {
  taskCount: number;
  projectCount: number;
  pendingCount: number;
  lastSync: string | null;
  lastExport: string | null;
  syncError: string | null;
  conflicts: number;
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

  function handleForceResync() {
    const confirmed = window.confirm(m.settings.forceResyncConfirm);
    if (confirmed) {
      onForceResync();
    }
  }

  return (
    <main className="page-content">
      <header className="page-header">
        <div className="page-header__title">
          <h1>{m.settings.title}</h1>
          <p>{session?.user.email ?? m.settings.signedIn}</p>
        </div>
        <ThemeToggle />
      </header>

      <section className="settings-grid">
        <div className="metric">
          <span>{m.settings.recordDays}</span>
          <strong>{worklogOverview.recordDays}</strong>
        </div>
        <div className="metric">
          <span>{m.settings.taskCount}</span>
          <strong>{worklogOverview.taskCount}</strong>
        </div>
        <div className="metric">
          <span>{m.settings.avgProgress}</span>
          <strong>{worklogOverview.averageProgress}%</strong>
        </div>
        <div className="metric">
          <span>{m.settings.outputDays}</span>
          <strong>{worklogOverview.outputDays}</strong>
        </div>
        <div className="metric">
          <span>{m.settings.projects}</span>
          <strong>{projectCount}</strong>
        </div>
        <div className="metric">
          <span>{m.settings.pending}</span>
          <strong>{pendingCount}</strong>
        </div>
        <div className="metric wide">
          <span>{m.settings.lastSync}</span>
          <strong>{lastSync ? new Date(lastSync).toLocaleString(locale) : m.settings.never}</strong>
        </div>
        <div className="metric wide">
          <span>{m.settings.lastExport}</span>
          <strong>{lastExport ? new Date(lastExport).toLocaleString(locale) : m.settings.never}</strong>
        </div>
        {conflicts > 0 ? (
          <div className="metric">
            <span>{m.settings.conflicts}</span>
            <strong>{conflicts}</strong>
          </div>
        ) : null}
        {syncError ? (
          <div className="metric wide">
            <span>{m.settings.syncError}</span>
            <strong>{syncError}</strong>
          </div>
        ) : null}
      </section>

      <section className="settings-section">
        <h2>{m.settings.appearance}</h2>
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
      </section>

      <section className="settings-section">
        <h2>{m.settings.language}</h2>
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
      </section>

      <section className="settings-section">
        <h2>{m.settings.excel}</h2>
        <div className="export-actions">
          <ImportWizard onImport={onImport} />
          <ExportButton r2Enabled={r2Enabled} onExported={onExported} />
        </div>
      </section>

      <section className="settings-section">
        <h2>{m.settings.backup}</h2>
        <BackupControls onRestored={onForceResync} />
        <p className="settings-hint">{m.settings.backupHint}</p>
      </section>

      <section className="settings-section">
        <h2>{m.settings.sync}</h2>
        <div className="export-actions">
          <button type="button" className="secondary-button" onClick={onSync}>
            <RefreshCcw size={17} aria-hidden="true" />
            <span>{m.settings.syncNow}</span>
          </button>
          <button type="button" className="ghost-button" onClick={handleForceResync}>
            <RotateCcw size={16} aria-hidden="true" />
            <span>{m.settings.forceResync}</span>
          </button>
        </div>
        <p className="settings-hint">{m.settings.forceResyncHint}</p>
      </section>

      {passcodeEnabled ? (
        <section className="settings-section">
          <h2>{m.settings.security}</h2>
          <button type="button" className="secondary-button" onClick={() => setChangingPasscode(true)}>
            <KeyRound size={17} aria-hidden="true" />
            <span>{m.settings.changePasscode}</span>
          </button>
          <p className="settings-hint">{m.settings.passcodeHint}</p>
        </section>
      ) : null}

      <section className="settings-section">
        <h2>{m.settings.iphone}</h2>
        <div className="install-note">
          <Smartphone size={20} aria-hidden="true" />
          <p>{m.settings.installNote}</p>
        </div>
      </section>

      <button type="button" className="ghost-button danger" onClick={onLogout}>
        <LogOut size={16} aria-hidden="true" />
        <span>{m.settings.signOut}</span>
      </button>

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
