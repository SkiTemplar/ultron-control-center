// Flujo canónico de «Recompilar» (Settings, paleta Ctrl+K y UpdateBanner).
//
// Desde el 2026-10-21 el build no necesita cerrar ULTRON:
// `scripts/release-locked-exe.mjs` aparta el control-center.exe en uso a
// `*.old-<ts>.exe` (Windows deja renombrar un binario en ejecución), el
// enlazado escribe el nuevo y la app abierta sigue con el anterior hasta que
// se reinicia. Por eso el flujo ya no pide la salida de la app:
//   1. se consulta `sesiones_busy` y se pide confirmación con un texto que
//      dice qué va a pasar;
//   2. `run_app_lifecycle("update")` abre la terminal, que hace git pull,
//      npm install y npm run build:local, y al terminar dice si hay que
//      reiniciar ULTRON para usar el binario nuevo.
// Si el renombrado falla, el build cae al cierre forzoso de la app y lo dice
// en la terminal: es el único caso en que se cortan las sesiones abiertas, y
// el diálogo lo avisa cuando hay sesiones trabajando.

import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../../lib/dialog";

export interface BusySession {
  id: string;
  title: string;
  working: boolean;
  queued: boolean;
}

export interface BusySessions {
  working: number;
  queued: number;
  sessions: BusySession[];
}

export type RebuildOutcome = "cancelled" | "started";

/** Texto del diálogo de confirmación; `busy` null = no se pudo consultar. */
export function rebuildConfirmMessage(busy: BusySessions | null): string {
  const base =
    "Se abre una terminal que hace git pull, npm install y npm run build:local " +
    "(de 3 a 5 minutos la primera vez).\n\n" +
    "ULTRON sigue abierto mientras compila: el build aparta el control-center.exe en uso " +
    "y el binario nuevo entra al reiniciar la app. Si Windows no deja apartarlo, el build " +
    "cierra ULTRON a la fuerza y lo dice en la terminal.";
  if (busy === null) {
    return `${base}\n\nNo se ha podido comprobar si hay sesiones trabajando en Sessions.`;
  }
  if (busy.sessions.length === 0) return base;
  const titles = busy.sessions
    .slice(0, 3)
    .map((s) => `«${s.title}»`)
    .join(", ");
  const more = busy.sessions.length > 3 ? ` y ${busy.sessions.length - 3} más` : "";
  return (
    `${base}\n\nAtención: ${busy.sessions.length} sesión(es) con trabajo pendiente ` +
    `(${busy.working} con turno en curso, ${busy.queued} con envíos en cola): ${titles}${more}. ` +
    "Solo se cortarían si el build tuviera que cerrar ULTRON a la fuerza."
  );
}

/** Consulta las sesiones ocupadas; null si el comando falla. */
export async function fetchBusySessions(): Promise<BusySessions | null> {
  try {
    return await invoke<BusySessions>("sesiones_busy");
  } catch {
    return null;
  }
}

/**
 * Pide confirmación y abre la terminal de Rebuild. Devuelve "cancelled" si el
 * usuario dice que no (no se abre nada) y "started" si la terminal arrancó.
 * No cierra la app. Los errores de `run_app_lifecycle` se propagan.
 */
export async function startRebuild(): Promise<RebuildOutcome> {
  const busy = await fetchBusySessions();
  const hasBusy = (busy?.sessions.length ?? 0) > 0;
  const ok = await confirmDialog(rebuildConfirmMessage(busy), {
    title: "Recompilar",
    kind: hasBusy ? "error" : "warning",
    okLabel: "Compilar",
    cancelLabel: "Cancelar",
  });
  if (!ok) return "cancelled";
  await invoke("run_app_lifecycle", { kind: "update" });
  return "started";
}

/** Aviso que se enseña cuando la terminal de Rebuild ya está abierta. */
export const REBUILD_STARTED_MESSAGE =
  "Terminal de Rebuild abierta. Cuando diga «Build OK», reinicia ULTRON para usar el binario nuevo.";
