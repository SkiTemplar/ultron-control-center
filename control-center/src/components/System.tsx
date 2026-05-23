import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  InstalledApp,
  InstalledAppsReport,
  UninstallAppResult,
} from "../types";
import { Hooks } from "./Hooks";
import { Diagnostics } from "./system/Diagnostics";
import { useFeatures } from "../lib/features";

// v2.0 cleanup (post USER audit 2026-05-23):
//   - Overview  : DROPPED — duplicates the dashboard health card.
//   - Schedules : DROPPED — USER disabled ULTRON; the only surviving
//                 task (weekly backup) belongs in Settings → Backups.
//   - Apps      : KEEP — extended with search/group-by-publisher; mojibake
//                 fix lives in src-tauri/installed_apps.rs.
//   - Diagnostics : KEEP — redesigned for compact on-demand use.
//   - Hooks     : KEEP — better empty state, grouped by event.
type SystemSubTab = "apps" | "hooks" | "diagnostics";

// ---------------------------------------------------------------------------
// Apps panel — sub-tab "Apps" under System
// ---------------------------------------------------------------------------

type AppProviderFilter = "all" | "winget" | "store" | "msi" | "manual";
type AppGroupMode = "none" | "publisher";

function providerBadgeColor(provider: string): { bg: string; fg: string } {
  switch (provider) {
    case "winget":
      return {
        bg: "rgba(56, 139, 253, 0.12)",
        fg: "var(--color-accent, #58a6ff)",
      };
    case "store":
      return {
        bg: "rgba(163, 113, 247, 0.12)",
        fg: "#a371f7",
      };
    case "msi":
      return {
        bg: "rgba(63, 185, 80, 0.12)",
        fg: "var(--color-success)",
      };
    case "manual":
    default:
      return {
        bg: "rgba(187, 187, 187, 0.10)",
        fg: "var(--color-text-secondary)",
      };
  }
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "winget":
      return "winget";
    case "store":
      return "Store";
    case "msi":
      return "MSI";
    case "manual":
      return "Manual";
    default:
      return provider || "?";
  }
}

/** Single-row uninstall modal. The user must type the exact app name to
 *  confirm — same gesture the OS uses for irreversible mutations. */
function UninstallModal({
  appInfo,
  onClose,
  onDone,
}: {
  appInfo: InstalledApp;
  onClose: () => void;
  onDone: (result: UninstallAppResult) => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = typed.trim() === appInfo.name.trim() && !busy;

  async function go() {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      const r = (await invoke("uninstall_app", {
        name: appInfo.name,
        provider: appInfo.provider,
        packageId: appInfo.package_id,
      })) as UninstallAppResult;
      onDone(r);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded p-4"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          Uninstall {appInfo.name}?
        </div>
        <div
          className="mb-3 text-[11.5px] leading-snug"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          This will invoke the {providerLabel(appInfo.provider)} uninstaller. The
          action is irreversible and may require admin elevation depending on
          the package. Type the app name below to confirm.
        </div>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={appInfo.name}
          className="w-full rounded px-2 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            fontFamily: "var(--font-mono)",
          }}
        />
        {error && (
          <div
            className="mt-2 rounded p-2 text-[11.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={go}
            disabled={!armed}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "rgba(248, 81, 73, 0.85)",
              color: "white",
            }}
          >
            {busy ? "Uninstalling…" : "Uninstall"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface AppGroupSectionProps {
  publisher: string;
  apps: InstalledApp[];
  openFolder: (app: InstalledApp) => void;
  requestUninstall: (app: InstalledApp) => void;
}

/** Collapsible group, one per publisher when group mode is "publisher". */
function AppGroupSection({
  publisher,
  apps,
  openFolder,
  requestUninstall,
}: AppGroupSectionProps) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="overflow-hidden rounded"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline justify-between px-3 py-2 text-left"
        style={{
          background: "var(--color-surface-1)",
          borderBottom: open ? "1px solid var(--color-border)" : "none",
        }}
      >
        <span
          className="text-[12px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {publisher}
          <span
            className="ml-1.5 text-[10.5px] tabular-nums"
            style={{ color: "var(--color-text-faint)" }}
          >
            {apps.length}
          </span>
        </span>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div>
          {apps.map((appInfo, i) => (
            <AppRow
              key={`${appInfo.provider}|${appInfo.name}|${appInfo.package_id || i}`}
              appInfo={appInfo}
              first={i === 0}
              openFolder={openFolder}
              requestUninstall={requestUninstall}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AppRow({
  appInfo,
  first,
  openFolder,
  requestUninstall,
}: {
  appInfo: InstalledApp;
  first: boolean;
  openFolder: (app: InstalledApp) => void;
  requestUninstall: (app: InstalledApp) => void;
}) {
  const colors = providerBadgeColor(appInfo.provider);
  const hasFolder = !!appInfo.install_location;
  return (
    <div
      className="grid items-center gap-3 px-3 py-2 text-[12px]"
      style={{
        gridTemplateColumns: "minmax(0, 2.6fr) 70px 80px minmax(0, 1.4fr) 150px",
        borderTop: first ? "none" : "1px solid var(--color-border)",
      }}
    >
      <div className="min-w-0">
        <div
          className="truncate font-medium"
          style={{ color: "var(--color-text)" }}
          title={appInfo.name}
        >
          {appInfo.name}
        </div>
        {(appInfo.publisher || appInfo.package_id) && (
          <div
            className="truncate text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
            title={`${appInfo.publisher || ""}${
              appInfo.publisher && appInfo.package_id ? " · " : ""
            }${appInfo.package_id || ""}`}
          >
            {appInfo.publisher}
            {appInfo.publisher && appInfo.package_id ? " · " : ""}
            {appInfo.package_id && (
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {appInfo.package_id}
              </span>
            )}
          </div>
        )}
      </div>
      <span
        className="inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
        style={{ background: colors.bg, color: colors.fg }}
      >
        {providerLabel(appInfo.provider)}
      </span>
      <span
        className="truncate tabular-nums text-[11px]"
        style={{ color: "var(--color-text-secondary)" }}
        title={appInfo.version || ""}
      >
        {appInfo.version || "—"}
      </span>
      <span
        className="truncate text-[11px]"
        style={{
          color: hasFolder ? "var(--color-text-secondary)" : "var(--color-text-faint)",
          fontFamily: hasFolder ? "var(--font-mono)" : undefined,
        }}
        title={appInfo.install_location || "unknown"}
      >
        {appInfo.install_location || "—"}
      </span>
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={() => openFolder(appInfo)}
          disabled={!hasFolder}
          className="rounded px-2 py-1 text-[10.5px] font-medium transition-colors disabled:opacity-30"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title={hasFolder ? "Open install folder in Explorer" : "No install location reported"}
        >
          Folder
        </button>
        <button
          type="button"
          onClick={() => requestUninstall(appInfo)}
          className="rounded px-2 py-1 text-[10.5px] font-medium transition-colors"
          style={{
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
            border: "1px solid rgba(248, 81, 73, 0.32)",
          }}
          title={`Uninstall via ${providerLabel(appInfo.provider)}`}
        >
          Uninstall
        </button>
      </div>
    </div>
  );
}

function AppsPanel() {
  const [report, setReport] = useState<InstalledAppsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<AppProviderFilter>("all");
  const [groupMode, setGroupMode] = useState<AppGroupMode>("none");
  const [pendingUninstall, setPendingUninstall] = useState<InstalledApp | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  async function load(force: boolean) {
    setLoading(true);
    setError(null);
    try {
      const r = (await invoke("list_installed_apps", { force })) as InstalledAppsReport;
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
  }, []);

  const filtered = useMemo(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.apps.filter((a) => {
      if (providerFilter !== "all" && a.provider !== providerFilter) return false;
      if (!q) return true;
      const hay = `${a.name} ${a.publisher || ""} ${a.package_id || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [report, query, providerFilter]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { winget: 0, store: 0, msi: 0, manual: 0 };
    for (const a of report?.apps || []) {
      map[a.provider] = (map[a.provider] || 0) + 1;
    }
    return map;
  }, [report]);

  /** Buckets filtered apps by publisher when group mode is "publisher", or
   *  a single bucket otherwise. Alphabetical key order; apps inside each
   *  bucket sorted by name. "Unknown publisher" sinks to the bottom. */
  const grouped = useMemo<Array<[string, InstalledApp[]]>>(() => {
    if (groupMode === "none") return [["", filtered]];
    const map = new Map<string, InstalledApp[]>();
    for (const a of filtered) {
      const key = (a.publisher || "").trim() || "Unknown publisher";
      const arr = map.get(key) || [];
      arr.push(a);
      map.set(key, arr);
    }
    const entries = Array.from(map.entries());
    entries.sort(([a], [b]) => {
      if (a === "Unknown publisher") return 1;
      if (b === "Unknown publisher") return -1;
      return a.localeCompare(b);
    });
    for (const [, arr] of entries) {
      arr.sort((x, y) => x.name.localeCompare(y.name));
    }
    return entries;
  }, [filtered, groupMode]);

  const wingetMissing = (report?.source_errors || []).some((m) => /winget/i.test(m));

  async function handleOpenFolder(app: InstalledApp) {
    if (!app.install_location) return;
    setActionMsg(null);
    try {
      await invoke("open_app_folder", { installLocation: app.install_location });
      setActionMsg(`Opened ${app.install_location}`);
    } catch (e) {
      setActionMsg(`Failed to open folder: ${e}`);
    }
  }

  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by name, publisher, id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-[240px] flex-1 rounded px-2.5 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        />
        <div
          className="flex items-center gap-0.5 rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {(["all", "winget", "store", "msi", "manual"] as AppProviderFilter[]).map((p) => {
            const selected = providerFilter === p;
            const count = p === "all" ? report?.apps.length || 0 : counts[p] || 0;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setProviderFilter(p)}
                className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors"
                style={{
                  background: selected ? "var(--color-surface-3)" : "transparent",
                  color: selected ? "var(--color-text)" : "var(--color-text-tertiary)",
                }}
                title={`Filter by ${p}`}
              >
                {p === "all" ? "All" : providerLabel(p)}
                <span
                  className="ml-1.5 text-[10.5px] tabular-nums"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <div
          className="flex items-center gap-0.5 rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Group rows by publisher to find related apps faster"
        >
          {(["none", "publisher"] as AppGroupMode[]).map((g) => {
            const selected = groupMode === g;
            return (
              <button
                key={g}
                type="button"
                onClick={() => setGroupMode(g)}
                className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors"
                style={{
                  background: selected ? "var(--color-surface-3)" : "transparent",
                  color: selected ? "var(--color-text)" : "var(--color-text-tertiary)",
                }}
              >
                {g === "none" ? "Flat" : "Group by publisher"}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title="Bypass the 1h cache and re-scan"
        >
          {loading ? "Scanning…" : "Refresh"}
        </button>
      </div>

      {report?.cached && (
        <div
          className="mb-2 text-[10.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Cached snapshot from {report.generated_at} — hit Refresh to re-scan.
        </div>
      )}

      {wingetMissing && (
        <div
          className="mb-2 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(210, 153, 34, 0.06)",
            border: "1px solid rgba(210, 153, 34, 0.22)",
            color: "var(--color-warn)",
          }}
        >
          winget not available on PATH — modern packages may be missing from
          the list. Registry-tracked apps (MSI / manual) are still shown.
        </div>
      )}

      {error && (
        <div
          className="mb-2 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {actionMsg && (
        <div
          className="mb-2 rounded p-2 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {actionMsg}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div
          className="rounded p-6 text-center text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {report?.apps.length
            ? "No apps match the current filter."
            : "No installed apps detected."}
        </div>
      )}

      {filtered.length > 0 && groupMode === "none" && (
        <div
          className="overflow-hidden rounded"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div
            className="grid items-center gap-3 px-3 py-2 text-[10px] uppercase tracking-[0.06em]"
            style={{
              gridTemplateColumns: "minmax(0, 2.6fr) 70px 80px minmax(0, 1.4fr) 150px",
              borderBottom: "1px solid var(--color-border)",
              background: "var(--color-surface-1)",
              color: "var(--color-text-tertiary)",
            }}
          >
            <span>Name</span>
            <span>Provider</span>
            <span>Version</span>
            <span>Install location</span>
            <span className="text-right">Actions</span>
          </div>
          <div>
            {filtered.map((appInfo, i) => (
              <AppRow
                key={`${appInfo.provider}|${appInfo.name}|${appInfo.package_id || i}`}
                appInfo={appInfo}
                first={i === 0}
                openFolder={handleOpenFolder}
                requestUninstall={setPendingUninstall}
              />
            ))}
          </div>
        </div>
      )}

      {filtered.length > 0 && groupMode === "publisher" && (
        <div className="space-y-2">
          {grouped.map(([pub, apps]) => (
            <AppGroupSection
              key={pub}
              publisher={pub}
              apps={apps}
              openFolder={handleOpenFolder}
              requestUninstall={setPendingUninstall}
            />
          ))}
        </div>
      )}

      {pendingUninstall && (
        <UninstallModal
          appInfo={pendingUninstall}
          onClose={() => setPendingUninstall(null)}
          onDone={(r) => {
            setActionMsg(
              r.success
                ? `Uninstalled ${pendingUninstall.name}.`
                : `Uninstall failed (exit ${r.exit_code ?? "?"}): ${
                    r.stderr || r.stdout || "unknown error"
                  }`,
            );
            // Refresh in the background so the row disappears on success.
            load(true);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function System() {
  const [subTab, setSubTab] = useState<SystemSubTab>("apps");
  const { features } = useFeatures();
  const hooksEnabled = features.hooks !== false;

  // v2.0 cleanup: with Schedules/Overview gone, there's nothing to refresh
  // at the top-level (Apps / Diagnostics / Hooks each own their own refresh).
  // Keeping the header lean is half the win — no dead spinner, no dead button.

  // Hooks sub-tab delegates the full pane to the Hooks component (header,
  // refresh, side panel — all owned over there).
  if (subTab === "hooks") {
    return (
      <div className="flex h-full flex-col">
        <SystemHeader subTab={subTab} setSubTab={setSubTab} hooksEnabled={hooksEnabled} />
        <div className="flex-1 overflow-auto">
          {hooksEnabled ? (
            <Hooks />
          ) : (
            <div className="px-10 py-8">
              <div
                className="rounded p-6 text-[13px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                Hooks feature is disabled. Enable it from Settings → Features.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <SystemHeader subTab={subTab} setSubTab={setSubTab} hooksEnabled={hooksEnabled} />
      <div className="px-10">
        {subTab === "apps" && <AppsPanel />}
        {subTab === "diagnostics" && <Diagnostics />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner sub-tab header (shared across all System sub-tabs).
// ---------------------------------------------------------------------------

function SystemHeader({
  subTab,
  setSubTab,
  hooksEnabled,
}: {
  subTab: SystemSubTab;
  setSubTab: (t: SystemSubTab) => void;
  hooksEnabled: boolean;
}) {
  const TABS: { id: SystemSubTab; label: string; hidden?: boolean }[] = [
    { id: "apps", label: "Apps" },
    { id: "hooks", label: "Hooks", hidden: !hooksEnabled },
    { id: "diagnostics", label: "Diagnostics" },
  ];
  return (
    <header className="mb-5 flex flex-wrap items-baseline justify-between gap-4 px-10 pt-8">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold leading-tight">System</h1>
        <p
          className="mt-1 text-[13px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Installed apps · Claude Code hooks · on-demand PC diagnostic.
        </p>
        <div
          className="mt-3 inline-flex rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {TABS.filter((t) => !t.hidden).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className="rounded px-3 py-1 text-[12px] font-medium transition-colors"
              style={{
                background: subTab === t.id ? "var(--color-surface-3)" : "transparent",
                color: subTab === t.id ? "var(--color-text)" : "var(--color-text-tertiary)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
