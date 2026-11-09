import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../reducer";
import {
  buildTimelineParts, createThreadDerivedCache, createTimelineCache, currentTurnActivity, deriveThread,
  type ThreadDerivedCache, type TimelineCache, type TimelineItem,
} from "../timeline";
import type { ChatNote } from "../session-state";
import type { ChatMessage, EngineTask, TurnPayload } from "../types";
import { answer, longThread, prompt, toolResult, toolUse } from "./fixtures/long-thread";

function liveEvents(count: number): ChatMessage[][] {
  const out: ChatMessage[][] = [[prompt("live-p", 30000)]];
  for (let i = 1; i < count; i += 1) {
    const slot = i % 3;
    if (slot === 1) out.push([toolUse(`live-${i}`, 30000 + i, `lt-${i}`)]);
    else if (slot === 2) out.push([toolResult(`live-${i}`, 30000 + i, `lt-${i - 1}`)]);
    else out.push([answer(`live-${i}`, 30000 + i)]);
  }
  return out;
}

/** Filas cuyo objeto cambia de un evento a otro: cada una rompe el memo de su Message. */
function brokenCounter() {
  let prev = new Map<string, unknown>();
  let broken = 0;
  return {
    count(items: { key: string }[]) {
      const next = new Map<string, unknown>();
      for (const it of items) {
        const old = prev.get(it.key) as Record<string, unknown> | undefined;
        const cur = it as unknown as Record<string, unknown>;
        if (old && Object.keys(cur).some((k) => cur[k] !== old[k])) broken += 1;
        next.set(it.key, it);
      }
      prev = next;
    },
    get total() {
      return broken;
    },
  };
}

// Referencias estables, como las que ChatPane saca del store (notas, eventos turn, intervenciones).
const NO_NOTES: ChatNote[] = [];
const NO_TURNS: TurnPayload[] = [];
const NO_TASKS: EngineTask[] = [];

/** Lo que rehace ChatPane (y LiveBubble) con cada evento, con la caché por hilo de ChatPane. */
function derive(raw: readonly ChatMessage[], cache: TimelineCache, derived: ThreadDerivedCache): TimelineItem[] {
  // Visibles e índice de resultados, extendidos como en ChatPane.
  const { visible } = deriveThread(derived, raw);
  const parts = buildTimelineParts(visible, NO_TASKS, { lastTurnOpen: true, notes: NO_NOTES, turns: NO_TURNS, model: null, cache });
  currentTurnActivity(raw, []);
  return parts.items;
}

/**
 * Presupuestos (medido el 2026-10-12 en Windows, vitest + jsdom; margen holgado para CI):
 * - Antes (sin cota ni caché de la línea de tiempo): reducer + derivaciones sobre
 *   20.000 mensajes, ~1.500 ms por 200 eventos, y cada evento recreaba ~4.000
 *   filas (800.000 en total): actividad y gasto de todos los turnos.
 * - Después, con la cota en vivo (el hilo baja a 1.200 mensajes en el primer
 *   evento): ~50 ms.
 * - Después, sin cota (20.000 en memoria, p. ej. tras cargar páginas anteriores):
 *   ~300 ms; la caché rehace solo el último turno y se recrean ~200 filas.
 * - 2026-10-13, visibles e índice de resultados extendidos (`deriveThread`) y sin
 *   recorrer toda la línea al reutilizar filas: de ~520 a ~250 ms (mínimo de 6
 *   rondas, mismo equipo), así el límite sin cota queda con margen holgado.
 */
const BUDGET_CAPPED_MS = 400;
const BUDGET_UNCAPPED_MS = 1200;
/** Por evento solo cambian la fila nueva y, como mucho, la que deja de cerrar el turno. */
const MAX_NEW_ROWS_PER_EVENT = 2;

function run(start: () => { step: (ev: ChatMessage[]) => readonly ChatMessage[]; first: readonly ChatMessage[] }) {
  const counter = brokenCounter();
  const cache = createTimelineCache();
  const derived = createThreadDerivedCache();
  const { step, first } = start();
  counter.count(derive(first, cache, derived));
  let ms = 0;
  for (const ev of liveEvents(EVENTS)) {
    const t0 = performance.now();
    const items = derive(step(ev), cache, derived);
    ms += performance.now() - t0;
    counter.count(items);
  }
  return { ms, rows: counter.total };
}

const EVENTS = 200;

describe("carga: hilo de 20.000 mensajes y 200 eventos `messages` de streaming", () => {
  it(`reducer + derivaciones con la cota en vivo, bajo ${BUDGET_CAPPED_MS} ms`, () => {
    const out = run(() => {
      let state: State = reducer(initialState, { type: "history", id: "s1", agentId: null, messages: longThread(20000) });
      return {
        first: state.bySession.s1.messages,
        step: (ev) => {
          state = reducer(state, { type: "messages", id: "s1", messages: ev });
          return state.bySession.s1.messages;
        },
      };
    });
    expect(out.ms).toBeLessThan(BUDGET_CAPPED_MS);
  });

  it(`solo derivaciones sobre los 20.000 mensajes (sin cota), bajo ${BUDGET_UNCAPPED_MS} ms y sin recrear filas`, () => {
    const out = run(() => {
      let raw: ChatMessage[] = longThread(20000);
      return {
        first: raw,
        step: (ev) => {
          raw = [...raw, ...ev];
          return raw;
        },
      };
    });
    expect(out.ms).toBeLessThan(BUDGET_UNCAPPED_MS);
    expect(out.rows).toBeLessThanOrEqual(EVENTS * MAX_NEW_ROWS_PER_EVENT);
  });
});
