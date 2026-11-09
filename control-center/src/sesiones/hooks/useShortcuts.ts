// Atajos globales: Ctrl+1..4 foco de panel, Ctrl+T sesión nueva (con el último perfil
// de «+ Claude»), Ctrl+W cerrar panel (ninguno de los dos con un diálogo modal abierto),
// Ctrl+F búsqueda en el hilo del panel con foco, Ctrl+B «Segundo plano» de la sesión del
// panel con foco (§3.4; el composer ya lo atiende si tiene el foco) y Ctrl+Espacio
// dictado en el composer con foco aunque el textarea no tenga el foco (F15).

import { useEffect } from "react";
import type { SesionesApi } from "../api";
import { backgroundNow } from "../components/composer/force";
import { newSessionHere } from "../launch-profiles";
import { requestThreadSearch } from "../thread-search";
import { requestDictationToggle } from "../ui";
import { closePane, focusPane, updateWorkspace, workspaceStore, type Pane, type Workspace } from "../workspace";

/**
 * Panel cuyo chat atiende Ctrl+F y Ctrl+B: el que contiene el foco o, si el foco no está en
 * ningún campo de texto ni diálogo, el panel activo. Sin sesión, ninguno.
 */
function searchTarget(ws: Workspace): Pane | null {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active?.closest('[role="dialog"]')) return null;
  const host = active?.closest<HTMLElement>("[data-pane-index]");
  const editable = active !== null && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
  if (!host && editable) return null;
  const pane = host ? ws.panes[Number(host.dataset.paneIndex)] : ws.panes[ws.focused];
  return pane?.sessionId ? pane : null;
}

/** Un diálogo modal (Ajustes, Perfiles, visor) tiene la ventana: Ctrl+T y Ctrl+W no actúan detrás. */
function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

export function useShortcuts(api: SesionesApi | null): void {
  useEffect(() => {
    if (!api) return;
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.code === "Space" && !e.defaultPrevented) {
        // El textarea del composer ya lo gestiona (y marca defaultPrevented).
        e.preventDefault();
        requestDictationToggle();
        return;
      }
      const ws = workspaceStore.getState();
      if (/^[1-4]$/.test(e.key)) {
        e.preventDefault();
        updateWorkspace((w) => focusPane(w, Number(e.key) - 1));
        // Lleva el foco del teclado al composer del panel elegido.
        window.requestAnimationFrame(() => {
          const el = document.querySelector<HTMLTextAreaElement>(`[data-pane-index="${Number(e.key) - 1}"] textarea`);
          el?.focus();
        });
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "f" && !e.shiftKey) {
        const pane = searchTarget(ws);
        if (!pane?.sessionId) return;
        e.preventDefault();
        requestThreadSearch(pane.sessionId, pane.agentId);
        return;
      }
      if (k === "b" && !e.shiftKey && !e.defaultPrevented) {
        const pane = searchTarget(ws);
        if (!pane?.sessionId || e.repeat) return;
        e.preventDefault();
        void backgroundNow(api as SesionesApi, pane.sessionId);
        return;
      }
      if ((k === "t" || k === "w") && !e.shiftKey && e.repeat) {
        // Con la tecla mantenida, la autorrepetición abriría varias sesiones de
        // Claude o cerraría todos los paneles: solo cuenta la primera pulsación.
        e.preventDefault();
        return;
      }
      if ((k === "t" || k === "w") && !e.shiftKey && modalOpen()) return;
      if (k === "t" && !e.shiftKey) {
        e.preventDefault();
        void newSessionHere(api as SesionesApi, ws.panes[ws.focused]?.sessionId ?? null);
      } else if (k === "w" && !e.shiftKey) {
        e.preventDefault();
        updateWorkspace((w) => closePane(w, w.focused));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api]);
}
