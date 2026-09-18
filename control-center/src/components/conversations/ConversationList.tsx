// Panel izquierdo del navegador de conversaciones: buscador + lista agrupada
// por fecha, estilo Claude Desktop.
//
// La busqueda usa `rankBySearch` (el mismo ranker fuzzy + sinonimos que ya
// usan Skills y Agents) en lugar del `String.includes()` que arrastra la
// pestana Sessions: con 73 transcripts en disco, un `includes` obliga a
// recordar la palabra exacta que escribiste hace tres meses.

import { useMemo } from "react";
import type { ClaudeSession } from "../../types/projects";
import { rankBySearch, type SearchableItem } from "../../lib/ranked-search";
import { Search, Loader, RefreshCw } from "../projects/icons";
import { BUCKET_ORDER, type DateBucket } from "./types";
import { bucketFor, formatRel, projectNameFor, titleFor } from "./utils";

type Props = {
  sessions: ClaudeSession[];
  selectedId: string | null;
  onSelect: (s: ClaudeSession) => void;
  query: string;
  onQueryChange: (q: string) => void;
  loading: boolean;
  onRefresh: () => void;
};

/** Item decorado para el ranker: nombre = titulo, descripcion = preview. */
type RankedSession = SearchableItem & { __entry: ClaudeSession };

export function ConversationList({
  sessions,
  selectedId,
  onSelect,
  query,
  onQueryChange,
  loading,
  onRefresh,
}: Props) {
  // Orden base: mas reciente primero. El ranker solo reordena cuando hay query.
  const ordered = useMemo(() => {
    const decorated: RankedSession[] = sessions.map((s) => ({
      name: titleFor(s, 200),
      description: s.preview ?? "",
      tags: [projectNameFor(s.project_label), s.id],
      __entry: s,
    }));
    if (!query.trim()) {
      return [...sessions].sort((a, b) =>
        (b.last_activity ?? "").localeCompare(a.last_activity ?? ""),
      );
    }
    return rankBySearch(decorated, query).map((d) => d.__entry);
  }, [sessions, query]);

  // Con query activa la lista va por relevancia (agrupar por fecha
  // destrozaria ese orden), asi que solo agrupamos cuando no hay busqueda.
  const grouped = useMemo(() => {
    if (query.trim()) return null;
    const map = new Map<DateBucket, ClaudeSession[]>();
    for (const s of ordered) {
      const b = bucketFor(s.last_activity);
      const list = map.get(b);
      if (list) list.push(s);
      else map.set(b, [s]);
    }
    return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({
      bucket: b,
      items: map.get(b) as ClaudeSession[],
    }));
  }, [ordered, query]);

  return (
    <div
      className="flex h-full flex-col"
      style={{ borderRight: "1px solid var(--color-border)" }}
    >
      <div
        className="flex items-center gap-2 px-3 py-3"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2">
            <Search />
          </span>
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Buscar en tus conversaciones…"
            aria-label="Buscar conversaciones"
            className="w-full rounded py-1.5 pl-7 pr-2 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          />
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Recargar la lista"
          aria-label="Recargar la lista"
          className="rounded p-1.5"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text-secondary)",
            opacity: loading ? 0.5 : 1,
          }}
        >
          {loading ? <Loader /> : <RefreshCw />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {ordered.length === 0 && !loading && (
          <p className="px-3 py-6 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            {query.trim()
              ? `Ninguna conversación coincide con "${query}".`
              : "Todavía no hay conversaciones en ~/.claude/projects."}
          </p>
        )}

        {grouped
          ? grouped.map((g) => (
              <div key={g.bucket}>
                <h3
                  className="sticky top-0 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide"
                  style={{
                    background: "var(--color-surface-1)",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  {g.bucket} · {g.items.length}
                </h3>
                {g.items.map((s) => (
                  <Row
                    key={`${s.project_slug}-${s.id}`}
                    session={s}
                    selected={s.id === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ))
          : ordered.map((s) => (
              <Row
                key={`${s.project_slug}-${s.id}`}
                session={s}
                selected={s.id === selectedId}
                onSelect={onSelect}
              />
            ))}
      </div>
    </div>
  );
}

function Row({
  session,
  selected,
  onSelect,
}: {
  session: ClaudeSession;
  selected: boolean;
  onSelect: (s: ClaudeSession) => void;
}) {
  return (
    <button
      onClick={() => onSelect(session)}
      aria-current={selected ? "true" : undefined}
      className="block w-full px-3 py-2 text-left transition-colors"
      style={{
        background: selected ? "var(--color-surface-4)" : "transparent",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <span
        className="block truncate text-[12px]"
        style={{ color: "var(--color-text)" }}
      >
        {titleFor(session)}
      </span>
      <span
        className="mt-0.5 flex items-center gap-1.5 text-[10px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <span className="truncate font-mono">{projectNameFor(session.project_label)}</span>
        <span>·</span>
        <span className="whitespace-nowrap">{formatRel(session.last_activity)}</span>
        <span>·</span>
        <span className="whitespace-nowrap">{session.line_count} turnos</span>
      </span>
    </button>
  );
}
