// Bloque secundario de la pestaña Uso: suscripciones de Codex y agy, saldo de
// DeepSeek y delegaciones por motor (cockpit/delegations.jsonl), debajo del
// plan de Claude y más pequeño. Pide al montar, cada 2 min mientras la
// pestaña está abierta y con «Actualizar» (`forceKey`), que salta la caché.
// El sondeo va por debajo de la caché de `agy /usage` (5 min, `CACHE_TTL_MS`
// de hooks/scripts/lib/engine-usage.js): con los dos iguales la caché vencía
// justo en cada sondeo y agy se relanzaba siempre; así corre como mucho una
// vez por plazo de caché y los sondeos intermedios la reutilizan. Gana
// siempre la última petición: una respuesta anterior que llega tarde se
// descarta.

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../context";
import type { DeepseekBalanceUsage, EnginePlanUsage, EnginePlanWindow, EnginesPlanUsage } from "../../types";
import { activityLines, deepseekText, delegationLine, engineGroups, engineHeader, engineWindowLabel, engineWindowText, missingText } from "./uso-motores";
import "../../styles/uso-motores.css";

/** Menor que `CACHE_TTL_MS` de engine-usage.js (lo comprueba engine-usage.selftest.mjs). */
const REFRESH_MS = 2 * 60000;

export interface EnginesState {
  data: EnginesPlanUsage | null;
  error: string | null;
  loading: boolean;
}

/** Uso de Codex y agy con sondeo; también lo usa el segmento de relevo del HUD. */
export function useEngines(forceKey: number): EnginesState {
  const api = useApi();
  const [state, setState] = useState<EnginesState>({ data: null, error: null, loading: false });
  const seq = useRef(0);
  const load = useCallback(
    (force: boolean) => {
      seq.current += 1;
      const id = seq.current;
      setState((s) => ({ ...s, loading: true }));
      api
        .enginesUsage(force ? { force: true } : undefined)
        .then((data) => id === seq.current && setState({ data, error: null, loading: false }))
        .catch((e: unknown) => {
          const error = e instanceof Error ? e.message : String(e);
          if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
        });
    },
    [api],
  );
  useEffect(() => {
    load(false);
    const t = window.setInterval(() => load(false), REFRESH_MS);
    return () => {
      window.clearInterval(t);
      seq.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (forceKey > 0) load(true);
  }, [forceKey, load]);
  return state;
}

const barTone = (p: number): string => (p >= 85 ? "err" : p >= 60 ? "warn" : "");

function MiniRow({ label, w, now }: { label: string; w: EnginePlanWindow; now: number }) {
  const name = engineWindowLabel(w.kind);
  const used = w.expired ? null : w.usedPct;
  return (
    <div className="uso-motor-row num">
      <span>{name}</span>
      <div className="bar" role="progressbar" aria-label={`${label} ${name}`} aria-valuenow={used === null ? undefined : Math.round(used)} aria-valuemin={0} aria-valuemax={100}>
        {used !== null && <i className={barTone(used)} style={{ width: `${Math.min(100, used)}%` }} />}
      </div>
      <span>{engineWindowText(w, now)}</span>
    </div>
  );
}

function EngineBlock({ e, now }: { e: EnginePlanUsage; now: number }) {
  let body;
  if (e.status !== "ok") {
    body = <span className="faint">{missingText(e)}</span>;
  } else if (e.source === "activity" && e.activity) {
    body = (
      <>
        <span className="faint">{e.note ?? "actividad sin límite conocido"}</span>
        {activityLines(e.activity).map((line) => <span key={line} className="num">{line}</span>)}
      </>
    );
  } else {
    body = (
      <>
        {engineGroups(e).map(({ group, windows }) => (
          <div key={group ?? ""} className="uso-motor-group">
            {group && <span className="faint">{group}</span>}
            {windows.map((w) => <MiniRow key={`${w.group ?? ""}-${w.kind}`} label={e.label} w={w} now={now} />)}
          </div>
        ))}
        {e.note && <span className="faint">{e.note}</span>}
      </>
    );
  }
  return (
    <div className="uso-motor" data-testid={`uso-motor-${e.id}`}>
      <div className="uso-motor-head">{engineHeader(e, now)}</div>
      {body}
    </div>
  );
}

function DeepseekBlock({ b }: { b: DeepseekBalanceUsage }) {
  const tone = b.available === false || b.status === "error" ? "warn-text" : b.status === "none" ? "faint" : "num";
  return (
    <div className="uso-motor" data-testid="uso-motor-deepseek">
      <div className="uso-motor-head">DeepSeek · saldo</div>
      <span className={tone}>{deepseekText(b)}</span>
    </div>
  );
}

function DelegationsBlock({ data }: { data: EnginesPlanUsage }) {
  const list = data.delegations ?? [];
  if (!data.delegationsError && list.length === 0) return null;
  return (
    <div className="uso-motor" data-testid="uso-delegaciones">
      <div className="uso-motor-head">Delegaciones por motor (últimas 2000 entradas del registro)</div>
      {data.delegationsError && <span className="warn-text">No se pudo leer el registro: {data.delegationsError}</span>}
      {list.map((d) => <span key={d.engine} className="num">{delegationLine(d)}</span>)}
    </div>
  );
}

/** Codex y agy; `forceKey` cambia con cada «Actualizar» de la pestaña. */
export function UsoMotores({ forceKey, now }: { forceKey: number; now: number }) {
  const { data, error, loading } = useEngines(forceKey);
  return (
    <section className="uso-motores" aria-label="Otros motores">
      <div className="sect">Otros motores</div>
      {error && <p className="note warn-text">No se pudo leer el uso de Codex y agy: {error}</p>}
      {!data && !error && loading && <p className="loading">Consultando Codex y agy…</p>}
      {data && data.engines.length === 0 && <p className="note">Sin motores con uso que mostrar.</p>}
      {data?.engines.map((e) => <EngineBlock key={e.id} e={e} now={now} />)}
      {data?.deepseek && <DeepseekBlock b={data.deepseek} />}
      {data && <DelegationsBlock data={data} />}
    </section>
  );
}
