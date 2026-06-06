import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirmDialog } from "./lib/dialog";
import { notify } from "./lib/notify";
import { Sidebar, type Tab } from "./components/Sidebar";
import { Dashboard } from "./components/Dashboard";
import { Changelog } from "./components/Changelog";
import { Notifications } from "./components/Notifications";
import { MCPs } from "./components/MCPs";
import { Library, type LibrarySubTab } from "./components/Library";
import { Notes } from "./components/Notes";
import { Sessions } from "./components/Sessions";
import { Usage } from "./components/Usage";
import { AIRouterPage } from "./components/AIRouter";
import { Settings } from "./components/Settings";
import { Projects } from "./components/Projects";
import { ProjectsTabsProvider, useProjectsTabs } from "./state/ProjectsTabsContext";
import TabsBar from "./components/projects/TabsBar";
import ProjectWorkspace from "./components/projects/ProjectWorkspace";
import { System } from "./components/System";
import { Plans } from "./components/Plans";
// Finance is a local-only feature (personal KutxaBank data; Finance.tsx is
// excluded from the public repo via .gitignore). Enable at build time with
// the env var VITE_FINANCE=1. When the flag is absent the lazy import is
// never attempted and the Finance tab is hidden in the Sidebar.
const FINANCE_ENABLED = import.meta.env.VITE_FINANCE === "1";
// import.meta.glob (build-time): Vite empaqueta Finance.tsx en su propio chunk
// CUANDO el archivo esta presente (build local). Cuando Finance.tsx esta ausente
// (repo publico) el glob resuelve a un mapa vacio -> sin error de build y sin
// fetch en runtime de un modulo inexistente. Esto sustituye el anterior
// @vite-ignore + ruta-en-variable, que le decia a Vite que NO empaquetara el
// chunk y provocaba un 404 en runtime ("Failed to fetch dynamically imported
// module .../assets/components/Finance") al abrir la pestana Finance.
const financeLoaders = import.meta.glob("./components/Finance.tsx");
const financeLoader = financeLoaders["./components/Finance.tsx"];
const FinanceLazy =
  FINANCE_ENABLED && financeLoader
    ? React.lazy(() =>
        financeLoader().then((m) => ({
          default: (m as { Finance: React.ComponentType }).Finance,
        })),
      )
    : null;
import { MemoryInbox } from "./components/MemoryInbox";
import { PopupHost } from "./components/PopupHost";
import { Onboarding } from "./components/Onboarding";
// Hooks is now rendered inside the System tab as an inner sub-tab (v15.2 F7).
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { UpdateBanner } from "./components/UpdateBanner";
import { computeGlobalStatus } from "./lib/status";
import { TabErrorBoundary } from "./components/TabErrorBoundary";
import { setupTrayEventListeners } from "./lib/tauri-events";
import type { AlertEntry, ChangelogEntry } from "./types";

export default function App() {
  return (
    <ProjectsTabsProvider>
      <AppInner />
    </ProjectsTabsProvider>
  );
}

function AppInner() {
  const [tab, setTab] = useState<Tab>("projects");
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { currentId, tabs, select, open } = useProjectsTabs();
  const [lastProjectCtx, setLastProjectCtx] = useState<{
    id: string; title: string; subTab: string;
  } | null>(null);
  const prevTabRef = useRef<Tab>("projects");

  useEffect(() => {
    if (prevTabRef.current === "projects" && tab !== "projects" && currentId !== "home") {
      const found = tabs.find((t) => t.id === currentId);
      if (found) {
        // Board is the only project view now (fullize 2026-06-01).
        setLastProjectCtx({ id: currentId, title: found.title, subTab: "board" });
      }
    }
    prevTabRef.current = tab;
  }, [tab, currentId, tabs]);

  function goBackToProject() {
    if (!lastProjectCtx) return;
    const exists = tabs.some((t) => t.id === lastProjectCtx.id);
    if (!exists) { setLastProjectCtx(null); setTab("projects"); return; }
    select(lastProjectCtx.id);
    setTab("projects");
  }

  async function refreshAll() {
    try {
      const al = (await invoke("read_alerts", { limit: 200 })) as AlertEntry[];
      setAlerts(al);
    } catch {
      setAlerts([]);
    }
    try {
      const cl = (await invoke("read_changelog", { limit: 100 })) as ChangelogEntry[];
      setChangelog(cl);
    } catch {
      setChangelog([]);
    }
  }

  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 15_000);
    return () => clearInterval(t);
  }, []);

  // Capture frontend errors and surface them app-wide. Without this, JS
  // exceptions / unhandled rejections die silently in the webview and the
  // user has no idea something broke. `notify()` both pops an immediate
  // in-app toast and records the error to alerts.jsonl so the
  // Notifications tab keeps a durable copy.
  useEffect(() => {
    let lastFingerprint = "";
    let lastTs = 0;
    function report(severity: "warn" | "critical", source: string, message: string) {
      const trimmed = message.slice(0, 600);
      const fingerprint = `${source}::${trimmed}`;
      const now = Date.now();
      // Throttle identical errors — Tauri devtools can chain the same
      // exception multiple times.
      if (fingerprint === lastFingerprint && now - lastTs < 5000) return;
      lastFingerprint = fingerprint;
      lastTs = now;
      notify({ severity, source, message: trimmed });
    }
    const onError = (e: ErrorEvent) => {
      const msg = e.message || (e.error && String(e.error)) || "unknown error";
      report("critical", "ui.error", `${msg} @ ${e.filename}:${e.lineno}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      report("warn", "ui.promise", msg);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // In-app keyboard shortcuts. The OS-wide Ctrl+Alt+U lives in the Rust
  // setup; the bindings below are window-scoped. Bindings now live in
  // ~/.ultron/.tmp/in-app-shortcuts.json and are editable via Settings →
  // General → In-app shortcuts. The map below is a runtime mirror we
  // refresh on mount + whenever Settings persists a change (via the
  // "in-app-shortcuts-updated" event the Settings panel emits).
  //
  // Action keys recognised here (must match defaults in the Rust module
  // `in_app_shortcuts::default_bindings`):
  //   command.palette · open.settings · refresh.all
  //   tab.<dashboard|usage|notifications|sessions|projects|plans|memory|skills|logs|settings>
  const bindingsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const map = (await invoke("get_in_app_shortcuts")) as Record<
          string,
          string
        >;
        if (!cancelled) bindingsRef.current = map ?? {};
      } catch (err) {
        console.warn("[ultron] get_in_app_shortcuts failed", err);
      }
    }
    void load();
    const handler = () => void load();
    window.addEventListener("in-app-shortcuts-updated", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("in-app-shortcuts-updated", handler);
    };
  }, []);

  useEffect(() => {
    const teardownPromise = setupTrayEventListeners({ setTab });
    return () => {
      teardownPromise.then((teardown) => teardown());
    };
  }, []);

  // Reattach: cuando una ventana detached se cierra el backend emite
  // "project:window-closed" con { projectId, label }. Reabrimos el tab en la
  // ventana principal para que el usuario pueda retomar el trabajo aquí.
  //
  // audit verify-audit-2 rank2: sustituimos el patrón cancelled+unlisten por
  // useRef<Promise> para cerrar la race condition donde el unmount ocurre tras
  // resolver la promesa pero antes de que unlisten quede asignado.
  const _unlistenWindowClosed = useRef<Promise<() => void> | null>(null);
  useEffect(() => {
    _unlistenWindowClosed.current = listen<{ projectId: string; label: string }>(
      "project:window-closed",
      (event) => {
        const { projectId } = event.payload ?? {};
        if (!projectId) return;
        // open() es idempotente si el tab ya existe (no duplica).
        // Necesitamos el título: intentamos encontrarlo en los tabs abiertos;
        // si no existe usamos el id como fallback.
        open({ id: projectId, title: projectId });
        select(projectId);
        setTab("projects");
      },
    );
    return () => {
      void _unlistenWindowClosed.current?.then((fn) => fn());
    };
  // open y select son callbacks estables (useCallback sin deps cambiantes).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Custom per-project hotkeys (defined in Settings → Project hotkeys).
  // Backend emits "project-hotkey-custom" with { slot, project_id, combo }.
  // Behaviour: open Control Center on the Projects tab, then invoke
  // open_project so the user lands on the configured project ready to go.
  //
  // audit verify-audit-2 rank2: mismo patrón useRef<Promise> que el listener
  // de project:window-closed — elimina la race entre unmount y resolución de
  // la promesa de registro.
  const _unlistenHotkeyCustom = useRef<Promise<() => void> | null>(null);
  useEffect(() => {
    _unlistenHotkeyCustom.current = listen<{ slot: number; project_id: string; combo: string }>(
      "project-hotkey-custom",
      async (event) => {
        const pid = event.payload?.project_id;
        if (!pid) return;
        setTab("projects");
        try {
          await invoke("open_project", { id: pid });
        } catch (err) {
          console.error("[ultron] custom project hotkey open_project failed", err);
        }
      },
    );
    return () => {
      void _unlistenHotkeyCustom.current?.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    // Parse a stored combo string ("Ctrl+Alt+K", "Alt+1", ...) into a
    // predicate against a KeyboardEvent. Returns null when the combo is
    // unparseable so it's silently ignored rather than throwing.
    function matchCombo(combo: string, e: KeyboardEvent): boolean {
      const parts = combo
        .split("+")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
      if (parts.length === 0) return false;
      let needCtrl = false;
      let needAlt = false;
      let needShift = false;
      let needMeta = false;
      let keyPart: string | null = null;
      for (const p of parts) {
        if (p === "ctrl" || p === "control") needCtrl = true;
        else if (p === "alt" || p === "option") needAlt = true;
        else if (p === "shift") needShift = true;
        else if (p === "meta" || p === "super" || p === "win" || p === "cmd")
          needMeta = true;
        else keyPart = p;
      }
      if (!keyPart) return false;
      if (e.ctrlKey !== needCtrl) return false;
      if (e.altKey !== needAlt) return false;
      if (e.shiftKey !== needShift) return false;
      if (e.metaKey !== needMeta) return false;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
      return k === keyPart;
    }

    function isTypingTarget(active: Element | null): boolean {
      const tag = active?.tagName?.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        (active as HTMLElement | null)?.isContentEditable === true
      );
    }

    function onKey(e: KeyboardEvent) {
      const b = bindingsRef.current;
      if (!b || Object.keys(b).length === 0) return;

      // Palette / settings / refresh — always active, even inside inputs
      // because the historical behaviour was Ctrl+K etc. swallows the
      // input chord anyway.
      if (b["command.palette"] && matchCombo(b["command.palette"], e)) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (b["open.settings"] && matchCombo(b["open.settings"], e)) {
        e.preventDefault();
        setTab("settings");
        return;
      }
      if (b["refresh.all"] && matchCombo(b["refresh.all"], e)) {
        e.preventDefault();
        refreshAll();
        return;
      }

      // Tab jumps — suppressed while typing so they don't eat keystrokes.
      if (isTypingTarget(document.activeElement)) return;

      const TAB_ACTIONS: [string, Tab][] = [
        ["tab.dashboard", "dashboard"],
        ["tab.usage", "usage"],
        ["tab.notifications", "notifications"],
        ["tab.sessions", "sessions"],
        ["tab.projects", "projects"],
        ["tab.plans", "plans"],
        ["tab.skills", "skills"],
        ["tab.settings", "settings"],
      ];
      for (const [actionKey, tabKey] of TAB_ACTIONS) {
        const combo = b[actionKey];
        if (combo && matchCombo(combo, e)) {
          e.preventDefault();
          setTab(tabKey);
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const globalStatus = computeGlobalStatus(alerts);

  // v15.3.7 — Command palette gets the full ULTRON system surface.
  // Maintenance commands are pulled dynamically from the backend so the
  // palette stays in sync with whatever `list_maintenance_commands_inner`
  // returns (no hardcoded duplicate list). Everything else is static.
  type MaintenanceCommand = {
    kind: string;
    label: string;
    description: string;
    group: string;
  };
  const [maintenanceCommands, setMaintenanceCommands] = useState<
    MaintenanceCommand[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = (await invoke(
          "list_maintenance_commands",
        )) as MaintenanceCommand[];
        if (!cancelled) setMaintenanceCommands(list ?? []);
      } catch (err) {
        console.warn("[ultron] list_maintenance_commands failed", err);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Helper: fire-and-forget invoke that surfaces failures via notify() —
  // an immediate in-app toast (so the user knows the command broke right
  // away, on any tab) plus a durable row in the Notifications tab. Before
  // notify(), a failed palette command only landed in alerts.jsonl and
  // the user just saw "nothing happened".
  async function runQuiet(label: string, cmd: string, args?: Record<string, unknown>) {
    try {
      await invoke(cmd, args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify({
        severity: "warn",
        source: "palette",
        message: `${label} failed: ${msg}`.slice(0, 600),
      });
    }
  }

  const extraPaletteActions: PaletteAction[] = useMemo(() => {
    const list: PaletteAction[] = [];

    // -- Actions (refresh / settings / close) -------------------------
    list.push({
      id: "refresh",
      label: "Refresh dashboard data",
      description: "Re-pull alerts and changelog.",
      group: "Actions",
      shortcut: "Ctrl+R",
      run: () => void refreshAll(),
    });
    list.push({
      id: "settings",
      label: "Open Settings",
      group: "Actions",
      shortcut: "Ctrl+,",
      run: () => setTab("settings"),
    });
    list.push({
      id: "close-control-center",
      label: "Close Control Center",
      description: "Fully exit the app (not minimize to tray). Frees file locks.",
      group: "Actions",
      run: async () => {
        const ok = await confirmDialog(
          "Close ULTRON Control Center? Global hotkeys stop until you relaunch.",
          { title: "Close Control Center", kind: "warning" },
        );
        if (ok) void runQuiet("Close Control Center", "close_control_center");
      },
    });

    // -- Diagnostics --------------------------------------------------
    // P6: legacy run_doctor / run_diagnose entries were removed when the
    // native diagnostic UI shipped under System -> Diagnostics. A single
    // navigation shortcut keeps the palette discoverable.
    list.push({
      id: "diag.native",
      label: "Open System Diagnostics",
      description: "Native PC diagnostic (sysinfo + wmi) with AI analysis.",
      group: "Diagnostics",
      run: () => setTab("system"),
    });
    // -- AI sessions --------------------------------------------------
    list.push({
      id: "ai.spawn.claude",
      label: "Spawn Claude session",
      description: "Open a new Claude Code terminal (clipboard prompt mode).",
      group: "AI",
      run: () =>
        void runQuiet("Spawn Claude", "spawn_session", {
          provider: "claude",
          prompt: null,
        }),
    });
    list.push({
      id: "ai.spawn.codex",
      label: "Spawn Codex session",
      description: "Launch the Codex CLI (ChatGPT subscription auth).",
      group: "AI",
      run: () =>
        void runQuiet("Spawn Codex", "spawn_session", {
          provider: "codex",
          prompt: null,
        }),
    });
    list.push({
      id: "ai.spawn.gemini",
      label: "Spawn Gemini session",
      description: "Launch the Gemini CLI (Google OAuth, long-context).",
      group: "AI",
      run: () =>
        void runQuiet("Spawn Gemini", "spawn_session", {
          provider: "gemini",
          prompt: null,
        }),
    });

    // -- Maintenance (pulled dynamically from the backend) ------------
    // The backend's `list_maintenance_commands_inner` is the source of
    // truth. Whenever a new MaintenanceCommand is added there it shows
    // up here automatically — no duplicate frontend list to keep in sync.
    for (const m of maintenanceCommands) {
      list.push({
        id: `maint.${m.kind}`,
        label: m.label,
        description: m.description,
        group: `Maintenance (${m.group})`,
        run: () =>
          void runQuiet(m.label, "run_maintenance_command", { kind: m.kind }),
      });
    }

    // -- System / lifecycle ------------------------------------------
    list.push({
      id: "sys.rebuild",
      label: "Rebuild Control Center",
      description: "Spawn `npm run tauri build` in a new window.",
      group: "System",
      run: () =>
        void runQuiet("Rebuild", "run_app_lifecycle", { kind: "update" }),
    });
    list.push({
      id: "sys.uninstall",
      label: "Uninstall ULTRON",
      description: "Run the uninstall script in a new window (asks for confirmation).",
      group: "System",
      run: async () => {
        const ok = await confirmDialog(
          "Open the uninstaller? This walks you through removing ULTRON.",
          { title: "Uninstall ULTRON", kind: "warning" },
        );
        if (ok)
          void runQuiet("Uninstall", "run_app_lifecycle", { kind: "uninstall" });
      },
    });
    list.push({
      id: "sys.purge-autostart",
      label: "Purge legacy autostart entries",
      description: "Remove stale Run-key / Startup shim left by older installs.",
      group: "System",
      run: () => void runQuiet("Purge autostart", "purge_legacy_autostart"),
    });
    list.push({
      id: "sys.scan-projects",
      label: "Scan projects",
      description: "Re-scan project folders so the launcher picks up new entries.",
      group: "System",
      run: () => void runQuiet("Scan projects", "scan_projects"),
    });

    return list;
  }, [maintenanceCommands]);

  return (
    <div className="flex h-full">
      <Sidebar
        active={tab}
        onSelect={setTab}
        globalStatus={globalStatus}
        lastProjectCtx={tab !== "projects" ? lastProjectCtx : null}
        onGoBack={goBackToProject}
      />
      <main className="flex-1 overflow-auto">
        <UpdateBanner />
        <TabErrorBoundary tab="dashboard">
          {tab === "dashboard" && (
            <Dashboard
              globalStatus={globalStatus}
              onNavigate={setTab}
            />
          )}
        </TabErrorBoundary>
        <TabErrorBoundary tab="notifications">
          {tab === "notifications" && (
            <Notifications alerts={alerts} onDeleted={refreshAll} />
          )}
        </TabErrorBoundary>
        <TabErrorBoundary tab="changelog">
          {tab === "changelog" && <Changelog entries={changelog} />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="mcps">
          {tab === "mcps" && <MCPs />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="library">
          {(tab === "library" ||
            tab === "skills" ||
            tab === "agents" ||
            tab === "rules") && (
            <Library
              key={tab}
              initial={tab === "library" ? undefined : (tab as LibrarySubTab)}
            />
          )}
        </TabErrorBoundary>
        <TabErrorBoundary tab="notes">
          {tab === "notes" && <Notes />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="sessions">
          {tab === "sessions" && <Sessions />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="usage">
          {tab === "usage" && <Usage />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="ai-router">
          {tab === "ai-router" && <AIRouterPage />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="settings">
          {tab === "settings" && <Settings onNavigate={(t) => setTab(t as Tab)} />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="projects">
          {tab === "projects" && <ProjectsPane />}
        </TabErrorBoundary>
        {FINANCE_ENABLED && FinanceLazy && (
          <TabErrorBoundary tab="finance">
            {tab === "finance" && (
              <React.Suspense fallback={null}>
                <FinanceLazy />
              </React.Suspense>
            )}
          </TabErrorBoundary>
        )}
        <TabErrorBoundary tab="memory">
          {tab === "memory" && <MemoryInbox />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="system">
          {tab === "system" && <System />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="plans">
          {tab === "plans" && <Plans />}
        </TabErrorBoundary>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(t) => setTab(t)}
        extraActions={extraPaletteActions}
      />
      <PopupHost />
      <Onboarding />
    </div>
  );
}

// ---------------------------------------------------------------------------
// P4: Projects pane — renders the browser-style tab strip + the active
// project workspace, or the legacy Projects home component when the "Projects"
// tab is selected.
// ---------------------------------------------------------------------------

function ProjectsPane() {
  const { currentId, open } = useProjectsTabs();
  return (
    <div className="flex h-full flex-col">
      <TabsBar />
      <div className="flex-1 overflow-hidden">
        {currentId === "home" ? (
          <Projects
            onOpenProject={(p) => open({ id: p.id, title: p.name })}
          />
        ) : (
          <ProjectWorkspace key={currentId} projectId={currentId} />
        )}
      </div>
    </div>
  );
}
