import { LogOut, RefreshCcw, RotateCcw, Smartphone } from "lucide-react";
import { ExportButton } from "../components/ExportButton";
import { ImportWizard } from "../components/ImportWizard";
import { ThemeToggle } from "../components/ThemeToggle";
import type { ImportResponse, ImportRow, SessionResponse } from "../lib/types";
import type { WorklogOverview } from "../lib/progress";

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
  const r2Enabled = Boolean(session?.features.r2Backups);

  function handleForceResync() {
    const confirmed = window.confirm(
      "强制全量同步会清空本机缓存并从云端重新拉取全部数据。仅在云端数据被清空重导、本机出现重复/残留任务时使用。继续？"
    );
    if (confirmed) {
      onForceResync();
    }
  }

  return (
    <main className="page-content">
      <header className="page-header">
        <div className="page-header__title">
          <h1>Settings</h1>
          <p>{session?.user.email ?? "Signed in"}</p>
        </div>
        <ThemeToggle />
      </header>

      <section className="settings-grid">
        <div className="metric">
          <span>记录天数</span>
          <strong>{worklogOverview.recordDays}</strong>
        </div>
        <div className="metric">
          <span>任务数</span>
          <strong>{worklogOverview.taskCount}</strong>
        </div>
        <div className="metric">
          <span>平均推进</span>
          <strong>{worklogOverview.averageProgress}%</strong>
        </div>
        <div className="metric">
          <span>明确产出天数</span>
          <strong>{worklogOverview.outputDays}</strong>
        </div>
        <div className="metric">
          <span>Projects</span>
          <strong>{projectCount}</strong>
        </div>
        <div className="metric">
          <span>Pending</span>
          <strong>{pendingCount}</strong>
        </div>
        <div className="metric wide">
          <span>Last sync</span>
          <strong>{lastSync ? new Date(lastSync).toLocaleString() : "Never"}</strong>
        </div>
        <div className="metric wide">
          <span>Last export</span>
          <strong>{lastExport ? new Date(lastExport).toLocaleString() : "Never"}</strong>
        </div>
      </section>

      <section className="settings-section">
        <h2>Excel</h2>
        <ImportWizard onImport={onImport} />
        <ExportButton r2Enabled={r2Enabled} onExported={onExported} />
      </section>

      <section className="settings-section">
        <h2>Sync</h2>
        <button type="button" className="secondary-button" onClick={onSync}>
          <RefreshCcw size={17} aria-hidden="true" />
          <span>Sync now</span>
        </button>
        <button type="button" className="ghost-button" onClick={handleForceResync}>
          <RotateCcw size={16} aria-hidden="true" />
          <span>Force full resync</span>
        </button>
        <p className="settings-hint">清空本机缓存并从云端重新拉取全部数据。仅在云端被清空重导后用于消除重复任务。</p>
      </section>

      <section className="settings-section">
        <h2>iPhone</h2>
        <div className="install-note">
          <Smartphone size={20} aria-hidden="true" />
          <p>In Safari, open Share, choose Add to Home Screen, then launch Projects from the Home Screen icon.</p>
        </div>
      </section>

      <button type="button" className="ghost-button danger" onClick={onLogout}>
        <LogOut size={16} aria-hidden="true" />
        <span>Sign out</span>
      </button>
    </main>
  );
}
