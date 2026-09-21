import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirmDialog } from "./lib/dialog";
import { notify } from "./lib/notify";
import { Sidebar, type Tab } from "./components/Sidebar";
import { Notifications } from "./components/Notifications";
import { MCPs } from "./components/MCPs";
import { Library, type LibrarySubTab } from "./components/Library";
import { SessionsZone } from "./components/sessions/SessionsZone";
import { Conversations } from "./components/Conversations";
import { HudBackground, HudTopBar, useVoice } from "./components/jarvis/HudFrame";
import { MariaHome } from "./components/jarvis/MariaHome";
import { MariaChat } from "./components/jarvis/MariaChat";
import { Terminals } from "./components/jarvis/Terminals";
import { Mosaico } from "./components/jarvis/Mosaico";
import { Usage } from "./components/Usage";
import { AIRouterPage } from "./components/AIRouter";
import { Settings } from "./components/Settings";
import { Projects } from "./components/Projects";
import { ProjectsTabsProvider, useProjectsTabs } from "./state/ProjectsTabsContext";
import TabsBar from "./components/projects/TabsBar";
import ProjectWorkspace from "./components/projects/ProjectWorkspace";
import { System } from "./components/System";
import { MemoryTab } from "./components/MemoryTab";
import { PopupHost } from "./components/PopupHost";
// Hooks is now rendered inside the System tab as an inner sub-tab (v15.2 F7).
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { useAccionesChat } from "./lib/accionesChat";
import { seDisparaEscribiendo } from "./components/jarvis/chatAcciones";
import { estadoGlobal } from "./lib/status";
import { TabErrorBoundary } from "./components/TabErrorBoundary";
import { setupTrayEventListeners } from "./lib/tauri-events";
import type { AlertEntry } from "./types";

export default function App() {
  return (
    <ProjectsTabsProvider>
      <AppInner />
    </ProjectsTabsProvider>
  );
}

function AppInner() {
  const [tab, setTab] = useState<Tab>("home");
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Estado de la voz: alimenta el reactor de la barra y la pantalla principal.
  const {
    state: voiceState,
    amp: voiceAmp,
    caption: voiceCaption,
    captionParcial: voiceCaptionParcial,
    mic: voiceMic,
  } = useVoice();

  // La voz la arranca el BACKEND al abrir mar.ia (`maria_voice::
  // arrancar_al_inicio`), no la ventana: la app puede quedarse en la bandeja
  // sin ventana y la voz tiene que estar viva igual. Aqui solo se comprueba, y
  // si sigue caida se dice — antes este `catch` se tragaba el fallo y la voz
  // no arrancaba sin que nada lo contara (2026-09-19).
  const [vozCaida, setVozCaida] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      void invoke<boolean>("maria_voice_running")
        .then((viva) => setVozCaida(viva ? null : "la voz no ha arrancado"))
        .catch((e) => setVozCaida(String(e)));
    }, 6000);
    return () => clearTimeout(t);
  }, []);
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

  // In-app keyboard shortcuts. The OS-wide Ctrl+Alt+M lives in the Rust
  // setup; the bindings below are window-scoped. Bindings live in
  // ~/.maria/.tmp/in-app-shortcuts.json, los sirve
  // `in_app_shortcuts::get_in_app_shortcuts` (valores por defecto mezclados
  // encima) y este mapa es el espejo en tiempo de ejecución. Se relee al
  // montar y con el evento "in-app-shortcuts-updated".
  //
  // OJO (2026-09-22): el comentario anterior decía "editable via Settings →
  // General → In-app shortcuts" y esa pantalla NO existe — tampoco existe
  // `set_in_app_shortcuts`. Hoy se cambian editando el fichero. Docs que no
  // mienten (mandamiento 6).
  //
  // Claves de acción reconocidas aquí (mismos nombres que en Rust,
  // `in_app_shortcuts::default_bindings`):
  //   command.palette · open.settings · refresh.all
  //   tab.<dashboard|usage|notifications|sessions|projects|plans|memory|skills|logs|settings>
  //   chat.*  — las publica MariaChat mientras está montado (ver
  //             lib/accionesChat.ts): fuera del chat la lista está vacía y
  //             esas teclas no hacen nada, en vez de fingir que sí.
  const bindingsRef = useRef<Record<string, string>>({});
  // Copia reactiva, solo para poder enseñar el atajo en la paleta.
  const [bindings, setBindings] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const map = (await invoke("get_in_app_shortcuts")) as Record<
          string,
          string
        >;
        if (!cancelled) {
          bindingsRef.current = map ?? {};
          setBindings(map ?? {});
        }
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

  // Acciones que publica la pantalla de chat. Se leen por referencia dentro
  // del listener de teclado (que se registra una sola vez) y por valor para
  // construir la paleta.
  const accionesChat = useAccionesChat();
  const accionesChatRef = useRef(accionesChat);
  accionesChatRef.current = accionesChat;
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;

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

      const escribiendo = isTypingTarget(document.activeElement);

      // Acciones del chat. Van ANTES del corte por "estoy escribiendo" porque
      // ese es justo el momento en que hacen falta: con el cursor en la caja.
      // Solo las que llevan modificador (o Escape) se disparan ahi, para no
      // robar una letra — `seDisparaEscribiendo`. Con la paleta abierta no se
      // tocan: ahi Escape es suyo.
      if (!paletteOpenRef.current) {
        for (const a of accionesChatRef.current) {
          const combo = b[a.id];
          if (!combo || !matchCombo(combo, e)) continue;
          if (escribiendo && !seDisparaEscribiendo(combo)) continue;
          e.preventDefault();
          a.run();
          return;
        }
      }

      // Tab jumps — suppressed while typing so they don't eat keystrokes.
      if (escribiendo) return;

      const TAB_ACTIONS: [string, Tab][] = [
        ["tab.usage", "usage"],
        ["tab.notifications", "notifications"],
        ["tab.sessions", "sessions"],
        ["tab.projects", "projects"],
        // tab.memory estaba definido en in_app_shortcuts.rs (Alt+7) pero
        // faltaba aqui: el atajo existia y no hacia nada (2026-09-17).
        ["tab.memory", "memory"],
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

  const salud = estadoGlobal(alerts);
  const globalStatus = salud.status;

  // v15.3.7 — Command palette gets the full mar.ia system surface.
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

    // -- Chat --------------------------------------------------------
    // La MISMA lista que alimenta los atajos, para que no haya dos catálogos
    // que se separen. Está vacía fuera de la pestaña Chat: la paleta no puede
    // ofrecer «parar la respuesta» cuando no hay chat montado que la pare.
    for (const a of accionesChat) {
      list.push({
        id: a.id,
        label: a.label,
        description: a.descripcion,
        group: "Chat",
        shortcut: bindings[a.id],
        run: a.run,
      });
    }

    // -- Actions (refresh / settings / close) -------------------------
    list.push({
      id: "refresh",
      label: "Refrescar avisos",
      description: "Vuelve a leer los avisos del sistema.",
      group: "Acciones",
      shortcut: "Ctrl+R",
      run: () => void refreshAll(),
    });
    list.push({
      id: "maria-orb",
      label: "mar.ia — abrir el orbe",
      description: "Ventana pequeña con el blob: voz, estado y acceso rápido.",
      group: "Acciones",
      run: () => void runQuiet("Abrir el orbe de mar.ia", "maria_open_orb"),
    });
    list.push({
      id: "settings",
      label: "Abrir Ajustes",
      group: "Acciones",
      shortcut: "Ctrl+,",
      run: () => setTab("settings"),
    });
    list.push({
      id: "close-control-center",
      label: "Cerrar mar.ia del todo",
      description: "Sale de verdad (no a la bandeja). Suelta los ficheros bloqueados.",
      group: "Acciones",
      run: async () => {
        const ok = await confirmDialog(
          "Close mar.ia? Global hotkeys stop until you relaunch.",
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
      label: "Abrir el diagnóstico del PC",
      description: "Diagnóstico nativo (sysinfo + wmi) con análisis de la IA.",
      group: "Diagnóstico",
      run: () => setTab("system"),
    });
    // -- AI sessions --------------------------------------------------
    list.push({
      id: "ai.spawn.claude",
      label: "Abrir una sesión de Claude",
      description: "Terminal nueva de Claude Code (el prompt va por el portapapeles).",
      group: "IA",
      run: () =>
        void runQuiet("Spawn Claude", "spawn_session", {
          provider: "claude",
          prompt: null,
        }),
    });
    list.push({
      id: "ai.spawn.codex",
      label: "Abrir una sesión de Codex",
      description: "Lanza la CLI de Codex (entra con la suscripción de ChatGPT).",
      group: "IA",
      run: () =>
        void runQuiet("Spawn Codex", "spawn_session", {
          provider: "codex",
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
      label: "Reconstruir mar.ia",
      description: "Lanza `npm run tauri build` en una ventana aparte.",
      group: "Sistema",
      run: () =>
        void runQuiet("Rebuild", "run_app_lifecycle", { kind: "update" }),
    });
    list.push({
      id: "sys.uninstall",
      label: "Desinstalar mar.ia",
      description: "Abre el desinstalador en una ventana aparte (pide confirmación).",
      group: "Sistema",
      run: async () => {
        const ok = await confirmDialog(
          "Open the uninstaller? This walks you through removing mar.ia.",
          { title: "Desinstalar mar.ia", kind: "warning" },
        );
        if (ok)
          void runQuiet("Uninstall", "run_app_lifecycle", { kind: "uninstall" });
      },
    });
    list.push({
      id: "sys.purge-autostart",
      label: "Limpiar arranques automáticos viejos",
      description: "Quita las entradas de Run y de Inicio que dejaron instalaciones anteriores.",
      group: "Sistema",
      run: () => void runQuiet("Purge autostart", "purge_legacy_autostart"),
    });
    list.push({
      id: "sys.scan-projects",
      label: "Volver a buscar proyectos",
      description: "Reexamina las carpetas para que aparezcan los proyectos nuevos.",
      group: "Sistema",
      run: () => void runQuiet("Scan projects", "scan_projects"),
    });

    return list;
  }, [maintenanceCommands, accionesChat, bindings]);

  return (
    // HUD de mar.ia: las capas de fondo van detras (z-0, sin eventos de
    // puntero) y el contenido encima. La barra de telemetria ocupa el alto
    // completo con `flex-col`, y debajo queda el reparto clasico rail+main:
    // asi ninguna pestaña heredada cambia de estructura.
    <div className="relative flex h-full flex-col">
      <HudBackground />
      <HudTopBar voiceState={voiceState} />
      {vozCaida && (
        <div
          className="relative z-10 px-4 py-1 text-[11px]"
          style={{
            background: "rgba(255,77,94,0.10)",
            borderBottom: "1px solid var(--color-danger)",
            color: "var(--color-danger)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {vozCaida} — revisa que exista voice/.venv y mira el log de mar.ia.
          <button
            type="button"
            onClick={() => {
              setVozCaida(null);
              void invoke("maria_voice_start").catch((e) => setVozCaida(String(e)));
            }}
            className="ml-3 underline"
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}
          >
            reintentar
          </button>
        </div>
      )}
      {/* overflow-hidden + min-w-0 en el hijo: sin esto, una pestaña con
          contenido ancho (la rejilla de Projects) hace crecer a `main` mas
          alla del contenedor, el documento entero se desplaza y el rail se
          sale por la izquierda comiendose las primeras letras. */}
      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
      <Sidebar
        active={tab}
        onSelect={setTab}
        globalStatus={globalStatus}
        statusMotivo={salud.motivo}
        lastProjectCtx={tab !== "projects" ? lastProjectCtx : null}
        onGoBack={goBackToProject}
      />
      <main className="min-w-0 flex-1 overflow-auto">
        <TabErrorBoundary tab="notifications">
          {tab === "notifications" && (
            <Notifications alerts={alerts} onDeleted={refreshAll} />
          )}
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
        <TabErrorBoundary tab="home">
          {tab === "home" && (
            <MariaHome
              voiceState={voiceState}
              caption={voiceCaption}
              captionParcial={voiceCaptionParcial}
              mic={voiceMic}
              amp={voiceAmp}
              onNavigate={(t) => setTab(t)}
            />
          )}
        </TabErrorBoundary>
        <TabErrorBoundary tab="chat">
          {tab === "chat" && <MariaChat />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="conversations">
          {tab === "conversations" && <Conversations />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="terminals">
          {tab === "terminals" && <Terminals />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="mosaic">
          {tab === "mosaic" && <Mosaico />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="sessions">
          {tab === "sessions" && (
            <SessionsZone
              onOpenProject={(id) => {
                open({ id, title: id });
                setTab("projects");
              }}
            />
          )}
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
        <TabErrorBoundary tab="memory">
          {tab === "memory" && <MemoryTab />}
        </TabErrorBoundary>
        <TabErrorBoundary tab="system">
          {tab === "system" && <System />}
        </TabErrorBoundary>
      </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(t) => setTab(t)}
        extraActions={extraPaletteActions}
      />
      <PopupHost />
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
