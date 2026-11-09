// Tribunal de Motores: las respuestas de Codex y Gemini al mismo encargo,
// lado a lado, con «Contrastar en Claude» (un solo envío con las dos y la
// petición de contrastarlas; el backend las marca como traídas).

import { useState } from "react";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { canContrast } from "../../engines";
import type { EngineTask, SessionInfo } from "../../types";
import { TaskCard } from "./MotoresTaskCard";

function ContrastButton({ group, target }: { group: EngineTask[]; target: string }) {
  const api = useApi();
  const [sending, setSending] = useState(false);
  async function contrast() {
    const id = group[0]?.group;
    if (!id) return;
    setSending(true);
    try {
      await api.engineContrast({ group: id, sessionId: target });
    } catch (e) {
      reportError(e);
    } finally {
      setSending(false);
    }
  }
  return (
    <button className="btn sm pri" disabled={sending} aria-busy={sending} onClick={() => void contrast()}>
      {sending ? "Enviando…" : "Contrastar en Claude"}
    </button>
  );
}

/** Por qué todavía no se puede contrastar, o `null` si se puede. */
function contrastBlock(group: EngineTask[]): string | null {
  if (group.some((t) => t.status === "running")) return "Esperando a que respondan los dos motores…";
  if (group.some((t) => t.broughtAt)) return "Ya se trajo a Claude.";
  if (group.some((t) => t.status !== "done")) return "Un motor falló o se canceló: trae a Claude la respuesta que sí terminó.";
  return null;
}

export function TribunalCard({ group, session }: { group: EngineTask[]; session: SessionInfo | null }) {
  const target = group[0]?.sessionId ?? session?.id;
  const block = contrastBlock(group);
  return (
    <div className="cx-tribunal" data-testid="engine-tribunal">
      <div className="cx-head">
        <span className="t" title={group[0]?.prompt}>Tribunal · {group[0]?.prompt}</span>
      </div>
      <div className="cx-tribunal-grid">
        {group.map((t) => <TaskCard key={t.id} task={t} session={session} inTribunal />)}
      </div>
      <div className="cx-acts">
        {canContrast(group) && target && <ContrastButton group={group} target={target} />}
        {block && <span className="s">{block}</span>}
      </div>
    </div>
  );
}
