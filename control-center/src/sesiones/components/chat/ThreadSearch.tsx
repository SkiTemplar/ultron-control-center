// Búsqueda en el hilo de un chat (Ctrl+F): barra compacta encima de la lista.
// Busca sin mayúsculas ni tildes en los mensajes cargados (texto y resultados de
// herramientas) con un debounce corto y coincidencias memorizadas; empieza por
// la más reciente y Enter sube a la anterior, como el buscador de una terminal.
// Si quedan páginas antiguas sin cargar, lo dice en vez de fingir que buscó en
// todo. Sin listeners globales: las teclas se atienden en la propia barra.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ToolResultBlock } from "../../parse";
import type { ThreadPaging } from "../../session-state";
import { consumeThreadSearch, findMatches, matchLabel, stepMatch, useThreadSearchRequest, type ThreadMatch } from "../../thread-search";
import type { TimelineItem } from "../../timeline";
import type { SessionId } from "../../types";
import { IconClose } from "../icons";
import type { SearchJump } from "./search-jump";

export const SEARCH_DEBOUNCE_MS = 120;

/** Contador de saltos de todo el módulo: reabrir la barra no repite un `tick` ya atendido. */
let jumpSeq = 0;

export interface ThreadSearchState {
  owner: string;
  open: boolean;
  /** Cambia con cada Ctrl+F: la barra vuelve a tomar el foco y selecciona el término. */
  focusTick: number;
  jump: SearchJump | null;
  setJump: (jump: SearchJump | null) => void;
  close: () => void;
}

/** Estado de la búsqueda de un chat; se cierra sola si el panel pasa a pintar otro hilo. */
export function useThreadSearch(sessionId: SessionId, agentId: string | null): ThreadSearchState {
  const owner = useId();
  const target = `${sessionId}|${agentId ?? ""}`;
  const request = useThreadSearchRequest(sessionId, agentId);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [jump, setJump] = useState<SearchJump | null>(null);
  useEffect(() => {
    if (!request) return;
    consumeThreadSearch(request.tick);
    setOpenFor(target);
    setFocusTick((t) => t + 1);
  }, [request, target]);
  const close = useCallback(() => {
    setOpenFor(null);
    setJump(null);
  }, []);
  const open = openFor === target;
  return { owner, open, focusTick, jump: open ? jump : null, setJump, close };
}

interface BarProps {
  search: ThreadSearchState;
  items: readonly TimelineItem[];
  results: ReadonlyMap<string, ToolResultBlock>;
  paging: ThreadPaging;
  onLoadOlder: () => void;
}

/** Término con debounce: los hilos largos no se recorren con cada tecla. */
function useDebounced(query: string): [string, (q: string) => void] {
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    if (query === debounced) return;
    const t = window.setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, debounced]);
  return [debounced, setDebounced];
}

export function ThreadSearchBar({ search, items, results, paging, onLoadOlder }: BarProps) {
  const { owner, focusTick, setJump, close } = search;
  const [query, setQuery] = useState("");
  const [debounced, flush] = useDebounced(query);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => findMatches(items, results, debounced), [items, results, debounced]);
  const active = activeKey === null ? -1 : matches.findIndex((m) => m.key === activeKey);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusTick]);

  const go = useCallback((target: ThreadMatch | null, term: string) => {
    setActiveKey(target?.key ?? null);
    if (!target) return setJump(null);
    jumpSeq += 1;
    setJump({ owner, key: target.key, turn: target.turn, query: term, tick: jumpSeq });
  }, [owner, setJump]);

  // Término nuevo: a la coincidencia más reciente. Si solo llegan mensajes, la activa se conserva.
  const searched = useRef("");
  useEffect(() => {
    if (debounced === searched.current) return;
    searched.current = debounced;
    go(matches.length > 0 ? matches[matches.length - 1] : null, debounced);
  }, [debounced, matches, go]);

  const step = (dir: 1 | -1) => {
    if (query !== debounced) return flush(query);
    const next = stepMatch(active, matches.length, dir);
    if (next >= 0) go(matches[next], debounced);
  };

  const finish = () => {
    const composer = input.current?.closest(".chat")?.querySelector<HTMLTextAreaElement>(".composer textarea");
    close();
    composer?.focus();
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) step(e.shiftKey ? 1 : -1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "ArrowDown") step(1);
    else return;
    e.preventDefault();
  };

  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    finish();
  };

  const searching = debounced.trim().length > 0;
  return (
    <div className="thread-search" role="search" aria-label="Buscar en el hilo" onKeyDown={onBarKey} data-testid="thread-search">
      <input
        ref={input}
        className="ts-input"
        aria-label="Buscar en el hilo"
        placeholder="Buscar en el hilo…"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKey}
      />
      <span className="ts-count" role="status" aria-live="polite" title="Mensajes con coincidencias" data-testid="thread-search-count">
        {searching ? matchLabel(active, matches.length) : ""}
      </span>
      <button className="icon-btn ts-nav" aria-label="Coincidencia anterior" title="Anterior, más antigua (Enter o ↑)" disabled={matches.length === 0} onClick={() => step(-1)}>↑</button>
      <button className="icon-btn ts-nav" aria-label="Coincidencia siguiente" title="Siguiente, más reciente (Mayús+Enter o ↓)" disabled={matches.length === 0} onClick={() => step(1)}>↓</button>
      {paging.hasMore && (
        <span className="ts-more" data-testid="thread-search-more">
          Hay mensajes anteriores sin cargar
          <button className="btn sm" disabled={paging.loading} onClick={onLoadOlder}>{paging.loading ? "Cargando…" : "Cargar anteriores"}</button>
        </span>
      )}
      <button className="icon-btn ts-close" aria-label="Cerrar búsqueda" title="Cerrar (Esc)" onClick={finish}><IconClose /></button>
    </div>
  );
}
