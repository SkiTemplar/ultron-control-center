// Mascota — permisos de ULTRON Sessions en el bocadillo (lógica pura).
//
// Sessions guarda sus preguntas en el broker (`sesiones_pending_asks`); aquí
// se convierten en tarjetas «¿Le dejo?» y se mezclan con las del freno y las
// de la terminal. Contestar desde Pupus usa el mismo camino que la ventana de
// Sessions (`sesiones_answer`), así que la otra ve la pregunta resuelta.

import type { Approval, ApprovalDecision } from "./bubble";

/** Payload de un ask tal como lo lista `sesiones_pending_asks`. */
export interface AskPayload {
  askId?: string;
  /** Sesión de ULTRON Sessions. */
  id?: string;
  kind?: string;
  tool?: string;
  summary?: string;
  input?: unknown;
  always?: unknown;
}

/** Lo que hace falta de cada sesión para decir quién pide. */
export interface AskSession {
  id: string;
  title: string;
  projectName: string;
}

const PREFIX = "ses:";

export function isSessionApproval(a: Approval): boolean {
  return a.source === "sessions";
}

function inputSummary(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["command", "file_path", "notebook_path", "url"]) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
    return JSON.stringify(input);
  }
  return "";
}

/** Tarjeta de un ask de permiso; `null` si no es de permiso o le falta el id. */
export function toApproval(p: AskPayload, sessions: readonly AskSession[]): Approval | null {
  if (p.kind !== "permission" || !p.askId || !p.id) return null;
  const s = sessions.find((x) => x.id === p.id);
  const name = s ? s.title || s.projectName : "";
  const tool = p.tool ?? "";
  return {
    id: PREFIX + p.askId,
    tool,
    reason: `permiso para ${tool || "una herramienta"}`,
    summary: p.summary || inputSummary(p.input) || tool,
    origin: name ? `Sessions · ${name}` : "Sessions",
    source: "sessions",
    sessionId: p.id,
    canAlways: !!p.always,
  };
}

/**
 * Nuevo estado del bocadillo: las tarjetas que no son de Sessions se
 * quedan; las de Sessions pasan a ser exactamente las pendientes, sin las
 * ya contestadas desde Pupus (el broker tarda una vuelta en enterarse).
 * Devuelve el mismo array si nada cambia (sin repintar).
 */
export function mergeSessionAsks(
  current: readonly Approval[],
  pending: readonly Approval[],
  answered: ReadonlySet<string>,
): Approval[] {
  const fresh = pending.filter((a) => !answered.has(a.id));
  const kept = current.filter((a) => !isSessionApproval(a));
  const before = current.filter(isSessionApproval).map((a) => a.id);
  const same = before.length === fresh.length && fresh.every((a, i) => a.id === before[i]);
  if (same) return current as Approval[];
  return [...kept, ...fresh];
}

/** Comando que lleva la respuesta de una tarjeta a su origen. */
export function answerCommand(a: Approval, decision: ApprovalDecision): { cmd: string; args: Record<string, unknown> } {
  if (isSessionApproval(a)) {
    return {
      cmd: "sesiones_answer",
      args: { askId: a.id.slice(PREFIX.length), answer: { kind: "permission", decision } },
    };
  }
  return { cmd: "mascot_approve_answer", args: { id: a.id, allow: decision !== "deny" } };
}
