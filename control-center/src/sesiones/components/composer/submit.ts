// Decisión de envío del composer (§5.2, §3.4, EST-04, AC-13). Pura, para poder probarla:
// - idle con el prompt a la vista → `send` (eco optimista con `clientId`), en los tres modos;
// - Enter (`auto`) arrancando, trabajando o esperando (pregunta, permiso, plan, menú o
//   confianza) → `enqueue`: Enter nunca escribe en un diálogo de la TUI;
// - «Enviar ya» (Ctrl+Enter, `now`) trabajando → `now` (cola nativa de la CLI: Claude lo
//   lee al terminar la herramienta en curso);
// - «Interrumpir y enviar» (Ctrl+Mayús+Enter, `interrupt`) trabajando o esperando una
//   respuesta → `interruptSend` (para el turno y lo manda el primero);
// - los dos modos forzados con un menú o la confianza en pantalla, o esperando una
//   respuesta en `now`, se bloquean con su motivo: forzar ahí no escribiría nada útil;
// - sesión terminada → error visible, nada se envía.

import type { CommandDef, QueueItemKind, SessionInfo } from "../../types";
import { findCommand, parseSlash } from "./route";

export type SubmitMode = "auto" | "now" | "interrupt";

export type SubmitAction =
  | { type: "send" }
  | { type: "enqueue" }
  | { type: "now" }
  | { type: "interruptSend" }
  | { type: "blocked"; reason: string };

export const DIALOG_BLOCK_REASON = "La TUI tiene un menú o un diálogo abierto: ciérralo antes de forzar el envío.";
export const WAITING_NOW_REASON =
  "Claude espera tu respuesta: contéstala o usa «Interrumpir y enviar» (Ctrl+Mayús+Enter).";

export function exitedReason(info: SessionInfo): string {
  return `La sesión terminó${info.exitCode !== null ? ` (código ${info.exitCode})` : ""}: reiníciala para seguir.`;
}

function hasDialog(info: SessionInfo): boolean {
  return info.screen === "dialog" || info.screen === "trust" || info.waiting?.kind === "menu" || info.waiting?.kind === "trust";
}

/** Modos forzados (`now`, `interrupt`) con la sesión ocupada. */
function forcedAction(info: SessionInfo, mode: "now" | "interrupt"): SubmitAction {
  if (hasDialog(info)) return { type: "blocked", reason: DIALOG_BLOCK_REASON };
  if (info.status === "starting") return { type: "enqueue" };
  if (mode === "interrupt") return { type: "interruptSend" };
  if (info.status === "waiting") return { type: "blocked", reason: WAITING_NOW_REASON };
  return { type: "now" };
}

export function submitAction(info: SessionInfo | null, mode: SubmitMode): SubmitAction {
  if (!info) return { type: "blocked", reason: "La sesión ya no existe." };
  if (info.status === "exited") return { type: "blocked", reason: exitedReason(info) };
  if (info.status === "idle" && !hasDialog(info)) return { type: "send" };
  if (mode === "auto") return { type: "enqueue" };
  return forcedAction(info, mode);
}

/**
 * Tipo del elemento de la cola. Es `command` solo un `/comando` bien formado que
 * está en el catálogo (con `catalog` null, como en la cola antigua, basta con que
 * esté bien formado) y que no lleva adjuntos: el backend despacha un `command`
 * con `CommandRun`, que no lleva adjuntos, así que una ruta de Git Bash
 * (`/c/Users/...`) o un comando con capturas va como `prompt` por el PTY, igual
 * que se enviaría con la sesión libre.
 */
export function itemKind(text: string, catalog: readonly CommandDef[] | null, hasAttachments: boolean): QueueItemKind {
  if (text.startsWith("!")) return "bash";
  if (hasAttachments) return "prompt";
  const parsed = parseSlash(text);
  if (!parsed) return "prompt";
  if (catalog && !findCommand(parsed.command, catalog)) return "prompt";
  return "command";
}

export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
