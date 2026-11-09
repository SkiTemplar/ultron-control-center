// Mascota — cabecera del bocadillo de chat (motor, marca de adjuntos, «ver
// chat», «nueva» y cerrar) y la conversación desplegada (chatLog.ts).

import { useEffect, useRef } from "react";
import { AgentIcon, agentBackground, type AgentId } from "./icons";
import { Linkified } from "./bubble";
import type { Turn } from "./chatLog";

interface HeadProps {
  agent: AgentId;
  label: string;
  tainted: boolean;
  /** La conversación trajo web o ficheros: el freno pide confirmar cada acción. */
  guarded?: boolean;
  turns: number;
  /** «nueva» solo con el cuadro de texto abierto (no a mitad de respuesta). */
  canReset: boolean;
  showLog: boolean;
  onToggleLog: () => void;
  onReset: () => void;
  onClose: () => void;
}

export function ChatHead(p: HeadProps) {
  return (
    <div className="mascot-panel-head">
      <span className="mascot-dot" style={{ background: agentBackground(p.agent) }}>
        <AgentIcon id={p.agent} size={12} />
      </span>
      <span className="mascot-agent">{p.label}</span>
      {p.tainted && <span className="mascot-ro">{p.agent === "antigravity" ? "🔒 solo lectura" : "📎 con adjuntos"}</span>}
      {p.guarded && p.agent === "claude" && (
        <span
          className="mascot-ro"
          title="Esta conversación ha leído la web o ficheros: cada acción pide confirmación. «Nueva» la limpia."
        >
          🛡 confirma acciones
        </span>
      )}
      {p.turns > 0 && (
        <button
          type="button"
          className="mascot-link"
          aria-expanded={p.showLog}
          title={p.showLog ? "Plegar la conversación" : "Ver la conversación entera"}
          onClick={p.onToggleLog}
        >
          {p.showLog ? "plegar ▴" : `ver chat (${p.turns}) ▾`}
        </button>
      )}
      {p.turns > 0 && p.canReset && (
        <button type="button" className="mascot-link" title="Archivar esta conversación y empezar otra" onClick={p.onReset}>
          nueva
        </button>
      )}
      <button type="button" className="mascot-x" title="Cerrar (Esc)" onClick={p.onClose}>
        ×
      </button>
    </div>
  );
}

/** La conversación entera, con el final a la vista. */
export function ChatTranscript({ turns, linksEnabled }: { turns: readonly Turn[]; linksEnabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);
  return (
    <div ref={ref} className="mascot-transcript" data-testid="mascot-transcript">
      {turns.map((t, i) => (
        <div key={i} className={`mascot-turn mascot-turn--${t.role}`}>
          {t.role === "assistant" ? <Linkified text={t.text} linksEnabled={linksEnabled} /> : t.text}
        </div>
      ))}
    </div>
  );
}
