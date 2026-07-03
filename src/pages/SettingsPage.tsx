import { KeyRound, LogOut, RefreshCcw, RotateCcw, Smartphone } from "lucide-react";
import { useState } from "react";
import { ChangePasscode } from "../components/ChangePasscode";
import { ExportButton } from "../components/ExportButton";
import { ImportWizard } from "../components/ImportWizard";
import { ThemeToggle } from "../components/ThemeToggle";
import { useHeroAnimation, type HeroAnimation } from "../lib/heroAnimation";
import { useI18n, type Language } from "../lib/i18n";
import type { ImportResponse, ImportRow, SessionResponse } from "../lib/types";
import type { WorklogOverview } from "../lib/progress";

const HERO_ANIM_OPTIONS: HeroAnimation[] = ["flow", "shimmer"];

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
  const [changingPasscode, setChangingPasscode] = useState(false);

  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const heroAnimLabels: Record<HeroAnimation, string> = { flow: m.settings.heroFlow, shimmer: m.settings.heroShimmer };

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
      </section>

      <section className="settings-section">
        <h2>{m.settings.appearance}</h2>
        <div className="settings-row">
          <span>{m.settings.heroAnim}</span>
          <div className="cal-seg" role="group" aria-label={m.settings.heroAnim}>
            {HERO_ANIM_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={heroAnim === option ? "active" : ""}
                aria-pressed={heroAnim === option}
                onClick={() => setHeroAnim(option)}
              >
                {heroAnimLabels[option]}
              </button>
            ))}
          </div>
        </div>
        <p className="settings-hint">{m.settings.heroHint}</p>
      </section>

      <section className="settings-section">
        <h2>{m.settings.language}</h2>
        <div className="settings-row">
          <span>{m.settings.appLanguage}</span>
          <div className="cal-seg" role="group" aria-label={m.settings.appLanguage}>
            {LANGUAGE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                lang={option.id === "zh" ? "zh-CN" : "en"}
                className={lang === option.id ? "active" : ""}
                aria-pressed={lang === option.id}
                onClick={() => setLang(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <p className="settings-hint">{m.settings.languageHint}</p>
      </section>

      <section className="settings-section">
        <h2>{m.settings.excel}</h2>
        <ImportWizard onImport={onImport} />
        <ExportButton r2Enabled={r2Enabled} onExported={onExported} />
      </section>

      <section className="settings-section">
        <h2>{m.settings.sync}</h2>
        <button type="button" className="secondary-button" onClick={onSync}>
          <RefreshCcw size={17} aria-hidden="true" />
          <span>{m.settings.syncNow}</span>
        </button>
        <button type="button" className="ghost-button" onClick={handleForceResync}>
          <RotateCcw size={16} aria-hidden="true" />
          <span>{m.settings.forceResync}</span>
        </button>
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

      {changingPasscode ? <ChangePasscode onClose={() => setChangingPasscode(false)} /> : null}
    </main>
  );
}
