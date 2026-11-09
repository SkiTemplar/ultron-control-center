// Línea de estado única encima del composer (§5.5): siempre en el mismo sitio,
// con la causa si está colgado y los controles de recuperación de §3.1
// (Interrumpir, Recuperar, Reiniciar, Salir del menú, Enviar ahora) y «Segundo
// plano» (§3.4). Ningún botón está deshabilitado sin decir por qué.

import { useEffect, useState } from "react";
import { useBackgroundWork } from "../../background";
import { addNote, reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { sendNow } from "../../queue";
import { useAsks, useSession } from "../../store";
import { useStream } from "../../stream";
import type { RecoverAction, SessionInfo } from "../../types";
import {
  forgetSubagentResume, recoverNote, rememberRecover, resumedBySubagent as resumedByTask, runRecover, useSubagentResume, type RecoverNote,
} from "../composer/recover-note";
import { backgroundNow } from "../composer/force";
import { restoreAndDetach } from "./menu-terminal";
import { statusLine, type StatusAction } from "./status-line";

const LABEL: Record<StatusAction, string> = {
  interrupt: "Interrumpir",
  recover: "Recuperar",
  restart: "Reiniciar sesión",
  exitMenu: "Salir del menú",
  sendNow: "Enviar ahora",
  releaseTerminal: "Soltar la terminal",
  background: "Segundo plano",
};

const TITLE: Record<StatusAction, string> = {
  interrupt: "Aborta el turno en curso (Esc con el composer vacío)",
  recover: "Interrumpe y, si no responde, cierra cualquier menú de la TUI",
  restart: "Relanza Claude Code con la misma conversación y la misma cola",
  exitMenu: "Cierra el menú de la TUI (Esc con el composer vacío)",
  sendNow: "Envía ya lo que espera en la cola (tras interrumpir o con la cola en pausa)",
  releaseTerminal: "Devuelve el PTY a su tamaño y suelta la terminal del menú para que la cola vuelva a drenar",
  background: "Pasa la herramienta en curso a segundo plano (Ctrl+B); Claude sigue y te avisa al terminar",
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export function ChatStatus({ info }: { info: SessionInfo }) {
  const api = useApi();
  const state = useSession(info.id);
  const asks = useAsks(info.id);
  const stream = useStream(info.id, null);
  const [busy, setBusy] = useState<StatusAction | null>(null);
  const now = useNow(info.status === "working" || info.status === "waiting" || Boolean(info.queuePause));
  const resumedBySubagent = useSubagentResume(info.id);
  const background = useBackgroundWork(info.id);
  const lastTurn = state.turns[state.turns.length - 1];
  const thinking = stream.some((e) => e.thinking) && !stream.some((e) => e.text);
  const model = statusLine(info, state.liveTools, asks, {
    now, lastTurnAborted: lastTurn?.reason === "aborted", thinking, queue: state.queue, resumedBySubagent, mainRunning: state.mainRunning, background,
  });
  useEffect(() => {
    if (info.status !== "working") forgetSubagentResume(info.id);
  }, [info.status, info.id]);

  async function act(action: StatusAction) {
    setBusy(action);
    try {
      if (action === "sendNow") await sendNow(api, info.id);
      else if (action === "background") await backgroundNow(api, info.id);
      else if (action === "recover") await recoverChain();
      else if (action === "releaseTerminal") await releaseTerminal();
      else await recoverOnce(action as RecoverAction);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  }

  function report(note: RecoverNote) {
    if (note.level === "error") reportError(note.text);
    else addNote(info.id, note.level, note.text);
  }

  /** Interrumpir, reiniciar o salir del menú: el resultado se cuenta si falla. */
  async function recoverOnce(action: RecoverAction) {
    if (action !== "restart") {
      await runRecover(api, info.id, action, report);
      return;
    }
    const out = await api.recover({ id: info.id, action });
    rememberRecover(info.id, out);
    const note = recoverNote(out);
    if (note) report(note);
  }

  /**
   * Cola en pausa por una terminal de menú que nadie soltó (ventana recargada o
   * cerrada). Se suelta aunque falle la restauración del tamaño: el botón existe
   * para que la cola vuelva a drenar (mismo criterio que el cierre del menú).
   */
  async function releaseTerminal() {
    await restoreAndDetach(api, info.id, reportError);
  }

  /**
   * Recuperar = interrumpir y, si no vuelve y hay un menú a la vista, salirse de él
   * (§3.1). Un turno nuevo o un turno que sigue sin menú no se arreglan con Esc
   * sobre un menú: el aviso ya lo dio la máquina o la nota de la interrupción.
   */
  async function recoverChain() {
    const first = await runRecover(api, info.id, "interrupt", report);
    if (!first || first.ok || resumedByTask(first)) return;
    const menu = info.screen === "dialog" || info.waiting?.kind === "menu";
    if (!menu) return;
    await runRecover(api, info.id, "exitMenu", report);
  }

  return (
    <div className={`chat-status tone-${model.tone}`} role="status" aria-live="polite" data-testid="chat-status" data-tone={model.tone}>
      <span className={`cs-dot ${model.tone}`} aria-hidden="true" />
      <span className="cs-text">{model.text}</span>
      {model.actions.length > 0 && (
        <span className="cs-acts">
          {model.actions.map((a) => (
            <button key={a} className={`btn sm${a === "restart" ? " danger" : ""}`} disabled={busy !== null}
              title={busy !== null ? "Hay una acción de recuperación en curso" : TITLE[a]} onClick={() => void act(a)} data-testid={`status-${a}`}>
              {busy === a ? `${LABEL[a]}…` : LABEL[a]}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
