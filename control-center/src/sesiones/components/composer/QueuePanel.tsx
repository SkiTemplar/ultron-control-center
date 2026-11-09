// Mensajes en cola sobre el composer (§5.2, R7, COLA-05): la cola es la del
// backend; cada elemento se puede editar (texto y adjuntos), borrar, reordenar,
// marcar como delegación a subagente, enviar ya o reintentar si falló. Salen de
// uno en uno, en orden, al terminar cada turno.

import { useEffect, useRef, useState } from "react";
import { addNote, reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { moveItem, removeItem, retryItem, sendNow, targetIndex, updateItem, useQueue } from "../../queue";
import { store, useSession } from "../../store";
import type { QueueItem, SessionId } from "../../types";

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

interface EditorProps {
  item: QueueItem;
  onSave: (text: string, attachments: string[]) => void;
  onCancel: () => void;
  /** El editor desaparece sin Guardar ni Cancelar (el elemento salió de la cola). */
  onLost: (text: string, attachments: string[]) => void;
}

function Editor({ item, onSave, onCancel, onLost }: EditorProps) {
  const [draft, setDraft] = useState(item.text);
  const [paths, setPaths] = useState(item.attachments);
  const latest = useRef({ draft, paths, done: false, onLost });
  useEffect(() => {
    latest.current = { ...latest.current, draft, paths, onLost };
  });
  useEffect(() => () => {
    const l = latest.current;
    if (!l.done) l.onLost(l.draft.trim(), l.paths);
  }, []);
  const save = () => {
    latest.current.done = true;
    onSave(draft.trim(), paths);
  };
  const cancel = () => {
    latest.current.done = true;
    onCancel();
  };
  return (
    <div className="qedit-box">
      <textarea className="qedit" aria-label="Editar mensaje en cola" value={draft} autoFocus rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") cancel();
        }} />
      {paths.length > 0 && (
        <div className="attach" aria-label="Adjuntos del mensaje en cola">
          {paths.map((p) => (
            <span className="att" key={p} title={p}>
              <span className="an">{fileName(p)}</span>
              <button className="icon-btn" aria-label={`Quitar ${fileName(p)}`} onClick={() => setPaths((l) => l.filter((x) => x !== p))}>✕</button>
            </span>
          ))}
        </div>
      )}
      <span className="qacts">
        <button className="linkbtn" disabled={!draft.trim() && paths.length === 0} onClick={save}>Guardar</button>
        <button className="linkbtn" onClick={cancel}>Cancelar</button>
      </span>
    </div>
  );
}

/**
 * Fallo sin confirmación de la CLI (`resolver_huerfanos`): el texto se escribió en
 * el PTY y no hubo eco en el transcript a tiempo, pero Claude pudo recibirlo.
 */
function mayHaveBeenSent(item: QueueItem): boolean {
  return item.error?.includes("no confirmó el envío") ?? false;
}

/** Reintentar; si el envío pudo llegar, primero avisa del riesgo de duplicarlo. */
function RetryControl({ item, onRetry }: { item: QueueItem; onRetry: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return <button className="linkbtn" onClick={() => (mayHaveBeenSent(item) ? setAsking(true) : onRetry())}>Reintentar</button>;
  }
  return (
    <span className="qconfirm" role="alertdialog" aria-label="Confirmar reenvío">
      <span className="warn-text">Puede que Claude ya lo recibiera: revisa el chat antes de reenviarlo.</span>
      <button className="linkbtn" onClick={() => {
        setAsking(false);
        onRetry();
      }}>Reenviar igualmente</button>
      <button className="linkbtn" onClick={() => setAsking(false)}>No reenviar</button>
    </span>
  );
}

function Row({ sessionId, item, index, total, all }: { sessionId: SessionId; item: QueueItem; index: number; total: number; all: QueueItem[] }) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const run = (p: Promise<unknown>) => void p.catch(reportError);
  const editable = item.origin === "ultron";
  // Si el backend envía o borra el elemento con el editor abierto, la fila desaparece:
  // la edición no se aplicó y se avisa con el texto para no perderlo en silencio.
  const lost = (text: string, attachments: string[]) => {
    const now = store.getState().bySession[sessionId]?.queue.find((q) => q.clientId === item.clientId);
    if (now && (now.state === "queued" || now.state === "failed")) return; // panel cerrado, sigue en cola
    if (text === item.text && attachments.length === item.attachments.length) return;
    addNote(sessionId, "warn", `El mensaje salió de la cola mientras lo editabas y tu edición no se aplicó: «${text || "(solo adjuntos)"}»`);
  };
  const move = (dir: -1 | 1) => {
    const to = targetIndex(all, item.clientId, dir);
    if (to !== null) run(moveItem(api, sessionId, item.clientId, to));
  };
  return (
    <li className="qitem" data-delegate={item.delegate || undefined} data-state={item.state} data-testid="queue-item">
      <span className="qn" aria-hidden="true">{index + 1}</span>
      {editing ? (
        <Editor item={item} onLost={lost} onCancel={() => setEditing(false)} onSave={(text, attachments) => {
          setEditing(false);
          run(updateItem(api, sessionId, item.clientId, { text, attachments }));
        }} />
      ) : (
        <button className="qtext" title={editable ? "Editar" : "Escrito en la terminal: no se edita desde aquí"} disabled={!editable} onClick={() => setEditing(true)}>
          {item.delegate && <span className="qtag">subagente</span>}
          {item.kind !== "prompt" && <span className="qtag">{item.kind === "command" ? "comando" : "bash"}</span>}
          {item.text || "(solo adjuntos)"}
          {item.attachments.length > 0 && <span className="faint"> · {item.attachments.length} adj.</span>}
          {item.state === "failed" && <span className="err-text" role="alert"> · falló: {item.error ?? "sin detalle"}</span>}
          {/* Envío en vuelo repuesto al restaurar la sesión: avisa de que saldrá otra vez. */}
          {item.state === "queued" && item.error && <span className="warn-text" data-testid="queue-item-warn"> · {item.error}</span>}
        </button>
      )}
      {!editing && (
        <span className="qacts">
          {item.state === "failed" && <RetryControl item={item} onRetry={() => run(retryItem(api, sessionId, item.clientId))} />}
          {editable && (
            <button className="chipbtn sm" aria-pressed={item.delegate} title="Encargarlo a un subagente en segundo plano"
              onClick={() => run(updateItem(api, sessionId, item.clientId, { delegate: !item.delegate }))}>Delegar</button>
          )}
          {item.state === "queued" && <button className="chipbtn sm" title="Enviarlo ahora: Claude lo lee a mitad de turno" onClick={() => run(sendNow(api, sessionId, item.clientId))}>Enviar ya</button>}
          <button className="icon-btn" aria-label="Subir" disabled={index === 0} onClick={() => move(-1)}>↑</button>
          <button className="icon-btn" aria-label="Bajar" disabled={index === total - 1} onClick={() => move(1)}>↓</button>
          <button className="icon-btn" aria-label="Borrar de la cola" onClick={() => run(removeItem(api, sessionId, item.clientId))}>✕</button>
        </span>
      )}
    </li>
  );
}

export function QueuePanel({ sessionId }: { sessionId: SessionId }) {
  const api = useApi();
  const queue = useQueue(sessionId);
  const all = useSession(sessionId).queue;
  if (queue.length === 0) return null;
  const queued = queue.filter((q) => q.state === "queued").length;
  return (
    <section className="queue" aria-label="Mensajes en cola" data-testid="queue">
      <header className="faint">
        En cola · salen de uno en uno, en orden, al terminar cada turno
        {queued > 1 && <button className="linkbtn" onClick={() => void sendNow(api, sessionId).catch(reportError)}>Enviar todos ya</button>}
      </header>
      <ol>
        {queue.map((q, i) => (
          <Row key={q.clientId} sessionId={sessionId} item={q} index={i} total={queue.length} all={all} />
        ))}
      </ol>
    </section>
  );
}
