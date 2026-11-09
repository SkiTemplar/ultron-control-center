// Acciones al final de cada respuesta de Claude: copiar y «Segunda opinión»
// de Codex o Gemini (E8). El motor no disponible aparece deshabilitado con el motivo.

import { useState } from "react";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { ENGINE_IDS, ENGINE_LABEL, engineBlockReason, opinionPrompt, runEngine } from "../../engines";
import { useStore } from "../../store";
import { formatTokens } from "../../parse";
import { messageText, type TurnStats } from "../../timeline";
import type { ChatMessage, EngineId } from "../../types";
import { useChatScope } from "./ChatContext";
import { CopyButton } from "./Markdown";

const ENGINES: readonly EngineId[] = ENGINE_IDS;

const usd = (n: number) => `${n < 0.01 ? n.toFixed(3) : n.toFixed(2)} $`.replace(".", ",");

/** Tokens y gasto del turno: ↑ entrada nueva · ↓ salida · caché · coste. */
function StatsLine({ stats }: { stats: TurnStats }) {
  const u = stats.usage;
  if (u.input + u.output + u.cacheRead + u.cacheWrite === 0) return null;
  const detail = `Entrada ${u.input.toLocaleString("es-ES")} · salida ${u.output.toLocaleString("es-ES")} · caché leída ${u.cacheRead.toLocaleString("es-ES")} · caché escrita ${u.cacheWrite.toLocaleString("es-ES")} tokens. Coste aproximado con la tabla de precios de ULTRON.`;
  return (
    <span className="turn-stats num" title={detail} data-testid="turn-stats">
      ↑ {formatTokens(u.input + u.cacheWrite)} · ↓ {formatTokens(u.output)} · caché {formatTokens(u.cacheRead)}
      {stats.costUsd !== null && <> · <b>{usd(stats.costUsd)}</b></>}
    </span>
  );
}

export function TurnActions({ m, stats }: { m: ChatMessage; stats?: TurnStats }) {
  const api = useApi();
  const scope = useChatScope();
  const status = useStore((s) => s.engineStatus);
  const [busy, setBusy] = useState<EngineId | null>(null);
  const text = messageText(m);
  const actions = Boolean(scope && !scope.readOnly && text);
  if (!actions && !stats) return null;

  async function ask(engine: EngineId) {
    if (!scope) return;
    setBusy(engine);
    await runEngine(api, { sessionId: scope.sessionId, engine, prompt: opinionPrompt(text), kind: "opinion" });
    setBusy(null);
  }

  return (
    <div className="turn-acts" role="group" aria-label="Acciones de la respuesta">
      {actions && <CopyButton text={text} label="Copiar" />}
      {actions && <span className="sep" aria-hidden="true">·</span>}
      {actions && <span className="faint">Segunda opinión</span>}
      {actions && ENGINES.map((e) => {
        const reason = engineBlockReason(status, e);
        return (
          <button key={e} type="button" className={`ta-btn ${e}`} aria-disabled={Boolean(reason) || busy !== null}
            title={reason ? `No disponible: ${reason}` : `Pide a ${ENGINE_LABEL[e]} que revise esta respuesta con el contexto del hilo`}
            onClick={() => (reason ? reportError(`${ENGINE_LABEL[e]} no disponible: ${reason}`) : busy === null && void ask(e))}>
            → {ENGINE_LABEL[e]}{busy === e ? "…" : ""}
          </button>
        );
      })}
      {stats && <StatsLine stats={stats} />}
    </div>
  );
}
