// Línea de estado única del chat (§5.5, EST-07, R10, R12): una sola frase en un
// sitio fijo encima del composer que dice si Claude trabaja (y en qué), espera,
// está colgado (con la causa) o está libre, con las acciones de recuperación
// que tocan (§3.1) y «Segundo plano» con una herramienta que Ctrl+B puede
// mover (§3.4). Interrumpir y Salir del menú no salen aquí: su único sitio es
// el composer, que además los ata a Esc. Pura, para poder probarla en tabla.

import { backgroundText, hasBackground, NO_BACKGROUND, type BackgroundWork } from "../../background";
import type { LiveTool } from "../../session-state";
import type { Ask, ForegroundTool, QueueItem, QueuePause, QueuePauseReason, SessionInfo, StallInfo } from "../../types";

export type StatusTone = "idle" | "bg" | "busy" | "wait" | "warn" | "err" | "off";
export type StatusAction = "interrupt" | "recover" | "restart" | "exitMenu" | "sendNow" | "releaseTerminal" | "background";

export interface StatusLineModel {
  tone: StatusTone;
  text: string;
  actions: StatusAction[];
}

export interface StatusLineContext {
  now: number;
  /** El último turno cerrado acabó abortado. */
  lastTurnAborted?: boolean;
  /** Hay texto de razonamiento en vivo sin texto de respuesta. */
  thinking?: boolean;
  queue?: readonly QueueItem[];
  /** La última interrupción falló porque la CLI abrió otro turno con el aviso de una tarea en segundo plano. */
  resumedBySubagent?: boolean;
  /** Herramienta del hilo principal en curso, aunque su `tool_use` ya esté en el transcript. */
  mainRunning?: LiveTool | null;
  /** Subagentes y workflows vivos; con la sesión libre la línea los nombra en vez de «Listo». */
  background?: BackgroundWork;
}

export const TASK_RESUME_TEXT = "Claude abrió otro turno con el aviso de una tarea en segundo plano";

/** Sesión viva sin `hello` del mod ultron-puente en el proceso actual. */
export const NO_BRIDGE_TEXT = "sin puente: preguntas, permisos y turnos solo se ven en la terminal";

/** Herramienta en curso a partir de la cual la línea avisa (2 min, el límite por defecto de Bash). */
export const TOOL_AVISO_MS = 2 * 60 * 1000;

/** Colgado: a los 5 min pasa a rojo y ofrece reiniciar (§1.5). */
export const STALL_RED_MS = 5 * 60 * 1000;

export function basename(path: string): string {
  const clean = path.trim().replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() ?? clean;
}

function clip(text: string, max = 48): string {
  const one = text.split("\n")[0].trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Verbo y objeto de la herramienta en curso: «Editando Composer.tsx…». */
export function toolPhrase(name: string, summary: string): string {
  const target = summary ? basename(summary) : "";
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return target ? `Editando ${target}…` : "Editando…";
    case "Read":
      return target ? `Leyendo ${target}…` : "Leyendo…";
    case "Bash":
    case "PowerShell":
      return summary ? `Ejecutando ${clip(summary)}…` : "Ejecutando…";
    case "Grep":
    case "Glob":
      return "Buscando…";
    case "WebFetch":
    case "WebSearch":
      return "Consultando la web…";
    case "Task":
    case "Agent":
      return "Delegando en un subagente…";
    default:
      return `${name}…`;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

function since(iso: string | null | undefined, now: number): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? 0 : now - t;
}

const STALL_TEXT: Record<StallInfo["reason"], (s: StallInfo, ms: number) => string> = {
  noTurnStart: () => "Claude no ha recibido el mensaje (15 s)",
  toolOverdue: (s, ms) => s.detail || `${s.tool ?? "La herramienta"} sigue sin terminar: ${formatDuration(ms)}`,
  tuiFrozen: () => "La terminal de Claude no responde (30 s)",
  noEvents: (_s, ms) => `Sin eventos desde hace ${formatDuration(ms)}`,
  startupTimeout: (s) => s.detail || "Claude no ha llegado al prompt en 30 s",
};

function stalledLine(s: StallInfo, now: number, fg: ForegroundTool | null | undefined): StatusLineModel {
  const ms = since(s.since, now);
  const red = ms >= STALL_RED_MS;
  const base: StatusAction[] = red ? ["recover", "restart"] : ["recover"];
  // Una herramienta vencida que Ctrl+B puede mover: pasarla a segundo plano no pierde su trabajo.
  const background = s.reason === "toolOverdue" && fg?.backgroundable === true;
  return {
    tone: red ? "err" : "warn",
    text: STALL_TEXT[s.reason](s, ms),
    actions: background ? ["background", ...base] : base,
  };
}

function waitingLine(info: SessionInfo, asks: readonly Ask[]): StatusLineModel {
  const kind = info.waiting?.kind ?? asks[0]?.kind ?? "question";
  if (kind === "menu") {
    const command = info.waiting?.label.startsWith("/") ? ` ${info.waiting.label}` : "";
    return { tone: "wait", text: `Menú${command} abierto en la TUI`, actions: [] };
  }
  if (kind === "trust") return { tone: "wait", text: "Confirma la carpeta", actions: [] };
  if (kind === "plan") return { tone: "wait", text: "Esperando: plan", actions: [] };
  if (kind === "permission") {
    const ask = asks.find((a) => a.kind === "permission");
    const tool = ask?.kind === "permission" ? ask.tool : info.waiting?.label.replace(/^permiso\s*/i, "");
    return { tone: "wait", text: `Esperando tu respuesta: permiso${tool ? ` ${tool}` : ""}`, actions: [] };
  }
  return { tone: "wait", text: "Esperando tu respuesta: pregunta", actions: [] };
}

/** Arranque sin prompt en 30 s (`startupTimeout`): la única salida es reiniciar. */
function startingLine(info: SessionInfo): StatusLineModel {
  if (!info.stalled) return { tone: "busy", text: "Arrancando Claude…", actions: [] };
  return { tone: "warn", text: STALL_TEXT[info.stalled.reason](info.stalled, 0), actions: ["restart"] };
}

/** Mensajes que esperan en la cola nativa de la CLI detrás de la herramienta en curso. */
function blockedSuffix(t: LiveTool, queue: readonly QueueItem[] | undefined): string {
  const n = (queue ?? []).filter((q) => q.state === "cliQueued").length;
  return n > 0 ? ` · ${n} en cola tras ${t.name}` : "";
}

/**
 * Herramienta en curso con su tiempo (incidente del 2026-10-15: un `find` bloqueó
 * el turno 7 min y la línea solo decía «Trabajando»). A partir de 2 min, aviso. Si
 * Ctrl+B la puede mover (`movable`), ofrece «Segundo plano».
 */
function runningLine(t: LiveTool, ctx: StatusLineContext, movable: boolean): StatusLineModel {
  const ms = t.startedAt !== undefined ? ctx.now - t.startedAt : 0;
  const blocked = blockedSuffix(t, ctx.queue);
  const actions: StatusAction[] = movable ? ["background"] : [];
  if (ms >= TOOL_AVISO_MS) {
    const hint = movable ? "Ctrl+B para pasarla a segundo plano o Esc para interrumpir" : "Esc para interrumpir";
    return { tone: "warn", text: `${t.name} lleva ${formatDuration(ms)}: ${hint}${blocked}`, actions };
  }
  const elapsed = ms >= 1000 ? ` · ${formatDuration(ms)}` : "";
  return { tone: "busy", text: `${toolPhrase(t.name, t.summary)}${elapsed}${blocked}`, actions };
}

/**
 * Herramienta en curso: la del evento `tool` de esta ventana o, si no la vio (ventana
 * recargada), la que el backend proyecta en `foregroundTool`. Con la misma herramienta,
 * el inicio del backend manda: no se reinicia al recargar.
 */
function currentTool(info: SessionInfo, live: readonly LiveTool[], ctx: StatusLineContext): LiveTool | null {
  const seen = ctx.mainRunning ?? [...live].reverse().find((t) => t.agentId === null && t.phase === "start") ?? null;
  const fg = info.foregroundTool;
  const fgStart = fg ? Date.parse(fg.since) : Number.NaN;
  if (!fg || Number.isNaN(fgStart)) return seen;
  if (!seen) return { toolUseId: fg.toolUseId, agentId: null, name: fg.name, summary: "", phase: "start", startedAt: fgStart };
  return seen.toolUseId === fg.toolUseId ? { ...seen, startedAt: fgStart } : seen;
}

function workingLine(info: SessionInfo, live: readonly LiveTool[], ctx: StatusLineContext): StatusLineModel {
  if (info.stalled) return stalledLine(info.stalled, ctx.now, info.foregroundTool);
  if (ctx.resumedBySubagent) return { tone: "warn", text: TASK_RESUME_TEXT, actions: [] };
  const running = currentTool(info, live, ctx);
  if (running) return runningLine(running, ctx, info.foregroundTool?.backgroundable === true && info.foregroundTool.toolUseId === running.toolUseId);
  if (ctx.thinking) return { tone: "busy", text: "Pensando…", actions: [] };
  return { tone: "busy", text: `Trabajando · ${formatDuration(since(info.workingSince, ctx.now))}`, actions: [] };
}

const QUEUE_PAUSE_TEXT: Record<QueuePauseReason, string> = {
  deadline: "esperando confirmación del fin de turno",
  interrupted: "turno interrumpido; sale con «Enviar ahora» o con tu próximo mensaje",
  usageLimit: "límite de uso de Claude; sale sola cuando vuelva el cupo",
};

function queuePauseLine(pause: QueuePause, now: number): StatusLineModel {
  // Un motivo que este front aún no conoce también se avisa: la cola sigue parada.
  const why = QUEUE_PAUSE_TEXT[pause.reason] ?? "motivo no reconocido";
  return { tone: "warn", text: `Cola en pausa: ${why} · ${formatDuration(since(pause.since, now))}`, actions: ["sendNow"] };
}

export function statusLine(info: SessionInfo, live: readonly LiveTool[], asks: readonly Ask[], ctx: StatusLineContext): StatusLineModel {
  switch (info.status) {
    case "starting":
      return startingLine(info);
    case "exited":
      return { tone: "off", text: `La sesión terminó${info.exitCode !== null ? ` (código ${info.exitCode})` : ""}`, actions: ["restart"] };
    case "waiting":
      return waitingLine(info, asks);
    case "working":
      return workingLine(info, live, ctx);
    default: {
      const queued = (ctx.queue ?? []).some((q) => q.state === "queued");
      if (queued && info.terminalAttached) {
        return { tone: "warn", text: "Cola en pausa: terminal del menú enganchada", actions: ["releaseTerminal"] };
      }
      if (queued && info.queuePause) return queuePauseLine(info.queuePause, ctx.now);
      const bg = ctx.background ?? NO_BACKGROUND;
      const turn = ctx.lastTurnAborted ? "Interrumpido" : hasBackground(bg) ? "Turno acabado" : "Listo";
      // Hilo principal libre con subagentes o workflows vivos: no ha acabado del todo.
      const text = hasBackground(bg) ? `${turn} · en segundo plano: ${backgroundText(bg)}` : turn;
      const actions: StatusAction[] = queued && ctx.lastTurnAborted ? ["sendNow"] : [];
      // `bridgeConnected` es el puente del proceso actual: sin él, el chat solo ve la pantalla.
      if (!info.bridgeConnected) return { tone: "warn", text: `${text} · ${NO_BRIDGE_TEXT}`, actions };
      return { tone: hasBackground(bg) ? "bg" : "idle", text, actions };
    }
  }
}

/** Acción de Esc en el composer (§3.1): solo con el borrador vacío. */
export function escAction(info: SessionInfo | null, draftEmpty: boolean): "interrupt" | "exitMenu" | null {
  if (!info || !draftEmpty) return null;
  if (info.waiting?.kind === "menu" || (info.status !== "exited" && info.screen === "dialog" && info.waiting?.kind !== "trust")) return "exitMenu";
  if (info.status === "working") return "interrupt";
  if (info.status === "waiting" && info.waiting?.kind !== "trust") return "interrupt";
  return null;
}
