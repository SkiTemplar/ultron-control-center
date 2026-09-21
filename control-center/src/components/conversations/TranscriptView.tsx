// Panel derecho del navegador de conversaciones: la conversacion en burbujas.
//
// Los turnos llegan paginados de `read_session_transcript` (paginado por
// lineas del .jsonl, ver el modulo Rust). Los `tool_result` se pintan
// colapsados: forman parte del hilo pero no los escribio nadie.

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { BotonCopiar } from "../jarvis/BotonCopiar";
import remarkGfm from "remark-gfm";
import type { ClaudeSession } from "../../types/projects";
import { ChevronDown, ChevronRight, Loader, Play, Terminal } from "../projects/icons";
import type { TranscriptTurn } from "./types";
import { formatRel, formatTime, projectNameFor, shortModel, titleFor } from "./utils";

type Props = {
  session: ClaudeSession | null;
  turns: TranscriptTurn[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  charCapped: boolean;
  onLoadMore: () => void;
  onContinue: () => void;
  continuing: boolean;
};

const ROLE_LABEL: Record<string, string> = {
  user: "Tú",
  assistant: "Claude",
  tool: "Resultado de herramienta",
  system: "Sistema",
  other: "Evento",
};

export function TranscriptView({
  session,
  turns,
  loading,
  error,
  hasMore,
  charCapped,
  onLoadMore,
  onContinue,
  continuing,
}: Props) {
  if (!session) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          Elige una conversación de la lista para leerla completa.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header
        className="mx-auto flex w-full max-w-[820px] items-start justify-between gap-3 px-5 py-3"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px]" style={{ color: "var(--color-text)" }}>
            {titleFor(session, 90)}
          </h2>
          <p className="mt-0.5 truncate text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
            <span className="font-mono">{projectNameFor(session.project_label)}</span>
            {" · "}
            {formatRel(session.last_activity)}
            {" · "}
            {session.line_count} turnos
            {" · "}
            <span className="font-mono">{session.id.slice(0, 8)}</span>
          </p>
        </div>
        <button
          onClick={onContinue}
          disabled={continuing}
          title={`claude -r ${session.id}`}
          className="flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1.5 text-[12px]"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
            opacity: continuing ? 0.6 : 1,
          }}
        >
          {continuing ? <Loader /> : <Play />}
          Continuar
        </button>
      </header>

      {/* overflow-x-hidden + columna de lectura acotada: un transcript trae
          URLs, rutas y logs de una sola pieza, y sin esto el panel crece con
          su contenido y se sale de la ventana en vez de ajustarse. El ancho
          maximo tambien hace el texto legible en pantalla ancha. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4">
        <div className="mx-auto w-full max-w-[820px]">
        {error && (
          <p
            className="mb-3 rounded px-3 py-2 text-[12px]"
            style={{
              background: "rgba(248,81,73,0.12)",
              color: "var(--color-danger)",
              border: "1px solid var(--color-danger)",
            }}
          >
            {error}
          </p>
        )}

        {turns.map((t) => (
          <Turn key={t.line} turn={t} />
        ))}

        {loading && (
          <p className="py-4 text-center text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Cargando la conversación…
          </p>
        )}

        {!loading && turns.length === 0 && !error && (
          <p className="py-4 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Esta conversación no tiene mensajes legibles.
          </p>
        )}

        {charCapped && (
          <p className="pt-2 text-[10px]" style={{ color: "var(--color-warn)" }}>
            Página cortada por tamaño: sigue cargando para ver el resto.
          </p>
        )}

        {hasMore && !loading && (
          <button
            onClick={onLoadMore}
            className="mt-3 w-full rounded py-2 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text-secondary)",
            }}
          >
            Cargar más mensajes
          </button>
        )}
        </div>
      </div>
    </div>
  );
}

function Turn({ turn }: { turn: TranscriptTurn }) {
  const isTool = turn.role === "tool";
  const [open, setOpen] = useState(!isTool);
  const mine = turn.role === "user";

  return (
    <article className="mb-3">
      <div className="mb-1 flex items-center gap-1.5 text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
        {isTool ? (
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1"
            style={{ color: "var(--color-text-tertiary)" }}
            aria-expanded={open}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
            {ROLE_LABEL[turn.role] ?? turn.role}
          </button>
        ) : (
          <span style={{ color: mine ? "var(--color-text-secondary)" : "var(--color-success)" }}>
            {ROLE_LABEL[turn.role] ?? turn.role}
          </span>
        )}
        {turn.model && <span className="font-mono">{shortModel(turn.model)}</span>}
        {turn.timestamp && <span>{formatTime(turn.timestamp)}</span>}
        {turn.tools.map((tool) => (
          <span
            key={tool}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }}
          >
            <Terminal />
            {tool}
          </span>
        ))}
      </div>

      {open && turn.text && (
        <div
          className="rounded px-3 py-2 text-[12px]"
          style={{
            background: mine ? "var(--color-surface-3)" : "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            // Un transcript trae rutas y logs larguisimos: sin esto la burbuja
            // fuerza scroll horizontal en toda la pagina.
            overflowWrap: "anywhere",
          }}
        >
          {isTool ? (
            <pre className="whitespace-pre-wrap font-mono text-[11px]" style={{ margin: 0 }}>
              {turn.text}
            </pre>
          ) : (
            <div className="cc-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
            </div>
          )}
          {turn.truncated && (
            <p className="mt-1 text-[10px]" style={{ color: "var(--color-text-faint)" }}>
              (mensaje recortado)
            </p>
          )}
          {/* Copiar el mensaje, igual que en el chat. Pedido el 2026-09-21:
              "tanto en los chats como en las conversaciones". */}
          <div className="mt-1.5 flex justify-end">
            <BotonCopiar texto={turn.text} />
          </div>
        </div>
      )}
    </article>
  );
}
