// Mascota — avisos de builds y tests en rojo y de entregas del calendario
// (funciones puras, con tests). El sondeo vive en useDeskAlerts.ts; los
// avisos los genera Rust sin tokens (src-tauri/src/mascot/alerts.rs y
// calendar.rs).

/** Espejo de DeskAlert (alerts.rs). */
export interface DeskAlert {
  seq: number;
  source: "tests" | "build";
  state: "failed" | "cleared";
  /** «cargo check», «tsc», «tests»… */
  what: string;
  detail: string;
  cwd: string;
  /** Nombre de la carpeta del proyecto. */
  projectHint: string;
  claudeSessionId: string | null;
  at: string;
}

export interface DeskBatch {
  alerts: DeskAlert[];
  lastSeq: number;
}

/** Espejo de DueSoon (calendar.rs). */
export interface DueSoon {
  subject: string;
  title: string;
  /** RFC 3339. */
  due: string;
  allDay: boolean;
  when: "today" | "tomorrow";
}

/** Lo mínimo de una sesión de Sessions para saber adónde ir. */
export interface SessionRef {
  projectId: string | null;
  claudeSessionId: string | null;
  cwd: string;
}

export type DeskTarget = { kind: "sesiones"; projectId: string | null } | { kind: "editor"; hint: string };

export interface PendingDesk {
  alert: DeskAlert;
  sinceMs: number;
}

/** Un aviso sin atender se retira a los 10 minutos. */
export const DESK_TTL_MS = 10 * 60_000;
const NOTICE_MAX = 140;

/**
 * Prioridad entre avisos: una acción tuya que falló > espera de Sessions >
 * build/tests > fin de turno > calendario.
 */
export type NoticeKind = "error" | "sessions" | "build" | "turn" | "calendar";
const NOTICE_RANK: Record<NoticeKind, number> = { error: 5, sessions: 4, build: 3, turn: 2, calendar: 1 };

export function outranks(next: NoticeKind, current: NoticeKind | null): boolean {
  return current === null || NOTICE_RANK[next] >= NOTICE_RANK[current];
}

const sameSpot = (a: DeskAlert, b: DeskAlert) => a.what === b.what && a.cwd === b.cwd;

/** Si la sesión de Claude es de Sessions, ir allí; si no, al editor. */
export function resolveTarget(alert: DeskAlert, sessions: readonly SessionRef[]): DeskTarget {
  const id = alert.claudeSessionId;
  const hit = id ? sessions.find((s) => s.claudeSessionId === id) : undefined;
  if (hit) return { kind: "sesiones", projectId: hit.projectId };
  return { kind: "editor", hint: alert.projectHint };
}

/**
 * Mezcla un lote nuevo con los pendientes: un «cleared» retira el fallo del
 * mismo `what` + `cwd`; un fallo nuevo sustituye al anterior del mismo
 * sitio; los pendientes caducan a los DESK_TTL_MS. `fresh` = el último
 * fallo nuevo del lote (el que merece paseo y bocadillo).
 */
export function mergeDesk(
  pending: readonly PendingDesk[],
  batch: readonly DeskAlert[],
  nowMs: number,
): { pending: PendingDesk[]; fresh: DeskAlert | null } {
  let out = pending.filter((p) => nowMs - p.sinceMs < DESK_TTL_MS);
  let fresh: DeskAlert | null = null;
  for (const a of batch) {
    out = out.filter((p) => !sameSpot(p.alert, a));
    if (a.state === "failed") {
      out = [...out, { alert: a, sinceMs: nowMs }];
      fresh = a;
    } else if (fresh && sameSpot(fresh, a)) {
      fresh = null;
    }
  }
  return { pending: out, fresh };
}

function clip(text: string, max = NOTICE_MAX): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Texto del bocadillo de un fallo. */
export function noticeText(a: DeskAlert): string {
  const where = a.projectHint ? ` en «${a.projectHint}»` : "";
  if (a.source === "tests") {
    const detail = a.detail ? `: ${a.detail.replace(/\.$/, "")}.` : ".";
    return clip(`Tests en rojo${where}${detail}`);
  }
  return clip(`${a.what} falla${where}${a.detail ? `: ${a.detail}` : "."}`);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** «Mañana, 23:59 — entrega de XYZ1: Práctica 7.» */
export function calendarNotice(d: DueSoon): string {
  const day = d.when === "today" ? "Hoy" : "Mañana";
  const t = new Date(d.due);
  const time = d.allDay || Number.isNaN(t.getTime()) ? "" : `, ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const title = d.title.replace(/\.$/, "");
  return clip(`${day}${time} — entrega de ${d.subject}: ${title}.`);
}

/** Clave estable de una entrega para anunciarla una sola vez por día. */
export function dueKey(d: DueSoon): string {
  return `${d.subject}|${d.due}|${d.when}`;
}

/** La entrega más urgente (hoy antes que mañana; después, la más cercana). */
export function nextDue(list: readonly DueSoon[]): DueSoon | null {
  const sorted = [...list].sort((a, b) =>
    a.when === b.when ? Date.parse(a.due) - Date.parse(b.due) : a.when === "today" ? -1 : 1,
  );
  return sorted[0] ?? null;
}

/** Solo los destinos de avisos que siguen pendientes (los demás se descartan). */
export function keepTargets(
  targets: ReadonlyMap<number, DeskTarget>,
  pending: readonly PendingDesk[],
): Map<number, DeskTarget> {
  const live = new Set(pending.map((p) => p.alert.seq));
  return new Map([...targets].filter(([seq]) => live.has(seq)));
}

/**
 * Solo las entregas anunciadas que siguen en la lista de hoy y mañana: la
 * clave lleva `when`, así que las de días pasados ya no pueden repetirse.
 */
export function keepAnnounced(announced: ReadonlySet<string>, list: readonly DueSoon[]): Set<string> {
  const live = new Set(list.map(dueKey));
  return new Set([...announced].filter((k) => live.has(k)));
}

/** Entregas que no se han dado por vistas (las que justifican llevar el calendario). */
export function visibleDue(list: readonly DueSoon[], dismissed: ReadonlySet<string>): DueSoon[] {
  return list.filter((d) => !dismissed.has(dueKey(d)));
}

const AGENDA_MAX = 4;

/** Lista de entregas de hoy y mañana para el bocadillo, una por línea. */
export function agendaText(list: readonly DueSoon[]): string {
  if (list.length === 0) return "Nada que entregar hoy ni mañana.";
  const sorted = [...list].sort((a, b) =>
    a.when === b.when ? Date.parse(a.due) - Date.parse(b.due) : a.when === "today" ? -1 : 1,
  );
  const lines = sorted.slice(0, AGENDA_MAX).map((d) => `• ${clip(calendarNotice(d), 90)}`);
  const rest = sorted.length - AGENDA_MAX;
  if (rest > 0) lines.push(`y ${rest} más.`);
  return lines.join("\n");
}
