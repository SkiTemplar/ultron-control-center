import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  InstalledApp,
  InstalledAppsReport,
  UninstallAppResult,
} from "../types";
import { Diagnostics } from "./system/Diagnostics";

// v2.7 cleanup (USER audit 2026-05-24):
//   - Bloatware sub-tab DROPPED: most catalog entries weren't present on his
//     box. He wants the same card-driven layout applied to his REAL apps so
//     he can spot abandoned installs instead.
//   - Troubleshooting sub-tab DROPPED: merged into Diagnostics under the
//     new "Diagnostics & Fixes" tab.
//   - Apps panel REDESIGNED: Library-style cartillas grouped by usage
//     category (Development / Games / Media / Productivity / System / Other)
//     with bigger type + horizontal cards. Each app exposes Folder + Uninstall.
//   - Hooks sub-tab REMOVED from System: Hooks now lives exclusively in
//     Library (Library > Hooks). Keeping it in two places caused confusion.
type SystemSubTab = "apps" | "diagnostics";

// ---------------------------------------------------------------------------
// App categorisation heuristic
// ---------------------------------------------------------------------------

type AppCategory =
  | "Development"
  | "Games"
  | "Media"
  | "Productivity"
  | "System utilities"
  | "Other";

const CATEGORY_ORDER: AppCategory[] = [
  "Development",
  "Games",
  "Media",
  "Productivity",
  "System utilities",
  "Other",
];

/** Quick keyword-based classifier. Runs over (name + publisher) so we catch
 *  both "Visual Studio Code" and "Microsoft Corporation" → publisher-based
 *  matches. Cheap and good enough for a first pass. */
function classifyApp(app: InstalledApp): AppCategory {
  const hay = `${app.name} ${app.publisher ?? ""}`.toLowerCase();

  const dev = [
    "visual studio",
    "vscode",
    "code -",
    "intellij",
    "jetbrains",
    "rider",
    "pycharm",
    "webstorm",
    "android studio",
    "git",
    "github",
    "node",
    "npm",
    "python",
    "rust",
    "cargo",
    "docker",
    "postman",
    "insomnia",
    "sourcetree",
    "fork",
    "tortoise",
    "wireshark",
    "vmware",
    "virtualbox",
    "wsl",
    "putty",
    "filezilla",
    "winscp",
    "sublime",
    "notepad++",
    "windows terminal",
    "powershell",
    "tauri",
    "claude code",
    "anthropic",
    "openai",
  ];
  if (dev.some((k) => hay.includes(k))) return "Development";

  const games = [
    "steam",
    "epic games",
    "ubisoft",
    "ea app",
    "ea games",
    "origin",
    "gog galaxy",
    "battle.net",
    "blizzard",
    "rockstar",
    "minecraft",
    "riot",
    "league of legends",
    "valorant",
    "discord",
    "twitch",
    "xbox",
    "nvidia",
    "geforce",
    "razer",
    "logitech g hub",
    "playstation",
  ];
  if (games.some((k) => hay.includes(k))) return "Games";

  const media = [
    "spotify",
    "vlc",
    "obs",
    "kdenlive",
    "davinci",
    "premiere",
    "audacity",
    "photoshop",
    "lightroom",
    "after effects",
    "media player",
    "movies",
    "music",
    "netflix",
    "youtube",
    "plex",
    "kodi",
    "winamp",
    "iTunes",
    "handbrake",
    "krita",
    "gimp",
    "inkscape",
    "blender",
    "figma",
  ];
  if (media.some((k) => hay.includes(k))) return "Media";

  const productivity = [
    "office",
    "word",
    "excel",
    "powerpoint",
    "outlook",
    "onenote",
    "onedrive",
    "teams",
    "slack",
    "zoom",
    "notion",
    "obsidian",
    "evernote",
    "todoist",
    "trello",
    "asana",
    "anki",
    "calibre",
    "acrobat",
    "adobe reader",
    "libreoffice",
    "okular",
    "sumatra",
    "1password",
    "bitwarden",
    "lastpass",
    "keepass",
  ];
  if (productivity.some((k) => hay.includes(k))) return "Productivity";

  const system = [
    "driver",
    "redistributable",
    "runtime",
    "directx",
    "powertoys",
    "7-zip",
    "winrar",
    "rufus",
    "everything",
    "ccleaner",
    "treesize",
    "crystaldiskinfo",
    "hwinfo",
    "msi afterburner",
    "displaylink",
    "logi options",
    "synaptics",
    "realtek",
    "intel",
    "amd ",
    "asus",
    "lenovo",
    "dell",
    "hp ",
  ];
  if (system.some((k) => hay.includes(k))) return "System utilities";

  return "Other";
}

// ---------------------------------------------------------------------------
// Apps panel — Library-style cartillas (one per category) with horizontal,
// large-typography rows. Replaces the old dense grid layout.
// ---------------------------------------------------------------------------

const CATEGORY_DESCRIPTIONS: Record<AppCategory, string> = {
  Development: "IDEs, language runtimes, CLI tooling, git clients, containers.",
  Games: "Game launchers, titles and game-related peripherals.",
  Media: "Streaming, players, image and video editing.",
  Productivity: "Office suites, note-taking, communication, document readers.",
  "System utilities": "Drivers, runtimes, archivers, OEM helpers.",
  Other: "Everything that didn't match a known category.",
};

function classifyAppList(apps: InstalledApp[]): Map<AppCategory, InstalledApp[]> {
  const buckets = new Map<AppCategory, InstalledApp[]>();
  for (const c of CATEGORY_ORDER) buckets.set(c, []);
  for (const a of apps) {
    const cat = classifyApp(a);
    const arr = buckets.get(cat) ?? [];
    arr.push(a);
    buckets.set(cat, arr);
  }
  for (const [, arr] of buckets) {
    arr.sort((x, y) => x.name.localeCompare(y.name));
  }
  return buckets;
}

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
        <div className="mb-2 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
          Uninstall {appInfo.name}?
        </div>
        <div
          className="mb-3 text-[12.5px] leading-snug"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Routes through the {appInfo.provider} uninstaller. Irreversible. Type the app
          name to confirm.
        </div>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={appInfo.name}
          className="w-full rounded px-2 py-1.5 text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            fontFamily: "var(--font-mono)",
          }}
        />
        {error && (
          <div
            className="mt-2 rounded p-2 text-[12px]"
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
            className="rounded px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
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
            className="rounded px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-40"
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

// ---------------------------------------------------------------------------
// Single horizontal app card. Bigger font, more breathing room than the
// previous dense grid row.
// ---------------------------------------------------------------------------

function AppCard({
  app,
  onOpenFolder,
  onUninstall,
}: {
  app: InstalledApp;
  onOpenFolder: (a: InstalledApp) => void;
  onUninstall: (a: InstalledApp) => void;
}) {
  const hasFolder = !!app.install_location;
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2.5"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium" style={{ color: "var(--color-text)" }} title={app.name}>
          {app.name}
        </div>
        <div
          className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {app.publisher && <span className="truncate" title={app.publisher}>{app.publisher}</span>}
          {app.version && <span className="tabular-nums">v{app.version}</span>}
          <span className="uppercase tracking-wide" style={{ color: "var(--color-text-faint)" }}>
            {app.provider}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onOpenFolder(app)}
          disabled={!hasFolder}
          className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-30"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title={hasFolder ? app.install_location! : "No install location reported"}
        >
          Folder
        </button>
        <button
          type="button"
          onClick={() => onUninstall(app)}
          className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
          style={{
            background: "rgba(248, 81, 73, 0.10)",
            color: "var(--color-danger)",
            border: "1px solid rgba(248, 81, 73, 0.32)",
          }}
        >
          Uninstall
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category cartilla — collapsible card that holds every app in the bucket.
// ---------------------------------------------------------------------------

function CategoryCard({
  category,
  apps,
  defaultOpen,
  onOpenFolder,
  onUninstall,
}: {
  category: AppCategory;
  apps: InstalledApp[];
  defaultOpen: boolean;
  onOpenFolder: (a: InstalledApp) => void;
  onUninstall: (a: InstalledApp) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (apps.length === 0) return null;
  return (
    <section
      className="overflow-hidden rounded-lg"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors"
        style={{
          background: "var(--color-surface-2)",
          borderBottom: open ? "1px solid var(--color-border)" : "none",
        }}
      >
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
              {category}
            </span>
            <span
              className="tabular-nums text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {apps.length}
            </span>
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            {CATEGORY_DESCRIPTIONS[category]}
          </div>
        </div>
        <span className="shrink-0 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="grid gap-2 p-3 lg:grid-cols-2 2xl:grid-cols-3">
          {apps.map((a) => (
            <AppCard
              key={`${a.provider}|${a.name}|${a.package_id ?? ""}`}
              app={a}
              onOpenFolder={onOpenFolder}
              onUninstall={onUninstall}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AppsPanel() {
  const [report, setReport] = useState<InstalledAppsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pendingUninstall, setPendingUninstall] = useState<InstalledApp | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Hide Windows / OEM noise by default — same heuristic as v2.7 but kept
  // smaller now that the redesign emphasises real apps.
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
      if (hideSystem) {
        const pid = (a.package_id || "").toLowerCase();
        const publisher = (a.publisher || "").toLowerCase();
        const installLoc = (a.install_location || "").toLowerCase();
        const name = a.name || "";
        const nameLower = name.toLowerCase();
        const isStore = a.provider === "store";

        const isMicrosoftStorePkg =
          pid.startsWith("microsoft.") ||
          pid.startsWith("microsoftcorporationii.") ||
          pid.startsWith("microsoftwindows.") ||
          pid.startsWith("windows.") ||
          (isStore && publisher.includes("microsoft corporation"));

        const isWindowsInstallPath =
          installLoc.includes("\\windows\\system") ||
          installLoc.includes("c:\\windows\\") ||
          installLoc.includes("\\windowsapps\\") ||
          installLoc.includes("\\microsoft\\windowsapps\\");

        const isMicrosoftRuntime =
          /^microsoft visual c\+\+ /i.test(name) ||
          /^microsoft \.net /i.test(name) ||
          /^update for microsoft/i.test(name) ||
          /^security update for/i.test(name) ||
          /\(kb\d{6,}\)/i.test(name) ||
          /^kb\d{6,}\b/i.test(name) ||
          nameLower.includes("redistributable") ||
          nameLower.includes(" runtime");

        const isMicrosoftWindowsComponent =
          publisher.includes("microsoft corporation") &&
          (/\bwindows\b/i.test(name) ||
            /\boffice\b/i.test(name) ||
            /\bonedrive\b/i.test(name) ||
            /\bteams\b/i.test(name) ||
            /\bedge\b/i.test(name) ||
            /\bdefender\b/i.test(name) ||
            /\bonenote\b/i.test(name));

        const isHardwareDriverPublisher =
          publisher.includes("intel corporation") ||
          publisher.includes("nvidia corporation") ||
          publisher.includes("realtek semiconductor") ||
          publisher.includes("advanced micro devices") ||
          /\bamd\b/i.test(publisher) ||
          publisher.includes("synaptics") ||
          publisher.includes("conexant");

        if (
          isMicrosoftStorePkg ||
          isWindowsInstallPath ||
          isMicrosoftRuntime ||
          isMicrosoftWindowsComponent ||
          isHardwareDriverPublisher
        ) {
          return false;
        }
      }
      if (!q) return true;
      const hay = `${a.name} ${a.publisher || ""} ${a.package_id || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [report, query, hideSystem]);

  const grouped = useMemo(() => classifyAppList(filtered), [filtered]);

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
    <section className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by name, publisher, id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-[260px] flex-1 rounded px-3 py-2 text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        />
        <button
          type="button"
          onClick={() => setHideSystem((v) => !v)}
          className="rounded px-3 py-2 text-[12.5px] font-medium transition-colors"
          style={{
            background: hideSystem ? "var(--color-surface-3)" : "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
            color: hideSystem ? "var(--color-text)" : "var(--color-text-tertiary)",
          }}
          title="Hide Microsoft Store + driver / runtime packages"
        >
          {hideSystem ? "Hiding system" : "Show system"}
        </button>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="rounded px-3 py-2 text-[12.5px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {loading ? "Scanning…" : "Refresh"}
        </button>
      </div>

      {report?.cached && (
        <div className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Cached snapshot from {report.generated_at} — hit Refresh to re-scan.
        </div>
      )}

      {error && (
        <div
          className="rounded p-3 text-[12.5px]"
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
          className="rounded p-2 text-[12px]"
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
          className="rounded p-6 text-center text-[13px]"
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

      <div className="space-y-3">
        {CATEGORY_ORDER.map((cat) => {
          const apps = grouped.get(cat) ?? [];
          return (
            <CategoryCard
              key={cat}
              category={cat}
              apps={apps}
              defaultOpen={cat !== "System utilities" && cat !== "Other"}
              onOpenFolder={handleOpenFolder}
              onUninstall={setPendingUninstall}
            />
          );
        })}
      </div>

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
            load(true);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Top-level System tab.
// ---------------------------------------------------------------------------

export function System() {
  const [subTab, setSubTab] = useState<SystemSubTab>("apps");

  return (
    <div className="pb-8">
      <SystemHeader subTab={subTab} setSubTab={setSubTab} />
      <div className="px-10">
        {subTab === "apps" && <AppsPanel />}
        {subTab === "diagnostics" && <Diagnostics />}
      </div>
    </div>
  );
}

function SystemHeader({
  subTab,
  setSubTab,
}: {
  subTab: SystemSubTab;
  setSubTab: (t: SystemSubTab) => void;
}) {
  const TABS: { id: SystemSubTab; label: string }[] = [
    { id: "apps", label: "Apps" },
    { id: "diagnostics", label: "Diagnostics & Fixes" },
  ];
  return (
    <header className="mb-5 flex flex-wrap items-baseline justify-between gap-4 px-10 pt-8">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight">System</h1>
        <p
          className="mt-1 text-[13.5px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Installed apps grouped by usage · on-demand PC diagnostics with one-click fixes.
        </p>
        <div
          className="mt-3 inline-flex rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className="rounded px-3.5 py-1.5 text-[13px] font-medium transition-colors"
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
