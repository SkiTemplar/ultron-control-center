// Contexto: tokens frente a la ventana, reparto estimado por categoría y aviso de compactar.

import { useMemo } from "react";
import { estimateContext, formatTokens } from "../../parse";
import { useSession } from "../../store";
import { NoSession } from "./Inspector";

const COLORS: Record<string, string> = {
  system: "var(--faint)",
  reads: "var(--accent)",
  tools: "var(--ok)",
  messages: "var(--info)",
  thinking: "var(--codex)",
};

export function Contexto({ sessionId }: { sessionId: string | null }) {
  const state = useSession(sessionId);
  const status = state.status;
  const slices = useMemo(() => (status ? estimateContext(state.messages, status.contextTokens) : []), [state.messages, status]);
  if (!sessionId) return <NoSession />;
  if (!status) return <p className="note">Sin datos de contexto.</p>;
  const pct = status.contextWindow > 0 ? Math.round((status.contextTokens / status.contextWindow) * 100) : 0;

  return (
    <>
      <div className="big num">
        {formatTokens(status.contextTokens)} <small>de {formatTokens(status.contextWindow)} · {pct} %</small>
      </div>
      <div className="stack" role="img" aria-label={`Reparto del contexto: ${pct} % usado`}>
        {slices.map((s) => (
          <i key={s.key} style={{ width: `${(s.tokens / Math.max(1, status.contextWindow)) * 100}%`, background: COLORS[s.key] }} />
        ))}
      </div>
      <div className="legend num">
        {slices.map((s) => (
          <span key={s.key} style={{ display: "contents" }}>
            <span className="lg-sw" style={{ background: COLORS[s.key] }} />
            <span>{s.label}</span>
            <span>{formatTokens(s.tokens)}</span>
          </span>
        ))}
      </div>
      {pct >= 70 ? (
        <div className="callout warn"><b>Contexto alto:</b> por encima del 70 % conviene <code>/compact</code> o un relevo con <code>/relevo</code>.</div>
      ) : (
        <div className="callout"><b>Margen:</b> quedan {formatTokens(status.contextWindow - status.contextTokens)} tokens antes de llenar la ventana.</div>
      )}
      {typeof status.costUsd === "number" && (
        <div className="kv"><span>Coste equivalente de la sesión</span><span>{status.costUsd.toFixed(2)} USD</span></div>
      )}
    </>
  );
}
