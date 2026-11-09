// Línea de estado (HUD, E3) fija bajo el composer: modelo · permisos · effort ·
// contexto · 5 h y semana con ritmo · socrático · git · adjuntos · coste. Una sola
// fila: si no cabe, se ocultan por prioridad los segmentos `hud-opt-*` (hud.css);
// modelo, permisos, contexto, 5 h y rama se quedan siempre.
// Los atajos de modelo, effort y modo ejecutan lo mismo que el comando y su
// resultado aparece en el chat. El modo de permisos es siempre el real.

import { useEffect } from "react";
import { loadSettings } from "../../bootstrap";
import { useApi } from "../../context";
import { ENGINE_LABEL } from "../../engines";
import type { GitState } from "../../hooks/useGit";
import { useSession, useStore } from "../../store";
import type { SessionInfo } from "../../types";
import type { Attachment } from "../composer/useAttachments";
import { AttachSeg, CostSeg, GitSeg, RelaySeg } from "./SegmentsInfo";
import { ContextSeg, EffortSeg, ModelSeg, PermSeg, SegLabel, SocraticSeg, UsageSeg } from "./SegmentsSession";

interface Props {
  info: SessionInfo;
  pending: Attachment[];
  git: GitState;
}

/**
 * HUD de una sesión de motor: modelo fijo de la sesión, permisos traducidos al motor,
 * git y adjuntos. Sin effort, contexto, cuota, relevo, socrático ni coste de Claude Code.
 */
function EngineStatusLine({ info, pending, git }: Props) {
  const engine = info.engine;
  if (!engine) return null;
  return (
    <div className="hud" role="toolbar" aria-label="Línea de estado de la sesión" data-testid="statusline" data-engine={engine}>
      <span className="hseg model" data-testid="hud-engine-model" title="El modelo se fija al crear la sesión">
        <SegLabel k={ENGINE_LABEL[engine]} v={info.model ?? "predeterminado"} />
      </span>
      <PermSeg info={info} mode={info.permissionMode} />
      <GitSeg git={git} />
      <AttachSeg id={info.id} pending={pending} />
    </div>
  );
}

export function StatusLine(props: Props) {
  return props.info.engine ? <EngineStatusLine {...props} /> : <ClaudeStatusLine {...props} />;
}

function ClaudeStatusLine({ info, pending, git }: Props) {
  const api = useApi();
  const id = info.id;
  const status = useSession(id).status;
  const settings = useStore((s) => s.settings[id] ?? null);
  const model = status?.model ?? settings?.model ?? info.model;
  const mode = info.permissionMode ?? status?.mode ?? settings?.permissionMode ?? null;

  // Los ajustes se recargan al entrar y cuando el puente informa de otro modelo.
  useEffect(() => {
    void loadSettings(api, id);
  }, [api, id, status?.model]);

  return (
    <div className="hud" role="toolbar" aria-label="Línea de estado de la sesión" data-testid="statusline">
      <ModelSeg id={id} model={model} />
      <PermSeg info={info} mode={mode} />
      <EffortSeg id={id} effort={settings?.effort ?? null} />
      <ContextSeg id={id} status={status} />
      <UsageSeg />
      <RelaySeg id={id} />
      <SocraticSeg id={id} projectId={settings?.projectId ?? info.projectId} mode={settings?.socratic ?? null} />
      <GitSeg git={git} />
      <AttachSeg id={id} pending={pending} />
      <CostSeg id={id} cost={status?.costUsd ?? null} model={model} />
    </div>
  );
}
