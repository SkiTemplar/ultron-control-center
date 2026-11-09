// Línea de tiempo con autodesplazamiento: mensajes del transcript y bloques
// de otros motores, siempre virtualizada con @tanstack/react-virtual (alturas
// medidas), así una sesión larga no pinta miles de nodos ni cambia de árbol al
// crecer. Arriba, la cabecera del historial paginado (§7): «cargando
// anteriores» o «inicio de la conversación».

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ToolResultBlock } from "../../parse";
import type { ThreadPaging } from "../../session-state";
import type { TimelineItem } from "../../timeline";
import { ErrorBoundary } from "../ErrorBoundary";
import { useBookmarkJump } from "./bookmark-jump";
import { EngineBlock } from "./EngineBlock";
import { Message, rendersNothing } from "./Message";
import { usePrefs } from "../../prefs";
import { useUi } from "../../ui";
import { NoteLine } from "./NoteLine";
import { useLoadOlder, useStickToBottom } from "./scroll-hooks";
import { useSearchJump, type SearchJump } from "./search-jump";

const ESTIMATE_PX = 96;

function ItemBody({ item, results }: { item: TimelineItem; results: Map<string, ToolResultBlock> }) {
  if (item.kind === "engine") return <EngineBlock task={item.task} />;
  if (item.kind === "note") return <NoteLine note={item.note} />;
  return <Message m={item.m} results={results} continued={item.continued} endsTurn={item.endsTurn} turn={item.turn} activity={item.activity} stats={item.stats} inTurn={item.inTurn} />;
}

/** Barrera por fila: un mensaje que no se puede pintar no se lleva el hilo por delante. */
export function Item({ item, results }: { item: TimelineItem; results: Map<string, ToolResultBlock> }) {
  const content = item.kind === "engine" ? item.task : item.kind === "note" ? item.note : item.m;
  return <ErrorBoundary scope="este mensaje" resetKey={content}><ItemBody item={item} results={results} /></ErrorBoundary>;
}

interface Props {
  items: TimelineItem[];
  results: Map<string, ToolResultBlock>;
  /** Contenido al final (burbuja en vivo, tarjetas Ask). */
  tail: ReactNode;
  paging: ThreadPaging;
  onLoadOlder: () => void;
  /** Vuelve a pedir la última página tras un fallo de carga (`paging.loadError`). */
  onRetry?: () => void;
  /** El usuario deja (o vuelve a) el final del chat. */
  onPinned?: (pinned: boolean) => void;
  /** Coincidencia activa de la búsqueda del hilo (Ctrl+F). */
  searchJump?: SearchJump | null;
}

export function HistoryError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="history-head err-text" role="alert" data-testid="history-error">
      No se pudo cargar el historial: {error}
      {onRetry && <button className="btn sm" onClick={onRetry}>Reintentar</button>}
    </div>
  );
}

function HistoryHead({ paging, onRetry }: { paging: ThreadPaging; onRetry?: () => void }) {
  if (paging.loadError) return <HistoryError error={paging.loadError} onRetry={onRetry} />;
  if (paging.loading) {
    return <div className="history-head" role="status" data-testid="history-loading"><span className="spin" aria-hidden="true" /> Cargando anteriores…</div>;
  }
  if (!paging.hasMore) return <div className="history-head" data-testid="history-start">Inicio de la conversación</div>;
  return <div className="history-head" aria-hidden="true" />;
}

/** Distancia desde el principio del contenido desplazable hasta la lista. */
function useListOffset(scrollRef: RefObject<HTMLDivElement | null>, listRef: RefObject<HTMLDivElement | null>): number {
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const next = Math.round(list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop);
    if (next !== offset) setOffset(next);
  });
  return offset;
}

interface VirtualProps {
  items: TimelineItem[];
  results: Map<string, ToolResultBlock>;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Solo para volver a medir el desplazamiento de la lista cuando cambia la cabecera del historial. */
  paging: ThreadPaging;
  searchJump: SearchJump | null;
  /** Suelta el anclaje abajo antes de saltar a un mensaje (marcador o Ctrl+F). */
  releaseStick: () => void;
}

/** Quita las filas que no pintan nada (ver `rendersNothing`). */
function useDrawnItems(items: TimelineItem[], results: Map<string, ToolResultBlock>): TimelineItem[] {
  const compactTools = usePrefs().compactTools;
  const expandedTurns = useUi((s) => s.expandedTurns);
  return useMemo(
    () => items.filter((it) => it.kind !== "msg" || !rendersNothing(it.m, { results, endsTurn: it.endsTurn, activity: it.activity, inTurn: it.inTurn }, { compactTools, expanded: Boolean(it.turn && expandedTurns[it.turn]) })),
    [items, results, compactTools, expandedTurns],
  );
}

/**
 * Memoizada: el chat se repinta con cada cambio de la sesión (estado, herramientas
 * en vivo, la lista de sesiones que el puente reemite al avanzar la actividad),
 * pero la lista solo depende de sus filas, de los resultados y de la cabecera.
 */
const Virtual = memo(function Virtual({ items: all, results, scrollRef, searchJump, releaseStick }: VirtualProps) {
  const items = useDrawnItems(all, results);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollMargin = useListOffset(scrollRef, listRef);
  const keys = useMemo(() => items.map((it) => it.key), [items]);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATE_PX,
    // Al (re)enganchar el elemento, el virtualizador vuelve a su desplazamiento conocido: que sea el real.
    initialOffset: () => scrollRef.current?.scrollTop ?? 0,
    overscan: 8,
    scrollMargin,
    getItemKey: (i) => keys[i],
    // Si cambia un extremo de la lista (página anterior antepuesta, mensajes
    // soltados por la cota o un mensaje nuevo), el elemento visible se queda
    // donde estaba: el scroll no salta.
    anchorTo: "end",
  });
  // La ref del contenedor (un ancestro) se asigna después de los efectos de layout de
  // esta lista: en el primer montaje el virtualizador no lo ve y, memoizada, la lista
  // no vuelve a pintarse si el hilo ya estaba cargado (reinicio, recarga, cambio de
  // panel): quedaba en blanco. Un efecto pasivo, ya con las refs puestas, fuerza la
  // segunda pasada.
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (scrollRef.current && v.scrollElement !== scrollRef.current) repaint();
  });
  useBookmarkJump(items, v, scrollRef, releaseStick);
  useSearchJump(items, v, scrollRef, searchJump, releaseStick);
  return (
    <div className="vlist" ref={listRef} style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={v.measureElement}
          className="vrow"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
        >
          <Item item={items[row.index]} results={results} />
        </div>
      ))}
    </div>
  );
});

export function MessageList({ items, results, tail, paging, onLoadOlder, onRetry, onPinned, searchJump = null }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { stuck, stuckRef, jump, release } = useStickToBottom(ref, content);
  useLoadOlder(ref, stuckRef, paging.hasMore && !paging.loading, onLoadOlder, items.length);
  useEffect(() => {
    if (stuck) return;
    onPinned?.(true);
    // Al volver abajo o desmontar el chat nadie lee arriba: la cota en vivo vuelve a la normal.
    return () => onPinned?.(false);
  }, [stuck, onPinned]);

  return (
    <div className="scroll-wrap">
      <div className={`scroll${stuck ? "" : " has-jump"}`} ref={ref} data-testid="message-scroll">
        <div ref={content}>
          <HistoryHead paging={paging} onRetry={onRetry} />
          <Virtual items={items} results={results} scrollRef={ref} paging={paging} searchJump={searchJump} releaseStick={release} />
          <div className="scroll-inner">{tail}</div>
        </div>
      </div>
      {!stuck && (
        <button className="btn sm jump" onClick={jump}>
          ↓ Ir al final
        </button>
      )}
    </div>
  );
}
