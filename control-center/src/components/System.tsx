import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppxQueryResult,
  BloatwareUninstallResult,
  InstalledApp,
  InstalledAppsReport,
  UninstallAppResult,
} from "../types";
import { Hooks } from "./Hooks";
import { Diagnostics } from "./system/Diagnostics";
import { useFeatures } from "../lib/features";
import { confirmDialog } from "../lib/dialog";

// v2.0 cleanup (post USER audit 2026-05-23):
//   - Overview  : DROPPED — duplicates the dashboard health card.
//   - Schedules : DROPPED — USER disabled ULTRON; the only surviving
//                 task (weekly backup) belongs in Settings → Backups.
//   - Apps      : KEEP — extended with search/group-by-publisher; mojibake
//                 fix lives in src-tauri/installed_apps.rs.
//   - Diagnostics : KEEP — redesigned for compact on-demand use.
//   - Hooks     : KEEP — better empty state, grouped by event.
//   - Troubleshooting : NEW — quick-fix commands (moved from Dashboard).
//   - Bloatware (v2.7) : NEW — curated catalog of Appx packages most users
//                want to remove (Xbox, Candy Crush, Mixed Reality, etc.).
//                Backend: appx_query + uninstall_bloatware_app in
//                src-tauri/src/installed_apps.rs.
type SystemSubTab =
  | "apps"
  | "bloatware"
  | "hooks"
  | "diagnostics"
  | "troubleshooting";

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
        className="truncate tabular-nums text-[11.5px]"
        style={{ color: "var(--color-text-secondary)" }}
        title={appInfo.version || ""}
      >
        {appInfo.version || "—"}
      </span>
      <span
        className="truncate text-[11.5px]"
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
  // v2.6 (card-v26-5): hide Windows system defaults by default — Microsoft
  // Store + built-in Microsoft.* packages add ~150 rows of noise the user
  // can't uninstall. Persists per-user.
  const [hideSystem, setHideSystem] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("system.apps.hideSystem");
      return v === null ? true : v === "true";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("system.apps.hideSystem", String(hideSystem));
    } catch {
      /* ignore */
    }
  }, [hideSystem]);

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
      // v2.7 (card-v27-b05): aggressive "Hide Windows apps" heuristic.
      // Goal: hide every Microsoft/OEM package the user did not consciously
      // install (redistributables, .NET, Windows components, drivers, Store
      // built-ins, KB-prefixed updates) WITHOUT hiding real user apps like
      // Chrome, Firefox, Discord, Steam, VS Code, etc.
      //
      // Strategy: a row is "system" if ANY of the following match:
      //   - Microsoft Store appx bundles published by Microsoft itself
      //     (Microsoft.* / MicrosoftCorporationII.* / MicrosoftWindows.* /
      //     Windows.* package ids OR isStore + publisher = Microsoft Corp).
      //   - Lives under C:\Windows\, \WindowsApps\, or \Microsoft\WindowsApps\.
      //   - Name matches Microsoft redistributable / .NET / runtime / update
      //     patterns: "Microsoft Visual C++ ", "Microsoft .NET ",
      //     "Update for Microsoft", "Security Update for", "KB" + 6 digits.
      //   - Publisher = Microsoft Corporation AND name includes one of the
      //     core Windows component keywords (Windows, Office, OneDrive,
      //     Teams, Edge, Defender, OneNote).
      //   - Publisher = hardware vendor (Intel, NVIDIA, Realtek, AMD/Advanced
      //     Micro Devices, Synaptics, Conexant) — almost always drivers.
      //   - Name starts with a hardware-vendor driver prefix (Realtek,
      //     Intel(R), NVIDIA, AMD, Synaptics, Conexant).
      //   - Name contains "redistributable" or "runtime" (case insensitive)
      //     — these are always shipped as dependencies, never installed for
      //     their own sake.
      if (hideSystem) {
        const isStore = a.provider === "store";
        const pid = (a.package_id || "").toLowerCase();
        const publisher = (a.publisher || "").toLowerCase();
        const installLoc = (a.install_location || "").toLowerCase();
        const name = (a.name || "");
        const nameLower = name.toLowerCase();

        // Microsoft Store appx packages published by Microsoft itself.
        const isMicrosoftStorePkg =
          pid.startsWith("microsoft.") ||
          pid.startsWith("microsoftcorporationii.") ||
          pid.startsWith("microsoftwindows.") ||
          pid.startsWith("windows.") ||
          (isStore && publisher.includes("microsoft corporation"));

        // Install location lives under a Windows-owned directory.
        const isWindowsInstallPath =
          installLoc.includes("\\windows\\system") ||
          installLoc.includes("c:\\windows\\") ||
          installLoc.includes("\\windowsapps\\") ||
          installLoc.includes("\\microsoft\\windowsapps\\");

        // Redistributable / .NET / update / KB# names — independent of pub.
        const isMicrosoftRuntime =
          /^microsoft visual c\+\+ /i.test(name) ||
          /^microsoft \.net /i.test(name) ||
          /^update for microsoft/i.test(name) ||
          /^security update for/i.test(name) ||
          /\(kb\d{6,}\)/i.test(name) ||
          /^kb\d{6,}\b/i.test(name) ||
          nameLower.includes("redistributable") ||
          nameLower.includes(" runtime");

        // Microsoft Corporation + a Windows-component keyword in the name.
        const isMicrosoftWindowsComponent =
          publisher.includes("microsoft corporation") &&
          (/\bwindows\b/i.test(name) ||
            /\boffice\b/i.test(name) ||
            /\bonedrive\b/i.test(name) ||
            /\bteams\b/i.test(name) ||
            /\bedge\b/i.test(name) ||
            /\bdefender\b/i.test(name) ||
            /\bonenote\b/i.test(name));

        // Hardware drivers — publisher OR name prefix. We DON'T match on
        // bare "driver" anywhere in the name because plenty of real apps
        // mention drivers in their description.
        const isHardwareDriverPublisher =
          publisher.includes("intel corporation") ||
          publisher.includes("nvidia corporation") ||
          publisher.includes("realtek semiconductor") ||
          publisher.includes("advanced micro devices") ||
          /\bamd\b/i.test(publisher) ||
          publisher.includes("synaptics") ||
          publisher.includes("conexant");

        const isHardwareDriverName =
          /^realtek\b/i.test(name) ||
          /^intel\(r\) /i.test(name) ||
          /^nvidia /i.test(name) ||
          /^amd /i.test(name) ||
          /^synaptics\b/i.test(name) ||
          /^conexant\b/i.test(name);

        const looksLikeSystem =
          isMicrosoftStorePkg ||
          isWindowsInstallPath ||
          isMicrosoftRuntime ||
          isMicrosoftWindowsComponent ||
          isHardwareDriverPublisher ||
          isHardwareDriverName;

        if (looksLikeSystem) return false;
      }
      if (!q) return true;
      const hay = `${a.name} ${a.publisher || ""} ${a.package_id || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [report, query, providerFilter, hideSystem]);

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
        {/* v2.6 (card-v26-5) — Hide Windows system defaults toggle. */}
        <button
          type="button"
          onClick={() => setHideSystem((v) => !v)}
          className="rounded px-2.5 py-1.5 text-[11.5px] font-medium transition-colors"
          style={{
            background: hideSystem
              ? "var(--color-surface-3)"
              : "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
            color: hideSystem
              ? "var(--color-text)"
              : "var(--color-text-tertiary)",
          }}
          title="Hide Microsoft Store + built-in Microsoft.* packages that can't be uninstalled from here"
        >
          {hideSystem ? "Hiding system" : "Show system"}
        </button>
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
// Bloatware panel — curated list of Windows preloaded Appx packages most
// users want to remove. Each entry has a friendly name, a short description
// and an Appx package family name pattern (e.g. "Microsoft.XboxApp" or
// "king.com.CandyCrushSaga"). The backend exposes appx_query (is it
// installed?) and uninstall_bloatware_app (Remove-AppxPackage).
//
// "Protected" packages (Edge, Defender, security center) are listed for
// completeness but the Uninstall button is disabled — Windows blocks the
// removal with TrustedInstaller and the backend refuses them too.
// ---------------------------------------------------------------------------

type BloatwareCategory =
  | "Microsoft Store games"
  | "OEM apps"
  | "Communication"
  | "Mixed Reality"
  | "Misc"
  | "Protected (informational)";

interface BloatwareItem {
  /** Friendly display name. */
  name: string;
  /** Short, one-line description shown under the name. */
  description: string;
  /** Appx package family name pattern (matched against Get-AppxPackage -Name).
   *  Accepts the `*` wildcard. ASCII alphanumerics + `.`, `_`, `-`, `*` only. */
  pattern: string;
  /** When true the Uninstall button is disabled and the row shows a "Protected"
   *  badge — Windows guards these with TrustedInstaller. */
  protected?: boolean;
}

const BLOATWARE_CATALOG: { heading: BloatwareCategory; items: BloatwareItem[] }[] = [
  {
    heading: "Microsoft Store games",
    items: [
      {
        name: "Xbox",
        description: "Xbox companion app — game library, friends, parties.",
        pattern: "Microsoft.XboxApp",
      },
      {
        name: "Xbox Game Bar",
        description: "Overlay invoked with Win+G. Screen capture + perf widgets.",
        pattern: "Microsoft.XboxGamingOverlay",
      },
      {
        name: "Xbox Live",
        description: "Xbox identity provider library used by some store games.",
        pattern: "Microsoft.XboxIdentityProvider",
      },
      {
        name: "Xbox Game Speech Window",
        description: "Voice chat HUD for Xbox titles.",
        pattern: "Microsoft.XboxSpeechToTextOverlay",
      },
      {
        name: "Xbox TCUI",
        description: "Shared Xbox UI primitives. Safe to remove if other Xbox apps are gone.",
        pattern: "Microsoft.Xbox.TCUI",
      },
      {
        name: "Microsoft Solitaire Collection",
        description: "Bundled card game suite with ads.",
        pattern: "Microsoft.MicrosoftSolitaireCollection",
      },
      {
        name: "Mahjong",
        description: "Bundled Microsoft Mahjong game with ads.",
        pattern: "Microsoft.MicrosoftMahjong",
      },
      {
        name: "Minecraft Education",
        description: "Educational edition of Minecraft. Bundled on some Windows SKUs.",
        pattern: "Microsoft.MinecraftEducationEdition",
      },
    ],
  },
  {
    heading: "OEM apps",
    items: [
      {
        name: "Candy Crush Saga",
        description: "Preinstalled mobile match-3 game.",
        pattern: "king.com.CandyCrushSaga",
      },
      {
        name: "Candy Crush Soda Saga",
        description: "Sequel to Candy Crush Saga.",
        pattern: "king.com.CandyCrushSodaSaga",
      },
      {
        name: "Candy Crush Friends",
        description: "Another Candy Crush variant.",
        pattern: "king.com.CandyCrushFriends",
      },
      {
        name: "Disney Magic Kingdoms",
        description: "Gameloft city-builder preinstalled with Windows.",
        pattern: "*DisneyMagicKingdoms*",
      },
      {
        name: "FarmVille 2",
        description: "Preinstalled Zynga farming game.",
        pattern: "*FarmVille2*",
      },
      {
        name: "Bubble Witch 3 Saga",
        description: "Preinstalled match-3 from King.",
        pattern: "king.com.BubbleWitch3Saga",
      },
      {
        name: "March of Empires",
        description: "Preinstalled Gameloft strategy game.",
        pattern: "*MarchofEmpires*",
      },
      {
        name: "Spotify (preinstalled)",
        description: "Preloaded Spotify UWP shim. Skip if you use Spotify daily.",
        pattern: "SpotifyAB.SpotifyMusic",
      },
    ],
  },
  {
    heading: "Communication",
    items: [
      {
        name: "Skype (preinstalled)",
        description: "Preloaded Skype UWP shim. Removing does NOT affect Skype desktop.",
        pattern: "Microsoft.SkypeApp",
      },
      {
        name: "Microsoft Teams (personal)",
        description: "Consumer Teams chat. Different from Teams for Work/School.",
        pattern: "MicrosoftTeams",
      },
      {
        name: "Cortana",
        description: "Windows voice assistant. Removing breaks some Search features.",
        pattern: "Microsoft.549981C3F5F10",
      },
    ],
  },
  {
    heading: "Mixed Reality",
    items: [
      {
        name: "Mixed Reality Portal",
        description: "Entry point for Windows Mixed Reality headsets.",
        pattern: "Microsoft.MixedReality.Portal",
      },
      {
        name: "3D Builder",
        description: "Legacy 3D modeling app — discontinued by Microsoft.",
        pattern: "Microsoft.3DBuilder",
      },
      {
        name: "3D Viewer",
        description: "Preview .glb / .fbx / .obj models. Rarely used.",
        pattern: "Microsoft.Microsoft3DViewer",
      },
      {
        name: "Paint 3D",
        description: "Deprecated 3D paint app. Classic Paint is unaffected.",
        pattern: "Microsoft.MSPaint",
      },
    ],
  },
  {
    heading: "Misc",
    items: [
      {
        name: "Get Help",
        description: "Microsoft support chat shortcut. Mostly used by tech support.",
        pattern: "Microsoft.GetHelp",
      },
      {
        name: "Get Started / Tips",
        description: "First-run tour of Windows features.",
        pattern: "Microsoft.Getstarted",
      },
      {
        name: "Feedback Hub",
        description: "UI to report bugs to Microsoft.",
        pattern: "Microsoft.WindowsFeedbackHub",
      },
      {
        name: "Movies & TV",
        description: "Microsoft Store video player + storefront.",
        pattern: "Microsoft.ZuneVideo",
      },
      {
        name: "Groove Music",
        description: "Deprecated music player (Microsoft.ZuneMusic).",
        pattern: "Microsoft.ZuneMusic",
      },
      {
        name: "Maps",
        description: "Built-in offline maps app.",
        pattern: "Microsoft.WindowsMaps",
      },
      {
        name: "News",
        description: "MSN News reader app.",
        pattern: "Microsoft.BingNews",
      },
      {
        name: "Weather",
        description: "MSN Weather app + live tile.",
        pattern: "Microsoft.BingWeather",
      },
      {
        name: "OneNote (UWP)",
        description: "UWP OneNote shim. OneNote desktop is unaffected.",
        pattern: "Microsoft.Office.OneNote",
      },
    ],
  },
  {
    heading: "Protected (informational)",
    items: [
      {
        name: "Microsoft Edge",
        description: "Default browser. Protected by Windows — cannot be removed here.",
        pattern: "Microsoft.MicrosoftEdge*",
        protected: true,
      },
      {
        name: "Windows Defender",
        description: "Built-in antivirus. Disable via Settings, not by uninstalling.",
        pattern: "Microsoft.WindowsDefender*",
        protected: true,
      },
      {
        name: "Windows Security UI",
        description: "Security & health dashboard. Protected — managed by Windows.",
        pattern: "Microsoft.SecHealthUI*",
        protected: true,
      },
    ],
  },
];

type BloatwareRowState =
  | { kind: "unknown" }
  | { kind: "checking" }
  | { kind: "installed"; matches: string[] }
  | { kind: "absent" }
  | { kind: "error"; message: string };

function BloatwareRow({
  item,
  state,
  busy,
  onCheck,
  onUninstall,
}: {
  item: BloatwareItem;
  state: BloatwareRowState;
  busy: boolean;
  onCheck: () => void;
  onUninstall: () => void;
}) {
  const isProtected = item.protected === true;
  const installed = state.kind === "installed";
  const absent = state.kind === "absent";
  const checking = state.kind === "checking";

  // Status pill colour: green = absent, blue = installed, gray = unknown.
  const pill = isProtected
    ? { bg: "rgba(210, 153, 34, 0.10)", fg: "var(--color-warn)", label: "Protected" }
    : installed
      ? { bg: "rgba(56, 139, 253, 0.12)", fg: "var(--color-accent)", label: "Installed" }
      : absent
        ? { bg: "rgba(63, 185, 80, 0.12)", fg: "var(--color-success)", label: "Not present" }
        : checking
          ? {
              bg: "rgba(187, 187, 187, 0.10)",
              fg: "var(--color-text-tertiary)",
              label: "Checking…",
            }
          : {
              bg: "rgba(187, 187, 187, 0.10)",
              fg: "var(--color-text-tertiary)",
              label: "Not checked",
            };

  return (
    <div
      className="grid items-center gap-3 px-3 py-2 text-[12px]"
      style={{
        gridTemplateColumns: "minmax(0, 2.6fr) 110px minmax(0, 1.2fr) 200px",
        borderTop: "1px solid var(--color-border)",
      }}
    >
      <div className="min-w-0">
        <div
          className="truncate font-medium"
          style={{ color: "var(--color-text)" }}
          title={item.name}
        >
          {item.name}
        </div>
        <div
          className="truncate text-[10.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
          title={item.pattern}
        >
          <span style={{ fontFamily: "var(--font-mono)" }}>{item.pattern}</span>
        </div>
      </div>
      <span
        className="inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
        style={{ background: pill.bg, color: pill.fg }}
      >
        {pill.label}
      </span>
      <div
        className="truncate text-[11.5px]"
        style={{ color: "var(--color-text-secondary)" }}
        title={item.description}
      >
        {item.description}
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCheck}
          disabled={busy || checking}
          className="rounded px-2 py-1 text-[10.5px] font-medium transition-colors disabled:opacity-30"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Check whether this Appx package is installed on this host"
        >
          Check
        </button>
        <button
          type="button"
          onClick={onUninstall}
          disabled={isProtected || busy || absent || state.kind === "unknown"}
          className="rounded px-2 py-1 text-[10.5px] font-medium transition-colors disabled:opacity-30"
          style={{
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
            border: "1px solid rgba(248, 81, 73, 0.32)",
          }}
          title={
            isProtected
              ? "Protected by Windows — cannot be removed from here"
              : absent
                ? "Not installed on this host"
                : state.kind === "unknown"
                  ? "Run Check first to confirm the package is installed"
                  : "Uninstall via Remove-AppxPackage"
          }
        >
          Uninstall
        </button>
      </div>
      {state.kind === "error" && (
        <div
          className="col-span-4 mt-1 rounded p-1.5 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {state.message}
        </div>
      )}
    </div>
  );
}

function BloatwarePanel() {
  const [states, setStates] = useState<Record<string, BloatwareRowState>>({});
  const [busyPattern, setBusyPattern] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const totalItems = useMemo(
    () => BLOATWARE_CATALOG.reduce((acc, c) => acc + c.items.length, 0),
    [],
  );

  async function checkOne(pattern: string) {
    setStates((s) => ({ ...s, [pattern]: { kind: "checking" } }));
    try {
      const r = (await invoke("appx_query", { pattern })) as AppxQueryResult;
      setStates((s) => ({
        ...s,
        [pattern]: r.installed
          ? { kind: "installed", matches: r.matches }
          : { kind: "absent" },
      }));
    } catch (e) {
      setStates((s) => ({ ...s, [pattern]: { kind: "error", message: String(e) } }));
    }
  }

  /** Scan every (non-protected) item in the catalog in series so we don't
   *  spawn 25 PowerShell processes at once. ~1.5s per item × ~25 items ≈
   *  half a minute on a cold host — acceptable for an explicit user action. */
  async function checkAll() {
    setBusyPattern("__all__");
    try {
      for (const cat of BLOATWARE_CATALOG) {
        for (const item of cat.items) {
          if (item.protected) continue;
          // eslint-disable-next-line no-await-in-loop
          await checkOne(item.pattern);
        }
      }
    } finally {
      setBusyPattern(null);
    }
  }

  async function uninstallOne(item: BloatwareItem) {
    if (item.protected) return;
    const state = states[item.pattern];
    if (!state || state.kind !== "installed") return;
    const ok = await confirmDialog(
      `Remove ${item.name} via Remove-AppxPackage?\n\nPattern: ${item.pattern}\n\nThis affects the current user only. Some Microsoft apps are restored automatically after a feature update.`,
      { title: `Uninstall ${item.name}?`, kind: "warning" },
    );
    if (!ok) return;
    setBusyPattern(item.pattern);
    setActionMsg(null);
    try {
      const r = (await invoke("uninstall_bloatware_app", {
        pattern: item.pattern,
      })) as BloatwareUninstallResult;
      if (r.success) {
        const count = r.removed.length;
        setActionMsg(
          count > 0
            ? `Removed ${count} package${count === 1 ? "" : "s"}: ${r.removed.join(", ")}`
            : `${item.name}: nothing to remove (already absent).`,
        );
        setStates((s) => ({ ...s, [item.pattern]: { kind: "absent" } }));
      } else {
        const tail = (r.stderr || r.stdout || "").trim().slice(0, 240);
        setStates((s) => ({
          ...s,
          [item.pattern]: { kind: "error", message: tail || `exit ${r.exit_code ?? "?"}` },
        }));
        setActionMsg(`Uninstall failed for ${item.name}.`);
      }
    } catch (e) {
      setStates((s) => ({
        ...s,
        [item.pattern]: { kind: "error", message: String(e) },
      }));
      setActionMsg(`Uninstall error: ${e}`);
    } finally {
      setBusyPattern(null);
    }
  }

  return (
    <section className="mb-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p
          className="text-[12.5px]"
          style={{ color: "var(--color-text-secondary)", maxWidth: 720 }}
        >
          Curated list of preloaded Windows apps most users want to remove. Click
          <span className="mx-1 font-medium" style={{ color: "var(--color-text)" }}>
            Check
          </span>
          to see which are installed on this host, then
          <span className="mx-1 font-medium" style={{ color: "var(--color-text)" }}>
            Uninstall
          </span>
          to remove via <code style={{ fontFamily: "var(--font-mono)" }}>Remove-AppxPackage</code>.
          Protected Microsoft components (Edge, Defender, Security UI) cannot be
          removed from here.
        </p>
        <button
          type="button"
          onClick={() => void checkAll()}
          disabled={busyPattern !== null}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title="Query Get-AppxPackage for every catalog item (skips protected entries)"
        >
          {busyPattern === "__all__" ? "Checking…" : `Check all (${totalItems})`}
        </button>
      </div>

      {actionMsg && (
        <div
          className="mb-3 rounded p-2 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {actionMsg}
        </div>
      )}

      <div className="space-y-3">
        {BLOATWARE_CATALOG.map((cat) => (
          <div
            key={cat.heading}
            className="overflow-hidden rounded"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div
              className="flex items-baseline justify-between px-3 py-2"
              style={{
                background: "var(--color-surface-1)",
                borderBottom: "1px solid var(--color-border)",
              }}
            >
              <span
                className="text-[12px] font-semibold"
                style={{ color: "var(--color-text)" }}
              >
                {cat.heading}
                <span
                  className="ml-1.5 text-[10.5px] tabular-nums"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  {cat.items.length}
                </span>
              </span>
            </div>
            <div
              className="grid items-center gap-3 px-3 py-1.5 text-[10px] uppercase tracking-[0.06em]"
              style={{
                gridTemplateColumns: "minmax(0, 2.6fr) 110px minmax(0, 1.2fr) 200px",
                background: "var(--color-surface-1)",
                color: "var(--color-text-tertiary)",
                borderBottom: "1px solid var(--color-border)",
              }}
            >
              <span>App</span>
              <span>Status</span>
              <span>Description</span>
              <span className="text-right">Actions</span>
            </div>
            <div>
              {cat.items.map((item) => (
                <BloatwareRow
                  key={item.pattern}
                  item={item}
                  state={states[item.pattern] || { kind: "unknown" }}
                  busy={busyPattern !== null}
                  onCheck={() => void checkOne(item.pattern)}
                  onUninstall={() => void uninstallOne(item)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Troubleshooting panel — quick-fix commands, organized by category.
// Commands are identical to the former Dashboard "Fix common issues" strip;
// here they get category grouping and per-command descriptions.
// ---------------------------------------------------------------------------

type TroubleshootActionId =
  | "pc-flush-dns"
  | "pc-reset-network"
  | "pc-disk-cleanup"
  | "pc-reliability-monitor"
  | "pc-task-manager"
  | "pc-restart-explorer"
  | "pc-clear-temp"
  | "pc-windows-update"
  | "pc-open-hosts";

interface TroubleshootAction {
  id: TroubleshootActionId;
  label: string;
  /** Short inline hint shown below the button. */
  description: string;
  /** Full command or detail shown on hover. */
  detail: string;
  confirm?: { title: string; message: string };
}

interface TroubleshootCategory {
  heading: string;
  actions: TroubleshootAction[];
}

interface MaintenanceResult {
  kind: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  elapsed_ms: number;
}

const TROUBLESHOOT_CATEGORIES: TroubleshootCategory[] = [
  {
    heading: "Network",
    actions: [
      {
        id: "pc-flush-dns",
        label: "Flush DNS cache",
        description:
          "Clears the local DNS resolver cache. Useful after changing hosts file entries or when DNS lookups return stale results.",
        detail: "Runs: ipconfig /flushdns",
      },
      {
        id: "pc-reset-network",
        label: "Reset network adapter",
        description:
          "Resets the Windows TCP/IP stack (netsh int ip reset). Use when you have persistent connectivity issues after reboots. A restart is recommended afterward.",
        detail: "Runs: netsh int ip reset — TCP/IP stack reset.",
        confirm: {
          title: "Reset network adapter?",
          message:
            "This resets the Windows TCP/IP stack. Your current connection will drop and a reboot is recommended afterward. Continue?",
        },
      },
      {
        id: "pc-open-hosts",
        label: "Open hosts file",
        description:
          "Opens C:\\Windows\\System32\\drivers\\etc\\hosts in Notepad. Lets you manually map domain names to IP addresses (useful for local dev overrides).",
        detail: "Opens hosts file in notepad (requires admin to save).",
      },
    ],
  },
  {
    heading: "Storage & Maintenance",
    actions: [
      {
        id: "pc-disk-cleanup",
        label: "Disk Cleanup",
        description:
          "Launches the Windows Disk Cleanup wizard. Lets you safely remove temporary files, Windows Update leftovers, and Recycle Bin contents.",
        detail: "Launches cleanmgr.exe.",
      },
      {
        id: "pc-clear-temp",
        label: "Clear temp files",
        description:
          "Deletes all files inside %TEMP% (your user temp folder). Files currently in use by running applications are skipped automatically.",
        detail: "Deletes %TEMP%\\* (best effort — locked files are skipped).",
        confirm: {
          title: "Clear temporary files?",
          message:
            "Permanently deletes contents of %TEMP%. Locked files (in use by running apps) are skipped. Continue?",
        },
      },
      {
        id: "pc-windows-update",
        label: "Windows Update settings",
        description:
          "Opens the Windows Update settings page so you can check for pending updates, pause updates, or review update history.",
        detail: "Opens ms-settings:windowsupdate.",
      },
    ],
  },
  {
    heading: "Shell & Processes",
    actions: [
      {
        id: "pc-restart-explorer",
        label: "Restart Explorer",
        description:
          "Kills and relaunches explorer.exe. Fixes taskbar glitches, frozen desktop icons, or a missing system tray. All open File Explorer windows will close.",
        detail: "Kills + relaunches explorer.exe.",
        confirm: {
          title: "Restart Explorer?",
          message:
            "This will close and relaunch the Windows shell (taskbar, desktop icons). Any open File Explorer windows will be closed. Continue?",
        },
      },
      {
        id: "pc-task-manager",
        label: "Task Manager",
        description:
          "Opens Task Manager (taskmgr.exe). Use to inspect CPU/RAM usage, kill unresponsive processes, or check startup impact.",
        detail: "Launches taskmgr.exe.",
      },
      {
        id: "pc-reliability-monitor",
        label: "Reliability Monitor",
        description:
          "Opens the Windows Reliability Monitor (perfmon /rel). Shows a per-day timeline of application crashes, hardware failures, and Windows updates.",
        detail: "Runs: perfmon /rel — per-day system stability log.",
      },
    ],
  },
];

function TroubleshootingCategorySection({
  category,
  busy,
  results,
  errors,
  onRun,
}: {
  category: TroubleshootCategory;
  busy: TroubleshootActionId | null;
  results: Record<string, string>;
  errors: Record<string, string>;
  onRun: (a: TroubleshootAction) => void;
}) {
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
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
        style={{
          background: "var(--color-surface-1)",
          borderBottom: open ? "1px solid var(--color-border)" : "none",
        }}
      >
        <span
          className="text-[12.5px] font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          {category.heading}
        </span>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="divide-y" style={{ borderColor: "var(--color-border)" }}>
          {category.actions.map((a) => {
            const running = busy === a.id;
            const ok = results[a.id];
            const err = errors[a.id];
            const dot = err
              ? "var(--color-danger)"
              : ok
                ? "var(--color-success)"
                : "var(--color-text-faint)";

            return (
              <div key={a.id} className="flex items-start gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: dot }}
                    />
                    <span
                      className="text-[13px] font-medium"
                      style={{ color: "var(--color-text)" }}
                    >
                      {a.label}
                    </span>
                    {ok && (
                      <span
                        className="text-[10.5px] tabular-nums"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        {ok}
                      </span>
                    )}
                  </div>
                  <p
                    className="mt-0.5 text-[11.5px] leading-snug"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {a.description}
                  </p>
                  {err && (
                    <div
                      className="mt-1.5 rounded p-1.5 text-[11.5px]"
                      style={{
                        background: "rgba(248, 81, 73, 0.06)",
                        border: "1px solid rgba(248, 81, 73, 0.22)",
                        color: "var(--color-danger)",
                        fontFamily: "var(--font-mono, ui-monospace)",
                      }}
                    >
                      {err}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onRun(a)}
                  disabled={running || busy !== null}
                  title={a.detail}
                  className="shrink-0 rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-60"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                    marginTop: "1px",
                  }}
                >
                  {running ? "Running…" : "Run"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TroubleshootingPanel() {
  const [busy, setBusy] = useState<TroubleshootActionId | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function run(a: TroubleshootAction) {
    if (a.confirm) {
      const ok = await confirmDialog(a.confirm.message, {
        title: a.confirm.title,
        kind: "warning",
      });
      if (!ok) return;
    }
    setBusy(a.id);
    setErrors((p) => {
      const next = { ...p };
      delete next[a.id];
      return next;
    });
    try {
      const r = (await invoke("run_maintenance_command", {
        kind: a.id,
      })) as MaintenanceResult;
      const status = r.success
        ? `ok ${r.elapsed_ms}ms`
        : `exit ${r.exit_code ?? "?"}`;
      setResults((p) => ({ ...p, [a.id]: status }));
      if (!r.success) {
        const tail = (r.stderr || r.stdout || "").trim().slice(0, 180);
        if (tail.length > 0) {
          setErrors((p) => ({ ...p, [a.id]: tail }));
        }
      }
    } catch (e) {
      setErrors((p) => ({ ...p, [a.id]: String(e) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-6">
      <div className="mb-4">
        <p
          className="text-[12.5px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Quick-fix commands for common Windows issues. Each command includes a
          description of what it does. Destructive actions ask for confirmation
          before executing.
        </p>
      </div>
      <div className="space-y-3">
        {TROUBLESHOOT_CATEGORIES.map((cat) => (
          <TroubleshootingCategorySection
            key={cat.heading}
            category={cat}
            busy={busy}
            results={results}
            errors={errors}
            onRun={(a) => void run(a)}
          />
        ))}
      </div>
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
        {subTab === "bloatware" && <BloatwarePanel />}
        {subTab === "diagnostics" && <Diagnostics />}
        {subTab === "troubleshooting" && <TroubleshootingPanel />}
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
    { id: "bloatware", label: "Bloatware" },
    { id: "hooks", label: "Hooks", hidden: !hooksEnabled },
    { id: "diagnostics", label: "Diagnostics" },
    { id: "troubleshooting", label: "Troubleshooting" },
  ];
  return (
    <header className="mb-5 flex flex-wrap items-baseline justify-between gap-4 px-10 pt-8">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold leading-tight">System</h1>
        <p
          className="mt-1 text-[13px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Installed apps · bloatware removal · Claude Code hooks · on-demand PC diagnostic · quick-fix commands.
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
