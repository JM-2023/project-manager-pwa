import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../lib/i18n";
import type { MutationConflict } from "../lib/types";
import type { SyncStatus } from "../state/appStore";
import { resolveSettingsHeroState, SettingsPage } from "./SettingsPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSettings({
  online = true,
  syncStatus = "idle",
  pendingCount = 0,
  conflicts = []
}: {
  online?: boolean;
  syncStatus?: SyncStatus;
  pendingCount?: number;
  conflicts?: MutationConflict[];
} = {}): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SettingsPage
        taskCount={0}
        projectCount={0}
        pendingCount={pendingCount}
        online={online}
        syncStatus={syncStatus}
        lastSync={null}
        lastExport={null}
        syncError={null}
        conflicts={conflicts}
        session={null}
        worklogOverview={{ recordDays: 0, taskCount: 0, averageProgress: 0, outputDays: 0, firstDate: null, lastDate: null }}
        onImport={async () => ({ ok: true, batchId: "test", created: 0, updated: 0, skipped: 0 })}
        onExported={() => undefined}
        onSync={() => undefined}
        onForceResync={() => undefined}
        onLogout={() => undefined}
      />
    </I18nProvider>
  );
}

describe("resolveSettingsHeroState", () => {
  it("does not report success while offline or syncing with no pending changes", () => {
    expect(
      resolveSettingsHeroState({ online: false, syncStatus: "offline", syncError: null, conflictCount: 0, pendingCount: 0 })
    ).toBe("offline");
    expect(
      resolveSettingsHeroState({ online: true, syncStatus: "syncing", syncError: null, conflictCount: 0, pendingCount: 0 })
    ).toBe("syncing");
  });

  it("distinguishes loading and an empty scheduled sync from a completed sync", () => {
    expect(
      resolveSettingsHeroState({ online: true, syncStatus: "loading", syncError: null, conflictCount: 0, pendingCount: 0 })
    ).toBe("loading");
    expect(
      resolveSettingsHeroState({ online: true, syncStatus: "queued", syncError: null, conflictCount: 0, pendingCount: 0 })
    ).toBe("queued");
    expect(
      resolveSettingsHeroState({ online: true, syncStatus: "queued", syncError: null, conflictCount: 0, pendingCount: 2 })
    ).toBe("queued");
  });

  it("keeps errors and conflicts ahead of connectivity and queue states", () => {
    expect(
      resolveSettingsHeroState({ online: false, syncStatus: "offline", syncError: "failed", conflictCount: 1, pendingCount: 1 })
    ).toBe("error");
    expect(
      resolveSettingsHeroState({ online: false, syncStatus: "offline", syncError: null, conflictCount: 1, pendingCount: 1 })
    ).toBe("conflict");
  });
});

describe("SettingsPage sync status", () => {
  it("renders truthful localized offline and syncing headlines", () => {
    expect(renderSettings({ online: false, syncStatus: "offline" })).toContain('<h2>Offline</h2>');
    expect(renderSettings({ syncStatus: "syncing" })).toContain('<h2>Syncing</h2>');
    expect(renderSettings({ syncStatus: "queued" })).toContain('<h2>Sync scheduled</h2>');

    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "pm:lang" ? "zh" : null),
      removeItem: () => undefined,
      setItem: () => undefined
    });
    expect(renderSettings({ syncStatus: "syncing" })).toContain('<h2>同步中</h2>');
    expect(renderSettings({ syncStatus: "loading" })).toContain('<h2>正在检查数据状态</h2>');
  });

  it("exposes changing conflict messages through a stable atomic live region", () => {
    const html = renderSettings({
      conflicts: [{ id: "mutation-1", entity: "task", recordId: "task-1", reason: "version_conflict" }]
    });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('<h2>1 sync conflict</h2>');
    expect(html).toContain('task · task-1 · version_conflict');
  });
});
