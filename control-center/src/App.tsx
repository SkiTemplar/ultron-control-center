import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirmDialog } from "./lib/dialog";
import { notify } from "./lib/notify";
import { Sidebar, TAB_LABELS, type Tab } from "./components/Sidebar";
import { Dashboard } from "./components/Dashboard";
import { Changelog } from "./components/Changelog";
import { Notifications } from "./components/Notifications";
import { MCPs } from "./components/MCPs";
import { Library, type LibrarySubTab } from "./components/Library";
import { Notes } from "./components/Notes";
import { Lab } from "./components/Lab";
import { SessionsZone } from "./components/sessions/SessionsZone";
import { Usage } from "./components/Usage";
import { AIRouterPage } from "./components/AIRouter";
import { Settings, SETTINGS_SECTION_KEY } from "./components/Settings";
import { Projects } from "./components/Projects";
import { ProjectsTabsProvider, useProjectsTabs } from "./state/ProjectsTabsContext";
import TabsBar from "./components/projects/TabsBar";
import ProjectWorkspace from "./components/projects/ProjectWorkspace";
import { PortfolioView } from "./components/portfolio/PortfolioView";
import { System } from "./components/System";
import { Plans } from "./components/Plans";
// Finance is a local-only feature (datos bancarios locales; Finance.tsx is
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
import { PopupHost } from "./components/PopupHost";
import { Onboarding, OPEN_ONBOARDING_EVENT } from "./components/Onboarding";
// Hooks is now rendered inside the System tab as an inner sub-tab (v15.2 F7).
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { UpdateBanner } from "./components/UpdateBanner";
import { computeGlobalStatus } from "./lib/status";
import { TabErrorBoundary } from "./components/TabErrorBoundary";
import { setupTrayEventListeners } from "./lib/tauri-events";
import type { AlertEntry, ChangelogEntry } from "./types";
import {
  maintenancePaletteActions,
  rebuildPaletteAction,
  type MaintenanceCommand,
} from "./components/palette/systemPaletteActions";

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

  // Abre el workspace de un proyecto igual que la rejilla de Projects: pestaña
  // del proyecto en la tira y salto a Projects (lo usa Portfolio → «Abrir»).
  const openProjectWorkspace = useCallback(
    (id: string, title: string) => {
      open({ id, title });
      setTab("projects");
    },
    [open],
  );

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
      const msg = e.message || (e.error && String(e.error)) || "error desconocido";
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
  //   tab.<dashboard|usage|notifications|sessions|projects|plans|skills|logs|settings>
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
  }, []);

  // Custom per-project hotkeys (hand-edited in ~/.ultron/cockpit/project-hotkeys.json;
  // the Settings editor was retired).
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

  // Clic derecho en Pupus → «Ajustes»: abre Settings en su sección. La
  // sección viaja por sessionStorage porque Settings se monta después.
  useEffect(() => {
    const unlisten = listen("mascot:open-settings", () => {
      sessionStorage.setItem(SETTINGS_SECTION_KEY, "mascot");
      window.dispatchEvent(new Event(SETTINGS_SECTION_KEY));
      setTab("settings");
    });
    return () => {
      void unlisten.then((fn) => fn());
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
  }, []);

  const globalStatus = computeGlobalStatus(alerts);

  // v15.3.7 — Command palette gets the full ULTRON system surface.
  // Maintenance commands are pulled dynamically from the backend so the
  // palette stays in sync with whatever `list_maintenance_commands_inner`
  // returns (no hardcoded duplicate list). Everything else is static.
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
        message: `${label} ha fallado: ${msg}`.slice(0, 600),
      });
    }
  }

  const extraPaletteActions: PaletteAction[] = useMemo(() => {
    const list: PaletteAction[] = [];

    // -- Actions (refresh / settings / close) -------------------------
    list.push({
      id: "refresh",
      label: "Actualizar los datos del panel",
      description: "Vuelve a leer las alertas y las notas de versión.",
      group: "Acciones",
      shortcut: "Ctrl+R",
      run: () => void refreshAll(),
    });
    list.push({
      id: "settings",
      label: "Abrir Ajustes",
      group: "Acciones",
      shortcut: "Ctrl+,",
      run: () => setTab("settings"),
    });
    list.push({
      id: "show-onboarding",
      label: "Mostrar la pantalla de bienvenida",
      description: "Reabre el resumen inicial de las pestañas principales.",
      group: "Acciones",
      run: () => window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT)),
    });
    list.push({
      id: "close-control-center",
      label: "Cerrar Control Center",
      description: "Sale del todo de la aplicación (no la minimiza a la bandeja). Libera los bloqueos de ficheros.",
      group: "Acciones",
      run: async () => {
        const ok = await confirmDialog(
          "¿Cerrar ULTRON Control Center? Los atajos globales dejan de funcionar hasta que vuelvas a abrirlo.",
          { title: "Cerrar Control Center", kind: "warning" },
        );
        if (ok) void runQuiet("Cerrar Control Center", "close_control_center");
      },
    });

    // -- Diagnostics --------------------------------------------------
    // P6: legacy run_doctor / run_diagnose entries were removed when the
    // native diagnostic UI shipped under System -> Diagnostics. A single
    // navigation shortcut keeps the palette discoverable.
    list.push({
      id: "diag.native",
      label: "Abrir el diagnóstico del sistema",
      description: "Diagnóstico nativo del PC (sysinfo + wmi) con análisis por IA.",
      group: "Diagnóstico",
      run: () => setTab("system"),
    });
    // -- AI sessions --------------------------------------------------
    list.push({
      id: "ai.sessions-window",
      label: "Abrir la ventana de ULTRON Sessions",
      description: "La ventana de chat aparte (no la pestaña Monitor de sesiones).",
      group: "IA",
      run: () =>
        void runQuiet("Abrir ULTRON Sessions", "sesiones_open_window", {
          projectId: null,
        }),
    });
    list.push({
      id: "ai.spawn.claude",
      label: "Lanzar una sesión de Claude",
      description: "Abre una terminal nueva de Claude Code (prompt por portapapeles).",
      group: "IA",
      run: () =>
        void runQuiet("Lanzar Claude", "spawn_session", {
          provider: "claude",
          prompt: null,
        }),
    });
    list.push({
      id: "ai.spawn.codex",
      label: "Lanzar una sesión de Codex",
      description: "Lanza el CLI de Codex (autenticación con la suscripción de ChatGPT).",
      group: "IA",
      run: () =>
        void runQuiet("Lanzar Codex", "spawn_session", {
          provider: "codex",
          prompt: null,
        }),
    });
    // -- Maintenance (pulled dynamically from the backend) ------------
    // The backend's `list_maintenance_commands_inner` is the source of
    // truth. Whenever a new MaintenanceCommand is added there it shows
    // up here automatically — no duplicate frontend list to keep in sync.
    // Destructive entries ask first and every result (also success:false)
    // is shown: see components/palette/systemPaletteActions.ts.
    list.push(...maintenancePaletteActions(maintenanceCommands));

    // -- System / lifecycle ------------------------------------------
    // Same canonical flow as Settings → Recompilar (rebuildFlow).
    list.push(rebuildPaletteAction());
    list.push({
      id: "sys.uninstall",
      label: "Desinstalar ULTRON",
      description: "Ejecuta el script de desinstalación en una ventana nueva (pide confirmación).",
      group: "Sistema",
      run: async () => {
        const ok = await confirmDialog(
          "¿Abrir el desinstalador? Te guía para quitar ULTRON.",
          { title: "Desinstalar ULTRON", kind: "warning" },
        );
        if (ok)
          void runQuiet("Desinstalar", "run_app_lifecycle", { kind: "uninstall" });
      },
    });
    list.push({
      id: "sys.purge-autostart",
      label: "Limpiar entradas antiguas de arranque automático",
      description: "Quita las entradas Run y los accesos de Inicio que dejaron instalaciones anteriores.",
      group: "Sistema",
      run: () => void runQuiet("Limpiar el arranque automático", "purge_legacy_autostart"),
    });
    list.push({
      id: "sys.scan-projects",
      label: "Escanear proyectos",
      description: "Vuelve a recorrer las carpetas de proyectos para que el lanzador vea las nuevas.",
      group: "Sistema",
      run: () => void runQuiet("Escanear proyectos", "scan_projects"),
    });

    return list;
  }, [maintenanceCommands]);

  // Only the active tab is mounted. Its error boundary is keyed by tab, so a
  // crash in one tab resets on navigation instead of covering every other
  // tab, and the message names the tab that actually failed.
  function renderTab(): React.ReactNode {
    switch (tab) {
      case "dashboard":
        return <Dashboard globalStatus={globalStatus} onNavigate={setTab} />;
      case "notifications":
        return <Notifications alerts={alerts} onDeleted={refreshAll} />;
      case "changelog":
        return <Changelog entries={changelog} />;
      case "mcps":
        return <MCPs />;
      case "library":
      case "skills":
      case "agents":
      case "rules":
        return (
          <Library
            key={tab}
            initial={tab === "library" ? undefined : (tab as LibrarySubTab)}
          />
        );
      case "notes":
        return <Notes />;
      case "lab":
        return <Lab />;
      case "sessions":
        return (
          <SessionsZone
            onOpenProject={(id) => {
              open({ id, title: id });
              setTab("projects");
            }}
          />
        );
      case "usage":
        return <Usage />;
      case "ai-router":
        return <AIRouterPage />;
      case "settings":
        return <Settings />;
      case "projects":
        return <ProjectsPane />;
      case "portfolio":
        return <PortfolioView onOpenProject={openProjectWorkspace} />;
      case "finance":
        return FINANCE_ENABLED && FinanceLazy ? (
          <React.Suspense fallback={null}>
            <FinanceLazy />
          </React.Suspense>
        ) : null;
      case "system":
        return <System />;
      case "plans":
        return <Plans />;
    }
  }

  return (
    <div className="flex h-full">
      <Sidebar
        active={tab}
        onSelect={setTab}
        globalStatus={globalStatus}
        lastProjectCtx={tab !== "projects" ? lastProjectCtx : null}
        onGoBack={goBackToProject}
      />
      {/* The update banner takes its own height and <main> the rest, so each
          tab keeps a single scroll container. Popups anchor to this column,
          clear of the sidebar. */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <UpdateBanner />
        <main className="min-h-0 flex-1 overflow-auto">
          <TabErrorBoundary key={tab} tab={TAB_LABELS[tab]}>
            {renderTab()}
          </TabErrorBoundary>
        </main>
        <PopupHost />
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(t) => setTab(t)}
        extraActions={extraPaletteActions}
      />
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
      {/* v2.7.2 — el wrapper era `overflow-hidden` para las dos ramas. El
          workspace lo necesita (gestiona su propio scroll interno), pero la
          home de Projects NO: con la ventana pequeña la rejilla medía 3000px
          dentro de una caja de 589px recortada y sin scroll, asi que las
          tarjetas de abajo eran inalcanzables (medido con 15 proyectos a
          900x620). Scroll vertical solo en la rama home. */}
      <div className={`min-h-0 flex-1 ${currentId === "home" ? "overflow-y-auto" : "overflow-hidden"}`}>
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
