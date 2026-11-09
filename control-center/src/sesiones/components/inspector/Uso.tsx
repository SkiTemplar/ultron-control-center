// Uso del plan con el mismo cálculo que el mod ultron-uso: por ventana, barra,
// uso frente al tiempo vivido, ritmo y hora estimada del límite; en la semanal,
// cuántas ventanas de 5 h llenas quedan. Tokens de los
// mensajes cargados de la sesión.
//
// El ritmo sale de `paceStore` (uso-state.ts), el mismo que lee el HUD y que el
// intervalo de App.tsx refresca cada minuto; un reloj de 30 s mantiene vivo
// el «reinicia en…».

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../context";
import { formatTokens } from "../../parse";
import { pagingOf } from "../../session-state";
import { useSession, useStore } from "../../store";
import type { ChatMessage, UsoWindow } from "../../types";
import { fiveHourLines, isWeek, limitLine, pct, resetText, tone, usageLine, windowLabel } from "./uso-format";
import { refreshPlan, sourceNote, usePace, usePaceError, useUsageError } from "./uso-state";
import { UsoMotores } from "./UsoMotores";

const CLOCK_MS = 30000;

/** Hora actual que se renueva cada `ms`, para los textos relativos. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

function WindowRow({ w, extra, now }: { w: UsoWindow; extra: string[]; now: number }) {
  const t = tone(w);
  const label = windowLabel(w.kind);
  return (
    <div className="usage-row" data-testid={`uso-${w.kind}`}>
      <div className="top"><span>{label}</span><span className="num">{pct(w.used)} · {resetText(w.resetsAtMs, now)}</span></div>
      <div className="bar" role="progressbar" aria-label={label} aria-valuenow={Math.round(w.used)} aria-valuemin={0} aria-valuemax={100}>
        <i className={t} style={{ width: `${Math.min(100, w.used)}%` }} />
      </div>
      <div className="uso-lines num">
        <span>{usageLine(w)}</span>
        <span className={w.runsOutLabel !== null ? "err-text" : undefined}>{limitLine(w)}</span>
        {extra.map((line) => <span key={line} className="faint">{line}</span>)}
      </div>
    </div>
  );
}

/**
 * Pide uso y ritmo al montar (uniéndose al refresco en vuelo) y con
 * «Actualizar», que fuerza el dato en vivo; `loading` solo con una petición
 * propia en vuelo.
 */
function useReload(): { loading: boolean; reload: () => void } {
  const api = useApi();
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  const load = useCallback(
    (force: boolean) => {
      setLoading(true);
      void refreshPlan(api, { force }).finally(() => alive.current && setLoading(false));
    },
    [api],
  );
  useEffect(() => {
    alive.current = true;
    load(false);
    return () => {
      alive.current = false;
    };
  }, [load]);
  const reload = useCallback(() => load(true), [load]);
  return { loading, reload };
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const NO_TOTALS: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function sumUsage(messages: readonly ChatMessage[]): Totals {
  return messages.reduce(
    (acc, m) => (m.usage ? {
      input: acc.input + m.usage.input,
      output: acc.output + m.usage.output,
      cacheRead: acc.cacheRead + m.usage.cacheRead,
      cacheWrite: acc.cacheWrite + m.usage.cacheWrite,
    } : acc),
    NO_TOTALS,
  );
}

/**
 * Tokens de los mensajes cargados. Si quedan páginas anteriores sin cargar, la
 * sección lo dice: no es el total de la sesión.
 */
function SessionTokens({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  const totals = useMemo(() => sumUsage(session.messages), [session.messages]);
  const partial = pagingOf(session, null).hasMore;
  return (
    <>
      <div className="sect">{partial ? "Mensajes cargados" : "Esta sesión"}</div>
      {partial && <p className="note">Solo los mensajes cargados: carga los anteriores en el chat para sumarlos.</p>}
      <div className="kv num">
        <span>Entrada</span><span>{formatTokens(totals.input)}</span>
        <span>Salida</span><span>{formatTokens(totals.output)}</span>
        <span>Leído de caché</span><span>{formatTokens(totals.cacheRead)}</span>
        <span>Escrito en caché</span><span>{formatTokens(totals.cacheWrite)}</span>
      </div>
    </>
  );
}

export function Uso({ sessionId }: { sessionId: string | null }) {
  const usage = useStore((s) => s.usage);
  const usageError = useUsageError();
  const pace = usePace();
  const paceError = usePaceError();
  const { loading, reload } = useReload();
  const [enginesForce, setEnginesForce] = useState(0);
  const now = useNow(CLOCK_MS);
  const windows = pace?.windows ?? [];
  const ordered = [...windows.filter((w) => !isWeek(w)), ...windows.filter(isWeek)];
  // El ritmo vuelve a pedir el uso: si falla por lo mismo, un solo aviso.
  const ownPaceError = paceError && paceError !== usageError ? paceError : null;
  const note = sourceNote(pace, now);
  return (
    <>
      <div className="sect">Plan</div>
      {usageError && <p className="note err-text" role="alert">No se pudo leer el uso del plan: {usageError}</p>}
      {ownPaceError && <p className="note err-text">No se pudo calcular el ritmo: {ownPaceError}</p>}
      {!pace && !paceError && loading && <p className="loading">Consultando el uso del plan…</p>}
      {pace && ordered.length === 0 && <p className="note">El uso del plan no trae ninguna ventana (5 h ni semanal).</p>}
      {ordered.map((w) => <WindowRow key={w.kind} w={w} now={now} extra={isWeek(w) ? fiveHourLines(w, pace?.weekInFiveHourPct ?? null) : []} />)}
      {note && <p className={`note${note.isError ? " warn-text" : " faint"}`}>{note.text}</p>}
      {!note && usage?.stale && <p className="note">Datos en caché: la última consulta falló.</p>}
      <button className="btn sm ghost" disabled={loading} onClick={() => { reload(); setEnginesForce((n) => n + 1); }}>{loading ? "Actualizando…" : "Actualizar"}</button>
      <UsoMotores forceKey={enginesForce} now={now} />
      {sessionId && <SessionTokens sessionId={sessionId} />}
    </>
  );
}
