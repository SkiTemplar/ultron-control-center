// Ventana «ULTRON Sessions»: barra superior, sesiones, espacio de trabajo e
// inspector. Atiende también el arrastre de ficheros en toda la ventana
// (drop.ts) y el atajo de dictado Ctrl+Espacio fuera del composer.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SesionesApi } from "./api";
import { bootstrap, reportError, retryBootstrap } from "./bootstrap";
import { ApiContext } from "./context";
import { useDictationShortcut } from "./components/composer/useDictation";
import { ImageViewer } from "./components/ImageViewer";
import { Inspector } from "./components/inspector/Inspector";
import { refreshPlan } from "./components/inspector/uso-state";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { Workspace } from "./components/Workspace";
import { useWindowFileDrop } from "./drop";
import { useShortcuts } from "./hooks/useShortcuts";
import { wireOpenAgents } from "./open-agents";
import { startPlanPolling } from "./plan-poll";
import { store, useStore } from "./store";
import type { SessionId } from "./types";
import { requestAttach, useUi } from "./ui";
import { wireUnread } from "./unread";
import { workspaceStore } from "./workspace";

type Drawer = "none" | "rail" | "insp";

const INSP_KEY = "ultron.sesiones.inspector";

function anyWorking(): boolean {
  return store.getState().sessions.some((s) => s.status === "working");
}

/** Sesión del panel sobre el que se suelta (o del panel con foco). */
function sessionForPane(index: number | null): SessionId | null {
  const ws = workspaceStore.getState();
  return ws.panes[index ?? ws.focused]?.sessionId ?? ws.panes[ws.focused]?.sessionId ?? null;
}

function reportNoSession(): void {
  reportError("Abre una sesión en el panel para adjuntarle ficheros.");
}

function loadInspectorOpen(): boolean {
  try {
    return window.localStorage.getItem(INSP_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * Esc cierra el cajón de sesiones o del inspector (por debajo de 960 px, donde se
 * abre sobre el hilo). Un Esc que ya usó otro control (composer, menú) no cuenta.
 */
function useDrawerEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && window.matchMedia("(max-width: 960px)").matches) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
}

/**
 * `/git`, `/agentes`, `/uso`, `/codex` y «+ Motor» piden una pestaña del inspector:
 * si está cerrado (o, por debajo de 960 px, plegado en cajón), se abre. Antes la
 * pestaña cambiaba con el inspector oculto y el comando no hacía nada visible.
 */
function useRevealInspector(open: boolean, reveal: () => void, openDrawer: () => void) {
  const tabTick = useUi((s) => s.inspectorTabRequest?.tick ?? 0);
  const engineTick = useUi((s) => s.engineFocusTick);
  const seen = useRef({ tabTick, engineTick });
  useEffect(() => {
    if (seen.current.tabTick === tabTick && seen.current.engineTick === engineTick) return;
    seen.current = { tabTick, engineTick };
    if (window.matchMedia?.("(max-width: 960px)").matches) openDrawer();
    else if (!open) reveal();
  }, [tabTick, engineTick, open, reveal, openDrawer]);
}

export function App() {
  const [api, setApi] = useState<SesionesApi | null>(null);
  const [drawer, setDrawer] = useState<Drawer>("none");
  const [inspOpen, setInspOpen] = useState(loadInspectorOpen);
  const error = useStore((s) => s.error);

  useEffect(() => {
    let alive = true;
    bootstrap()
      .then((a) => alive && setApi(a))
      .catch(reportError);
    return () => {
      alive = false;
    };
  }, []);

  // Uso del plan y ritmo al arrancar y después según `plan-poll.ts`: 60 s con
  // turnos en marcha, 10 min en reposo y en pausa con la ventana oculta (el
  // backend lee la línea de estado local o, sin muestra reciente, el endpoint
  // con caché). La pestaña Uso y el HUD leen el mismo `paceStore`; un fallo queda visible.
  useEffect(() => {
    if (!api) return;
    return startPlanPolling({ refresh: () => void refreshPlan(api), isWorking: anyWorking, subscribe: store.subscribe });
  }, [api]);

  // Los hilos de subagente abiertos en algún panel no salen de memoria por la cota de hilos.
  useEffect(() => wireOpenAgents(workspaceStore, store.dispatch), []);
  // Mostrar en un panel una sesión con respuesta nueva le quita la marca de no leída.
  useEffect(() => wireUnread(workspaceStore), []);

  const dragging = useWindowFileDrop({ sessionFor: sessionForPane, onFiles: requestAttach, onNoSession: reportNoSession });
  useDictationShortcut();

  const toggleInspector = useCallback(() => {
    setInspOpen((v) => {
      try {
        window.localStorage.setItem(INSP_KEY, v ? "off" : "on");
      } catch {
        // Sin almacenamiento: la preferencia dura lo que la ventana.
      }
      return !v;
    });
  }, []);

  useShortcuts(api);
  const closeDrawer = useCallback(() => setDrawer("none"), []);
  const openInspectorDrawer = useCallback(() => setDrawer("insp"), []);
  useRevealInspector(inspOpen, toggleInspector, openInspectorDrawer);
  useDrawerEscape(drawer !== "none", closeDrawer);

  if (!api) {
    return (
      <div className="app" aria-busy="true">
        <header className="topbar"><span className="brand">ULTRON <span className="brand-sub">Sessions</span></span><span className="crumb">The Ultimate Claude Code Interface</span></header>
        <div className="empty-state">
          {error ? (
            <div role="alert">
              <p>No se pudo arrancar: {error}</p>
              <button className="btn pri" onClick={() => retryBootstrap().then(setApi).catch(reportError)}>Reintentar</button>
            </div>
          ) : <p>Conectando con las sesiones…</p>}
        </div>
      </div>
    );
  }

  return (
    <ApiContext.Provider value={api}>
      <div className="app" data-insp={inspOpen ? "on" : "off"} data-drawer={drawer} data-mock={api.isMock ? "1" : undefined}>
        <TopBar
          inspectorOpen={inspOpen}
          onToggleInspector={toggleInspector}
          onToggleDrawer={(d) => setDrawer((cur) => (cur === d ? "none" : d))}
        />
        <div className="body">
          <Sidebar onPicked={() => setDrawer("none")} />
          <Workspace />
          <Inspector />
          {drawer !== "none" && <div className="drawer-back" aria-hidden="true" onClick={closeDrawer} data-testid="drawer-back" />}
        </div>
        <ImageViewer />
        {dragging && <div className="drop-overlay" data-testid="drop-overlay"><span>Suelta para adjuntar</span></div>}
        <Toasts />
      </div>
    </ApiContext.Provider>
  );
}
