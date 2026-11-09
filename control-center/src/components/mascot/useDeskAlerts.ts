// Mascota — avisos de builds y tests en rojo y de entregas del calendario
// (lógica pura en deskAlerts.ts; detección en Rust, sin tokens).
//
//   * Cada 3 s pregunta `mascot_desk_alerts(after)`. Con un fallo nuevo,
//     Pupus hace «!», saca el bocadillo y camina hasta la ventana de
//     Sessions (si la sesión es de Sessions) o la del editor; mientras siga
//     pendiente, repite el «!» cada 12 s. Clic en Pupus = abrir Sessions en
//     ese proyecto, o dar el aviso por visto si era del editor.
//   * Cada 10 min (al cambiar de día o el ajuste) pregunta
//     `mascot_calendar_today`: con una entrega hoy o mañana lleva el
//     calendario en la mano y la anuncia una vez con el bocadillo.
//   * Agenda: clic en Pupus con el calendario en la mano (o «¿Qué tengo
//     pendiente?» del clic derecho) = bocadillo con todas las entregas de
//     hoy y mañana; otro clic mientras se ve = darlas por vistas: suelta el
//     calendario hasta que haya una entrega nueva (la de mañana vuelve el
//     mismo día). Lo visto se guarda en localStorage.
// Prioridad: una espera de Sessions manda (no se va de paseo); el
// calendario no pisa el bocadillo de un fallo. En silencio de juego no
// avisa: el fallo queda pendiente y se anuncia al salir.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MascotEngine } from "./engine";
import type { Navigator } from "./navigator";
import type { Decor } from "./render";
import type { MascotSettings } from "./settings";
import type { Notice } from "./NoticeBubble";
import { deskEpisode } from "./episodes";
import {
  agendaText,
  calendarNotice,
  dueKey,
  visibleDue,
  keepAnnounced,
  keepTargets,
  mergeDesk,
  nextDue,
  noticeText,
  outranks,
  resolveTarget,
  type DeskAlert,
  type DeskBatch,
  type DeskTarget,
  type DueSoon,
  type NoticeKind,
  type PendingDesk,
  type SessionRef,
} from "./deskAlerts";

export { NoticeBubble } from "./NoticeBubble";

const POLL_MS = 3000;
const CALENDAR_MS = 10 * 60_000;
const REMIND_MS = 12_000;
const NOTICE_MS = 8000;
const AGENDA_MS = 14_000;
/** Lo bastante para leer por qué no se hizo lo que pediste. */
const ERROR_NOTICE_MS = 10_000;
const DISMISSED_KEY = "mascot.calendar.dismissed";
const AGENDA_HINT = "Clic en Pupus: visto (suelta el calendario)";
/** En el primer sondeo solo cuentan los avisos recientes (recarga de la página). */
const FIRST_BATCH_MAX_AGE_MS = 60_000;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Deps {
  ready: boolean;
  engineRef: MutableRefObject<MascotEngine | null>;
  navRef: MutableRefObject<Navigator | null>;
  decor: Decor;
  quietRef: MutableRefObject<boolean>;
  settingsRef: MutableRefObject<MascotSettings>;
  /** Hay una espera de Sessions pendiente (useSessionsWatch). */
  sessionsBusy: () => boolean;
}

/** Estado del sondeo (exportado, con `pollAlerts` y `pollCalendar`, para los tests). */
export interface DeskState {
  after: number;
  started: boolean;
  pending: PendingDesk[];
  targets: Map<number, DeskTarget>;
  missed: DeskAlert | null;
  lastCueMs: number;
  announced: Set<string>;
  day: string;
  calendarAt: number;
  calendarOn: boolean | null;
  /** Entregas de hoy y mañana del último sondeo. */
  due: DueSoon[];
  /** Claves (dueKey) dadas por vistas con el clic. */
  dismissed: Set<string>;
}

export interface ShowOpts {
  hint?: string;
  ms?: number;
  /** Pedido por el usuario: pisa cualquier aviso. */
  force?: boolean;
  /** Marca para saber qué bocadillo se está viendo (`showing`). */
  tag?: string;
}

type Show = (kind: NoticeKind, text: string, opts?: ShowOpts) => boolean;

export interface Ctx extends Deps {
  st: DeskState;
  show: Show;
  /** El bocadillo con esa marca sigue a la vista. */
  showing?: (tag: string) => boolean;
}

const today = () => new Date().toDateString();

function loadDismissed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(keys: ReadonlySet<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...keys]));
  } catch {
    /* sin almacenamiento: lo visto dura hasta recargar */
  }
}

export const newState = (): DeskState => ({
  after: 0,
  started: false,
  pending: [],
  targets: new Map(),
  missed: null,
  lastCueMs: 0,
  announced: new Set(),
  day: today(),
  calendarAt: 0,
  calendarOn: null,
  due: [],
  dismissed: loadDismissed(),
});

/** Bocadillo con prioridad: uno menos importante no pisa al activo. */
function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const activeRef = useRef<{ kind: NoticeKind; until: number; tag?: string } | null>(null);
  const show = useCallback<Show>((kind, text, opts = {}) => {
    const cur = activeRef.current;
    if (!opts.force && !outranks(kind, cur && performance.now() < cur.until ? cur.kind : null)) return false;
    const id = performance.now();
    const ms = opts.ms ?? NOTICE_MS;
    activeRef.current = { kind, until: id + ms, tag: opts.tag };
    setNotice({ id, kind, text, hint: opts.hint });
    window.setTimeout(() => setNotice((n) => (n?.id === id ? null : n)), ms);
    return true;
  }, []);
  const showing = useCallback((tag: string) => {
    const cur = activeRef.current;
    return !!cur && cur.tag === tag && performance.now() < cur.until;
  }, []);
  const clear = useCallback(() => {
    activeRef.current = null;
    setNotice(null);
  }, []);
  return { notice, show, showing, clear };
}

/** Calendario en la mano según las entregas que quedan sin ver. */
function syncCalendarProp(ctx: Ctx) {
  const d = nextDue(visibleDue(ctx.st.due, ctx.st.dismissed));
  ctx.decor.calendar = d ? { when: d.when } : null;
  return d;
}

/** Bocadillo con todas las entregas de hoy y mañana (pedido por el usuario). */
export function showAgenda(ctx: Ctx) {
  const st = ctx.st;
  if (!ctx.settingsRef.current.calendar) {
    ctx.show("calendar", "El calendario está apagado en los ajustes de Pupus.", { force: true });
    return;
  }
  const pendingNow = visibleDue(st.due, st.dismissed).length > 0;
  ctx.show("calendar", agendaText(st.due), {
    force: true,
    ms: AGENDA_MS,
    tag: "agenda",
    hint: pendingNow ? AGENDA_HINT : undefined,
  });
}

/** Da por vistas las entregas actuales: suelta el calendario. */
export function dismissAgenda(ctx: Ctx) {
  const st = ctx.st;
  st.dismissed = new Set([...st.dismissed, ...st.due.map(dueKey)]);
  saveDismissed(st.dismissed);
  syncCalendarProp(ctx);
  ctx.show("calendar", "Visto. Clic derecho → «¿Qué tengo pendiente?» para volver a verlo.", { force: true });
}

async function announce(ctx: Ctx, a: DeskAlert) {
  ctx.engineRef.current?.showIcon("exclaim", 2.2);
  ctx.st.lastCueMs = Date.now();
  ctx.show("build", noticeText(a));
  const sessions = await invoke<SessionRef[]>("sesiones_list").catch(() => [] as SessionRef[]);
  const target = resolveTarget(a, sessions);
  ctx.st.targets.set(a.seq, target);
  if (ctx.sessionsBusy()) return;
  const args = target.kind === "sesiones" ? { target: "sesiones" } : { target: "editor", hint: target.hint };
  const rect = await invoke<Rect | null>("mascot_target_window", args).catch(() => null);
  if (!rect || ctx.quietRef.current) return;
  const arrive = () => ctx.engineRef.current?.showIcon("exclaim", 1.2);
  ctx.navRef.current?.walkTo((rect.left + rect.right) / 2, rect.top, arrive);
}

export async function pollAlerts(ctx: Ctx) {
  const st = ctx.st;
  const batch = await invoke<DeskBatch>("mascot_desk_alerts", { after: st.after });
  const now = Date.now();
  st.after = batch.lastSeq;
  const alerts = st.started ? batch.alerts : batch.alerts.filter((a) => now - Date.parse(a.at) < FIRST_BATCH_MAX_AGE_MS);
  st.started = true;
  if (!ctx.settingsRef.current.build_alerts) {
    st.pending = [];
    st.targets = new Map();
    return;
  }
  // Rojo = gruñón si se repite; arreglado = orgullo y un saltito de alegría.
  for (const a of alerts) {
    const k = deskEpisode(a.state);
    ctx.engineRef.current?.feel(k, k === "testsArreglados" && !ctx.quietRef.current);
  }
  const merged = mergeDesk(st.pending, alerts, now);
  st.pending = merged.pending;
  // Un aviso que sale de los pendientes (arreglado, caducado o atendido) suelta su destino.
  st.targets = keepTargets(st.targets, st.pending);
  const fresh = merged.fresh ?? (st.pending.some((p) => p.alert === st.missed) ? st.missed : null);
  if (ctx.quietRef.current) {
    st.missed = fresh;
    return;
  }
  st.missed = null;
  if (fresh) void announce(ctx, fresh);
  else if (st.pending.length && now - st.lastCueMs >= REMIND_MS) {
    ctx.engineRef.current?.showIcon("exclaim", 1.6);
    st.lastCueMs = now;
  }
}

function calendarDue(ctx: Ctx): boolean {
  const st = ctx.st;
  return st.day !== today() || st.calendarOn !== ctx.settingsRef.current.calendar || Date.now() - st.calendarAt >= CALENDAR_MS;
}

export async function pollCalendar(ctx: Ctx) {
  const st = ctx.st;
  st.calendarAt = Date.now();
  st.day = today();
  st.calendarOn = ctx.settingsRef.current.calendar;
  const list = st.calendarOn ? await invoke<DueSoon[]>("mascot_calendar_today") : [];
  // Las entregas anunciadas que ya no son de hoy ni de mañana se olvidan.
  // Lo mismo con las vistas: así no crecen y una entrega nueva vuelve a salir.
  if (st.calendarOn) {
    st.announced = keepAnnounced(st.announced, list);
    const live = keepAnnounced(st.dismissed, list);
    if (live.size !== st.dismissed.size) saveDismissed(live);
    st.dismissed = live;
  }
  st.due = list;
  const d = syncCalendarProp(ctx);
  if (!d || ctx.quietRef.current || st.announced.has(dueKey(d))) return;
  if (ctx.show("calendar", calendarNotice(d), { hint: "Clic en Pupus: ver lo pendiente" })) st.announced.add(dueKey(d));
}

/** Clic con el calendario en la mano: primero la agenda; con ella a la vista, visto. */
export function takeAgendaClick(ctx: Ctx): boolean {
  if (!ctx.settingsRef.current.calendar || visibleDue(ctx.st.due, ctx.st.dismissed).length === 0) return false;
  if (ctx.showing?.("agenda")) dismissAgenda(ctx);
  else showAgenda(ctx);
  return true;
}

function takeClick(ctx: Ctx, clear: () => void): boolean {
  const st = ctx.st;
  const p = st.pending[st.pending.length - 1];
  if (!p) return takeAgendaClick(ctx);
  st.pending = st.pending.filter((x) => x !== p);
  clear();
  const t = st.targets.get(p.alert.seq);
  if (t?.kind === "sesiones") {
    invoke("sesiones_open_window", { projectId: t.projectId }).catch(() => {
      st.pending = [...st.pending, p];
      st.targets = new Map(st.targets).set(p.alert.seq, t);
      ctx.engineRef.current?.showIcon("sweat", 1.6);
    });
  }
  return true;
}

/** Vigila builds, tests y entregas. `takeClick` = true si el clic era suyo. */
export function useDeskAlerts(deps: Deps): {
  takeClick: () => boolean;
  /** «¿Qué tengo pendiente?»: agenda al momento, con el calendario recién leído. */
  askAgenda: () => void;
  /** Enseña que una acción del usuario falló (pisa cualquier otro aviso). */
  showError: (text: string) => void;
  notice: Notice | null;
} {
  const { notice, show, showing, clear } = useNotice();
  const stRef = useRef<DeskState>(newState());
  const ctxRef = useRef<Ctx>({ ...deps, st: stRef.current, show, showing });
  ctxRef.current = { ...deps, st: stRef.current, show, showing };

  useEffect(() => {
    if (!deps.ready) return;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        await pollAlerts(ctxRef.current);
        if (calendarDue(ctxRef.current)) await pollCalendar(ctxRef.current);
      } catch {
        /* un comando no respondió este ciclo: se reintenta en el siguiente */
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, [deps.ready]);

  const take = useCallback(() => takeClick(ctxRef.current, clear), [clear]);
  const askAgenda = useCallback(() => {
    const ctx = ctxRef.current;
    const refresh = ctx.settingsRef.current.calendar ? pollCalendar(ctx) : Promise.resolve();
    // Si el calendario no responde, la agenda sale con lo último leído.
    void refresh.catch(() => undefined).then(() => showAgenda(ctxRef.current));
  }, []);
  const showError = useCallback(
    (text: string) => {
      show("error", text, { force: true, ms: ERROR_NOTICE_MS });
      ctxRef.current.engineRef.current?.showIcon("sweat", 1.6);
    },
    [show],
  );
  return { takeClick: take, askAgenda, showError, notice };
}
