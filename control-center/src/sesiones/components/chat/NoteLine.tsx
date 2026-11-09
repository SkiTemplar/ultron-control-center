// Nota del chat en su posición cronológica: resultado o error de un comando,
// aviso del puente o explicación de algo que no se envió (nunca un no-op silencioso).

import { formatClock } from "../../parse";
import type { ChatNote } from "../../session-state";

const MARK: Record<ChatNote["level"], string> = { info: "·", warn: "!", error: "✕" };

export function NoteLine({ note }: { note: ChatNote }) {
  return (
    <p className={`msg note ${note.level}`} role={note.level === "error" ? "alert" : "note"} data-testid="chat-note" data-level={note.level}>
      <span className="mk" aria-hidden="true">{MARK[note.level]}</span>
      <span className="note-text">{note.text}</span>
      {(note.count ?? 1) > 1 && <span className="note-count" title="Veces seguidas" data-testid="chat-note-count">×{note.count}</span>}
      <time className="ts" dateTime={note.at}>{formatClock(note.at)}</time>
    </p>
  );
}
