// Un panel de la rejilla: cabecera con selector de sesión o subagente,
// «Sacar a ventana» y Cerrar; cuerpo con el chat. Con un solo panel y la sesión
// principal no hay cabecera (el título ya sale en la pestaña y en la barra
// lateral) y «Sacar a ventana» pasa a la barra de pestañas. No hay vista de
// terminal: los menús de la TUI se manejan en el bloque de menú del chat (SessionCards).

import { useState } from "react";
import { lastUsedProfile, newSessionHere, newSessionTitle, useLaunchProfiles } from "../launch-profiles";
import { reportError } from "../bootstrap";
import { useApi } from "../context";
import { useStore } from "../store";
import type { SessionId } from "../types";
import { closePane, focusPane, setPaneTarget, updateWorkspace, type Pane } from "../workspace";
import { ChatPane } from "./chat/ChatPane";
import { Dropdown, type DropdownOption } from "./Dropdown";
import { ErrorBoundary } from "./ErrorBoundary";
import { IconChevronDown, IconClose, IconExpand } from "./icons";

function TargetSelect({ pane, index }: { pane: Pane; index: number }) {
  const sessions = useStore((s) => s.sessions);
  const bySession = useStore((s) => s.bySession);
  const value = pane.sessionId ? `${pane.sessionId}|${pane.agentId ?? ""}` : "";
  const options: DropdownOption[] = sessions.flatMap((s) => [
    { value: `${s.id}|`, label: s.title, description: `${s.projectName} · sesión principal`, group: s.projectName, tone: s.status },
    ...(bySession[s.id]?.agents ?? []).map((a) => ({
      value: `${s.id}|${a.agentId}`,
      label: `↳ ${a.type}`,
      description: a.description,
      group: s.projectName,
      tone: a.status === "running" ? "working" : "",
    })),
  ]);
  const current = options.find((o) => o.value === value);
  return (
    <Dropdown
      label={`Contenido del panel ${index + 1}`}
      triggerClass="dd-trigger pane-target"
      triggerTitle="Sesión o subagente de este panel"
      value={value}
      options={options}
      width={340}
      onSelect={(v) => {
        const [sid, agent] = v.split("|");
        updateWorkspace((w) => setPaneTarget(w, index, sid || null, agent || null));
      }}
      trigger={<><span className="dd-value">{current?.label ?? "Elige una sesión…"}</span><IconChevronDown /></>}
    />
  );
}

function EmptyPane() {
  const api = useApi();
  const title = newSessionTitle(lastUsedProfile(useLaunchProfiles()));
  return (
    <div className="empty-state">
      <div>
        <h2>Panel libre</h2>
        <div className="acts">
          <button className="btn pri" onClick={() => void newSessionHere(api, null)} title={title}>Nueva sesión</button>
        </div>
      </div>
    </div>
  );
}

/**
 * «Sacar a ventana»: abre la sesión en una ventana propia (con su botón en la
 * barra de tareas) y la quita de este panel, para que no quede en dos sitios.
 */
export function PopOutButton({ sessionId, index, compact = false }: { sessionId: SessionId; index: number; compact?: boolean }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  async function popOut() {
    setBusy(true);
    try {
      await api.newWindow(sessionId);
      updateWorkspace((w) => closePane(w, index));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="tbtn pane-pop" disabled={busy} onClick={() => void popOut()} title="Sacar a ventana: abre esta sesión en una ventana propia"
      aria-label={compact ? "Sacar a ventana" : undefined} data-testid="pane-pop">
      <IconExpand />{!compact && <span className="pop-label">Sacar a ventana</span>}
    </button>
  );
}

interface Props {
  pane: Pane;
  index: number;
  focused: boolean;
  count: number;
}

/** Sin cabecera solo con un panel y la sesión principal: un subagente o un panel libre la necesitan. */
export function paneHasHead(pane: Pane, count: number): boolean {
  return count > 1 || pane.agentId !== null || !pane.sessionId;
}

export function PaneView({ pane, index, focused, count }: Props) {
  const head = paneHasHead(pane, count);
  return (
    <section
      className="pane"
      data-focused={focused}
      data-pane-index={index}
      data-head={head ? undefined : "off"}
      aria-label={`Panel ${index + 1}`}
      onMouseDownCapture={() => updateWorkspace((w) => focusPane(w, index))}
      onFocusCapture={() => updateWorkspace((w) => focusPane(w, index))}
    >
      {head && <div className="pane-head">
        {count > 1 && <span className="k" title={`Ctrl+${index + 1}`}>{index + 1}</span>}
        <TargetSelect pane={pane} index={index} />
        <span className="spacer" />
        {pane.sessionId && pane.agentId === null && <PopOutButton sessionId={pane.sessionId} index={index} />}
        {count > 1 && (
          <button className="icon-btn" aria-label={`Cerrar panel ${index + 1}`} title="Cerrar panel (Ctrl+W)" onClick={() => updateWorkspace((w) => closePane(w, index))}>
            <IconClose />
          </button>
        )}
      </div>}
      {!pane.sessionId ? (
        <EmptyPane />
      ) : (
        // La clave remonta el chat al cambiar de sesión o subagente: el scroll, el anclaje
        // al final y la búsqueda del hilo anterior no pasan al nuevo.
        <ErrorBoundary scope="este panel" resetKey={`${pane.sessionId}:${pane.agentId ?? ""}`}>
          <ChatPane key={`${pane.sessionId}:${pane.agentId ?? ""}`} sessionId={pane.sessionId} agentId={pane.agentId} />
        </ErrorBoundary>
      )}
    </section>
  );
}
