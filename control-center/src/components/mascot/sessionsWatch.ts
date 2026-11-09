// Mascota — Pupus vigila Sessions (funciones puras, con tests).
//
// La mascota sondea `sesiones_list` (solo lectura) y compara cada lista con
// la anterior. Avisa de lo que pide tu atención: una sesión que espera
// (permiso, pregunta, plan, menú, confianza), una que se cae o se atasca y
// un turno largo que termina. El aviso queda pendiente hasta que haces clic
// en Pupus (enfoca esa sesión en Sessions) o deja de tener sentido.

import type { SessionInfo, WaitKind } from "../../sesiones/types";
import type { Emote } from "./engine";
import type { Glyph } from "./sprite";

export type WatchedSession = Pick<
  SessionInfo,
  "id" | "projectId" | "projectName" | "title" | "status" | "waiting" | "stalled" | "workingSince" | "exitCode"
>;

export interface AlertTarget {
  id: string;
  projectId: string | null;
  title: string;
}

export type SessionAlert =
  | { kind: "turnDone"; session: AlertTarget; workedMs: number }
  | { kind: "waiting"; session: AlertTarget; waitKind: WaitKind }
  | { kind: "failed"; session: AlertTarget; reason: "exit" | "stalled" }
  | { kind: "gone"; sessionId: string };

export type ActionableAlert = Exclude<SessionAlert, { kind: "gone" }>;

export interface Pending {
  alert: ActionableAlert;
  sinceMs: number;
}

/** Un turno cuenta como largo a partir de un minuto de trabajo. */
export const LONG_TURN_MS = 60_000;
/** Un aviso sin atender se retira a los 10 minutos. */
export const PENDING_TTL_MS = 10 * 60_000;

const RANK: Record<ActionableAlert["kind"], number> = { waiting: 3, failed: 2, turnDone: 1 };

function target(s: WatchedSession): AlertTarget {
  return { id: s.id, projectId: s.projectId, title: s.title || s.projectName };
}

function alertFor(before: WatchedSession, after: WatchedSession, nowMs: number): ActionableAlert | null {
  const t = target(after);
  if (after.status === "waiting" && after.waiting) {
    const same = before.status === "waiting" && before.waiting?.kind === after.waiting.kind;
    return same ? null : { kind: "waiting", session: t, waitKind: after.waiting.kind };
  }
  if (after.status === "exited" && before.status !== "exited" && after.exitCode !== null && after.exitCode !== 0) {
    return { kind: "failed", session: t, reason: "exit" };
  }
  if (after.stalled && !before.stalled) return { kind: "failed", session: t, reason: "stalled" };
  if (before.status === "working" && after.status === "idle" && before.workingSince) {
    const workedMs = nowMs - Date.parse(before.workingSince);
    if (workedMs > LONG_TURN_MS) return { kind: "turnDone", session: t, workedMs };
  }
  return null;
}

/**
 * Avisos entre dos listas. `prev = null` es la primera lista: sin avisos
 * (no se avisa de lo que ya estaba así al arrancar). Una sesión nueva
 * tampoco avisa: la acabas de abrir tú.
 */
export function diffSessions(
  prev: readonly WatchedSession[] | null,
  next: readonly WatchedSession[],
  nowMs: number,
): SessionAlert[] {
  if (!prev) return [];
  const before = new Map(prev.map((s) => [s.id, s]));
  const out: SessionAlert[] = [];
  for (const s of next) {
    const b = before.get(s.id);
    const a = b ? alertFor(b, s, nowMs) : null;
    if (a) out.push(a);
  }
  const alive = new Set(next.map((s) => s.id));
  for (const s of prev) if (!alive.has(s.id)) out.push({ kind: "gone", sessionId: s.id });
  return out;
}

/** ¿Sigue teniendo sentido el aviso pendiente con la lista actual? */
function stillValid(p: Pending, sessions: readonly WatchedSession[], nowMs: number): boolean {
  if (nowMs - p.sinceMs >= PENDING_TTL_MS) return false;
  const s = sessions.find((x) => x.id === p.alert.session.id);
  if (!s) return false;
  if (p.alert.kind === "waiting") return s.status === "waiting";
  if (p.alert.kind === "turnDone") return s.status === "idle";
  return true;
}

/** Aviso pendiente tras una vuelta de sondeo. */
export function nextPending(
  pending: Pending | null,
  alerts: readonly SessionAlert[],
  sessions: readonly WatchedSession[],
  nowMs: number,
): Pending | null {
  const kept = pending && stillValid(pending, sessions, nowMs) ? pending : null;
  let best: ActionableAlert | null = null;
  for (const a of alerts) {
    if (a.kind !== "gone" && (!best || RANK[a.kind] > RANK[best.kind])) best = a;
  }
  if (!best) return kept;
  if (kept && RANK[kept.alert.kind] > RANK[best.kind]) return kept;
  return { alert: best, sinceMs: nowMs };
}

/** Cómo lo cuenta Pupus. `reminder`: solo el icono, sin gesto. */
export function cueFor(a: ActionableAlert, reminder: boolean): { glyph: Glyph; emote: Emote | null } {
  const pick = (glyph: Glyph, emote: Emote) => ({ glyph, emote: reminder ? null : emote });
  switch (a.kind) {
    case "waiting":
      return pick(a.waitKind === "permission" || a.waitKind === "trust" ? "exclaim" : "question", "hop");
    case "failed":
      return pick("sweat", "sigh");
    case "turnDone":
      return pick("spark", "joy");
  }
}

/** Texto del tooltip de Pupus con un aviso pendiente. */
export function alertHint(a: ActionableAlert): string {
  const what =
    a.kind === "waiting" ? "te espera" : a.kind === "failed" ? (a.reason === "exit" ? "se ha cerrado con error" : "parece atascada") : "ha terminado";
  return `«${a.session.title}» ${what}. Clic: ir a esa sesión.`;
}
