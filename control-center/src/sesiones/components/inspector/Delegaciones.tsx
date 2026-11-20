// Delegaciones de `scripts/delegate.mjs` en el árbol de Agentes: una fila por
// run de la sesión, con el motor y el modelo del intento en curso (o del que
// pasó el check) y el historial de intentos al pasar el ratón.
//
// No dejan transcript de subagente ni pasan por Motores: el backend las lee
// de `meta.json` (`sesiones_delegations`). El árbol sondea mientras está
// abierto; gana siempre la última petición.

import { useContext, useEffect, useRef, useState } from "react";
import { ApiContext } from "../../context";
import type { DelegationAttempt, DelegationRun, SessionId } from "../../types";

/** Sondeo: `meta.json` solo cambia al empezar y al acabar cada intento. */
export const DELEGATIONS_POLL_MS = 5000;

const NO_RUNS: DelegationRun[] = [];

/** Delegaciones de la sesión. Sin API en el contexto (tests de pintado) no sondea. */
export function useDelegations(sessionId: SessionId | null): { runs: DelegationRun[]; error: string | null } {
  const api = useContext(ApiContext);
  const [state, setState] = useState<{ runs: DelegationRun[]; error: string | null }>({ runs: NO_RUNS, error: null });
  const seq = useRef(0);
  useEffect(() => {
    setState({ runs: NO_RUNS, error: null });
    if (!api || !sessionId) return;
    const load = () => {
      seq.current += 1;
      const id = seq.current;
      api
        .delegations(sessionId)
        .then((runs) => id === seq.current && setState({ runs, error: null }))
        .catch((e: unknown) => {
          const error = e instanceof Error ? e.message : String(e);
          if (id === seq.current) setState((s) => ({ ...s, error }));
        });
    };
    load();
    const timer = window.setInterval(load, DELEGATIONS_POLL_MS);
    return () => {
      seq.current += 1;
      window.clearInterval(timer);
    };
  }, [api, sessionId]);
  return state;
}

const STATUS: Record<DelegationRun["status"], string> = {
  running: "en curso",
  done: "✓ check",
  error: "error",
  stale: "sin señal",
};

const attemptLine = (a: DelegationAttempt): string =>
  `${a.attempt}. ${a.engine}${a.model ? ` (${a.model})` : ""}: ${a.outcome}${a.reason ? ` · ${a.reason}` : ""}`;

function runTitle(r: DelegationRun): string {
  const head = r.status === "stale"
    ? "Sin resultado y sin escrituras más allá del plazo del intento: el proceso pudo morir."
    : `delegate.mjs · ${r.id}`;
  return [head, ...r.attempts.map(attemptLine)].join("\n");
}

/** `codex · gpt-6.1-terra · intento 2`; sin motor todavía, solo el nivel. */
function runDetail(r: DelegationRun): string {
  if (!r.engine) return `nivel ${r.tier || "—"} · eligiendo motor`;
  const parts = [r.engine, r.model || "modelo por defecto"];
  if (r.attempt > 1) parts.push(`intento ${r.attempt}`);
  return parts.join(" · ");
}

export function DelegationRuns({ runs, error }: { runs: DelegationRun[]; error: string | null }) {
  if (runs.length === 0 && !error) return null;
  return (
    <div className="kids" data-testid="agentes-delegaciones">
      {error && <p className="note" role="alert">No se pudieron leer las delegaciones: {error}</p>}
      {runs.map((r) => (
        <div key={r.id} className="node" data-testid={`delegacion-${r.id}`} title={runTitle(r)}>
          <span className={`dot ${r.status}`} />
          <span className="t">Delegación <small>{runDetail(r)}</small></span>
          <span className="badge num">{STATUS[r.status]}</span>
          <span className="s">{r.title || r.id}</span>
        </div>
      ))}
    </div>
  );
}
