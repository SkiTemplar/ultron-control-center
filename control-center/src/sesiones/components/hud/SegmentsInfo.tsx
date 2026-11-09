// Segmentos informativos del HUD: git, adjuntos, coste y motor del relevo.

import type { GitState } from "../../hooks/useGit";
import { statsOfTurn } from "../../timeline";
import { formatTokens } from "../../parse";
import { useSession, useStore } from "../../store";
import type { RelayState, SessionId } from "../../types";
import { openInspector } from "../../ui";
import { Dropdown } from "../Dropdown";
import type { Attachment } from "../composer/useAttachments";
import { RELAY_LABEL } from "../composer/RelayBanner";
import { useEngines } from "../inspector/UsoMotores";
import { formatUsd, relayQuotaText, relayTurnTokens } from "./hud-data";
import { SegLabel } from "./SegmentsSession";

function stCode(c: { index_status: string; worktree_status: string; untracked: boolean }): string {
  if (c.untracked) return "U";
  const s = c.worktree_status.trim() || c.index_status.trim();
  return s || "M";
}

export function GitSeg({ git }: { git: GitState }) {
  const st = git.snapshot?.state;
  if (!st?.is_repo) {
    return (
      <Dropdown label="Git" placement="up" width={260} triggerClass="hseg" testId="hud-git"
        header={<p className="dd-note">{git.error ? `Git no responde: ${git.error}` : git.loading ? "Leyendo el repositorio…" : "Este directorio no es un repositorio git."}</p>}
        trigger={<SegLabel k="git" v="—" />} />
    );
  }
  const changes = git.snapshot?.changes ?? [];
  const header = (
    <div className="dd-detail">
      <p className="dd-note"><b>{st.branch ?? "HEAD separado"}</b>{st.remote ? ` · ${st.remote}` : ""} · ↑{st.ahead} ↓{st.behind}</p>
      {changes.length === 0 ? <p className="dd-note">Árbol limpio.</p> : (
        <ul className="dd-files">
          {changes.slice(0, 8).map((c) => (
            <li key={c.path}><span className={`st ${stCode(c)}`}>{stCode(c)}</span><span className="p">{c.path}</span></li>
          ))}
          {changes.length > 8 && <li className="faint">y {changes.length - 8} más</li>}
        </ul>
      )}
      <div className="dd-acts">
        <button className="btn sm" onClick={() => openInspector("git")}>Abrir Git</button>
        <button className="btn sm ghost" onClick={git.reload}>Recargar</button>
      </div>
    </div>
  );
  return (
    <Dropdown label="Git" placement="up" width={340} triggerClass="hseg" testId="hud-git" triggerTitle="Rama y cambios" header={header}
      trigger={<SegLabel k="⎇" v={<>{st.branch ?? "HEAD"}{st.dirty_count > 0 && <span className="warn-text"> ●{st.dirty_count}</span>}{st.ahead > 0 && <span className="faint"> ↑{st.ahead}</span>}</>} />} />
  );
}

export function AttachSeg({ id, pending }: { id: SessionId; pending: Attachment[] }) {
  const sent = useSession(id).attachments.length;
  // Sin nada pendiente ni enviado, el segmento no dice nada: no ocupa la línea.
  if (pending.length === 0 && sent === 0) return null;
  const header = (
    <div className="dd-detail">
      {pending.length === 0 ? <p className="dd-note">Nada pendiente de enviar.</p> : (
        <ul className="dd-files">
          {pending.map((a) => <li key={a.path}><span className="st">{a.previewDataUrl ? "img" : "fic"}</span><span className="p">{a.name}</span></li>)}
        </ul>
      )}
      <p className="dd-note">{sent} enviado{sent === 1 ? "" : "s"} en esta sesión.</p>
      <div className="dd-acts"><button className="btn sm ghost" onClick={() => openInspector("adjuntos")}>Abrir Adjuntos</button></div>
    </div>
  );
  return (
    <Dropdown label="Adjuntos" placement="up" width={300} triggerClass="hseg hud-opt-2" testId="hud-attach"
      triggerTitle={pending.length > 0 ? `${pending.length} pendiente${pending.length === 1 ? "" : "s"} de enviar · ${sent} enviado${sent === 1 ? "" : "s"}` : `${sent} enviado${sent === 1 ? "" : "s"} en esta sesión`}
      header={header} trigger={<SegLabel k="adj" v={String(pending.length > 0 ? pending.length : sent)} tone={pending.length > 0 ? "info" : ""} />} />
  );
}

/** Coste del último turno cerrado según el puente (principal y subagentes, USO-01) y de la sesión. */
export function CostSeg({ id, cost, model }: { id: SessionId; cost: number | null; model: string | null }) {
  const turns = useSession(id).turns;
  const last = turns[turns.length - 1];
  const turn = last ? statsOfTurn(last, model)?.costUsd ?? null : null;
  // Sin coste todavía, un «—» sin clave no dice nada.
  if (cost === null && turn === null) return null;
  const header = (
    <div className="dd-detail">
      <div className="dd-row"><span>Último turno</span><span className="num">{formatUsd(turn)}</span></div>
      <div className="dd-row"><span>Sesión</span><span className="num">{formatUsd(cost)}</span></div>
      <p className="dd-note">Equivalente en API; con plan no se cobra aparte.</p>
    </div>
  );
  return (
    <Dropdown label="Coste" placement="up" align="end" width={280} triggerClass="hseg hud-opt-3" testId="hud-cost" triggerTitle="Coste del turno y de la sesión" header={header}
      trigger={<SegLabel k="" v={turn !== null ? `${formatUsd(turn)} / ${formatUsd(cost)}` : formatUsd(cost)} />} />
  );
}

/** Motor del relevo, cuota de su ventana y tokens del turno; consulta el uso solo con relevo. */
function RelayActiveSeg({ relay }: { relay: RelayState }) {
  const { data, error } = useEngines(0);
  const engines = useStore((s) => s.engines);
  // Solo las tareas del relevo en curso: las de relevos anteriores no cuentan.
  const current = new Set(relay.taskIds);
  const tokens = relayTurnTokens(engines.filter((t) => current.has(t.id)));
  const name = RELAY_LABEL[relay.activeEngine];
  const quota = relayQuotaText(data, error, relay.activeEngine);
  const tokenText = tokens === null ? "tokens sin dato" : `${formatTokens(tokens)} tok`;
  return (
    <button className="hseg" data-testid="hud-relay" onClick={() => openInspector("uso")}
      title={error ? `Relevo en ${name}. No se pudo leer su uso: ${error}` : `Relevo en ${name}: cuota de su ventana y tokens del turno`}>
      <SegLabel k="relevo" v={name} tone="warn" />
      <SegLabel k="" v={quota} />
      <SegLabel k="" v={tokenText} opt="hud-opt-1" />
    </button>
  );
}

/** Sin relevo no pinta nada ni consulta el uso de los motores. */
export function RelaySeg({ id }: { id: SessionId }) {
  const relay = useStore((s) => s.relays[id] ?? null);
  return relay ? <RelayActiveSeg relay={relay} /> : null;
}
