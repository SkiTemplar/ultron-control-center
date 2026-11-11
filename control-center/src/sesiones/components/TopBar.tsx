// Barra superior: marca, proyecto y rama, estado de la sesión, ajustes e inspector.
// El detalle (modelo, effort, contexto, uso) vive en la línea de estado bajo el composer.

import { reportError } from "../bootstrap";
import { useApi } from "../context";
import { ENGINE_LABEL } from "../engines";
import { useGit } from "../hooks/useGit";
import { useFocused } from "../hooks/useFocused";
import { useSession } from "../store";
import type { SessionId } from "../types";
import { useUi } from "../ui";
import { useCallback, useEffect, useState } from "react";
import { ExportMenu } from "./ExportMenu";
import { IconBranch, IconExpand, IconGear, IconList, IconPanel } from "./icons";
import { SessionDot } from "./SessionDot";
import { permissionLabel, SettingsDialog } from "./SettingsDialog";

interface Props {
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onToggleDrawer: (d: "rail" | "insp") => void;
}

export function prettyModel(model: string | null | undefined): string {
  if (!model) return "—";
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(model);
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

export function TopBar({ inspectorOpen, onToggleInspector, onToggleDrawer }: Props) {
  const api = useApi();
  const { session } = useFocused();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<{ sessionId: SessionId; focus: boolean } | null>(null);
  // Clic en el modo del HUD (WP-CHAT): Ajustes → Sesión actual de esa sesión.
  const settingsRequest = useUi((s) => s.sessionSettingsRequest);
  useEffect(() => {
    if (!settingsRequest) return;
    setSettingsFor({ sessionId: settingsRequest.sessionId, focus: true });
    setSettingsOpen(true);
  }, [settingsRequest]);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsFor(null);
  }, []);
  const status = useSession(session?.id ?? null).status;
  const git = useGit(session?.cwd ?? null);
  const branch = git.snapshot?.state.is_repo ? git.snapshot.state.branch : null;

  return (
    <header className="topbar">
      <span className="brand" title="ULTRON Sessions — The Ultimate Claude Code Interface">ULTRON <span className="brand-sub">Sessions</span></span>
      <button className="tbtn only-narrow" onClick={() => onToggleDrawer("rail")} aria-label="Mostrar sesiones">
        <IconList /> Sesiones
      </button>
      <div className="crumb">
        {session ? (
          <>
            <span>{session.projectName}</span>
            <span className="sep">/</span>
            <b title={session.title}>{session.title}</b>
            {branch && (
              <span className="branch hide-narrow" title="Rama actual">
                <IconBranch /> {branch}
              </span>
            )}
          </>
        ) : (
          <b>The Ultimate Claude Code Interface</b>
        )}
      </div>
      <span className="spacer" />
      {session?.engine && (
        <span className="pill hide-narrow" title="Motor y modelo de la sesión" data-testid="engine-session-pill">
          <SessionDot session={session} />
          <span className={`dd-dot ${session.engine}`} aria-hidden="true" />
          {ENGINE_LABEL[session.engine]} · <b>{session.model ?? "predeterminado"}</b>
        </span>
      )}
      {session && !session.engine && (
        <span className="pill hide-narrow" title="Motor, modelo y modo de permisos">
          <SessionDot session={session} />
          Claude · <b>{prettyModel(status?.model ?? session.model)}</b>
          {session.permissionMode ? (
            <> · <span className={session.permissionMode === "bypassPermissions" ? "warn-text" : undefined}>{permissionLabel(session.permissionMode)}</span></>
          ) : status?.mode && <> · {status.mode}</>}
        </span>
      )}
      {session && !session.engine && <ExportMenu sessionId={session.id} />}
      <button
        className="tbtn"
        onClick={() => void api.openControlCenter().catch(reportError)}
        aria-label="Abrir el Control Center"
        title="Abrir el Control Center"
        data-testid="open-control-center"
      >
        <IconExpand /> <span className="hide-narrow">Control Center</span>
      </button>
      <button className="tbtn" onClick={() => setSettingsOpen(true)} aria-label="Ajustes" title="Ajustes">
        <IconGear />
      </button>
      <button className="tbtn hide-narrow" aria-pressed={inspectorOpen} onClick={onToggleInspector} title="Inspector">
        <IconPanel /> Inspector
      </button>
      <button className="tbtn only-narrow" onClick={() => onToggleDrawer("insp")} aria-label="Mostrar inspector">
        <IconPanel /> Inspector
      </button>
      {settingsOpen && (
        <SettingsDialog onClose={closeSettings} sessionId={settingsFor?.sessionId ?? session?.id ?? null} focusCurrent={settingsFor?.focus ?? false} />
      )}
    </header>
  );
}
