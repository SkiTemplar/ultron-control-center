// Chat de una sesión (o del transcript de un subagente) en estética de
// terminal: línea de tiempo con las intervenciones de otros motores y las notas,
// eco de lo enviado, respuesta en vivo, intervenciones del turno en curso,
// bloque de menú, tarjetas de confianza y Ask, y el composer con su línea de estado.

import { memo, useCallback, useEffect, useMemo } from "react";
import { loadHistory, loadOlder, refreshAgents, refreshWorkflows } from "../../bootstrap";
import { conversationKey } from "../../bookmarks";
import { useApi } from "../../context";
import { ECHO_LABEL, type Echo } from "../../echo";
import { ENGINE_LABEL } from "../../engines";
import { formatClock } from "../../parse";
import { pagingOf } from "../../session-state";
import { store, useAsks, useSession, useSessionInfo, useStore } from "../../store";
import { buildTimelineParts, createThreadDerivedCache, createTimelineCache, deriveThread, sessionTasks } from "../../timeline";
import type { ChatMessage, SessionId, SessionInfo } from "../../types";
import { Composer } from "../composer/Composer";
import { AskCard } from "./AskCard";
import { BookmarksMenu } from "./Bookmarks";
import { ChatScopeContext } from "./ChatContext";
import { EngineBlock } from "./EngineBlock";
import { LiveBubble } from "./LiveBubble";
import { HistoryError, MessageList } from "./MessageList";
import { MenuBlock, TrustCard } from "./SessionCards";
import { ThreadSearchBar, useThreadSearch } from "./ThreadSearch";

const noMessages: ChatMessage[] = [];
// El composer tiene sus propias suscripciones: no se repinta con cada cambio de la sesión que repinta el chat.
const StableComposer = memo(Composer);

function Skeleton() {
  return (
    <div className="scroll" aria-busy="true">
      <div className="skeleton w62" />
      <div className="skeleton w48" />
      <div className="skeleton w70" />
    </div>
  );
}

function useTimeline(sessionId: SessionId, agentId: string | null, messages: ChatMessage[], info: SessionInfo | null) {
  const isMain = agentId === null;
  const engines = useStore((s) => s.engines);
  const dismissed = useStore((s) => s.dismissed);
  const { notes, turns } = useSession(sessionId);
  const tasks = useMemo(() => (isMain ? sessionTasks(engines, sessionId, dismissed) : []), [engines, sessionId, dismissed, isMain]);
  const open = info?.status === "working" || info?.status === "waiting";
  const model = info?.model ?? null;
  // Una caché por hilo: los turnos y las filas que no cambian conservan sus objetos.
  const cache = useMemo(() => createTimelineCache(), [sessionId, agentId]);
  return useMemo(
    () => buildTimelineParts(messages, tasks, isMain ? { lastTurnOpen: open, notes, turns, model, cache } : { cache }),
    [messages, tasks, isMain, open, notes, turns, model, cache],
  );
}

/** Eco optimista de un envío hasta que llega su mensaje del transcript (§5.2). */
function EchoMessage({ e }: { e: Echo }) {
  return (
    <article className="msg user echo" data-role="user" data-echo={e.state} data-testid="echo">
      <div className="line">
        <span className="mk prompt" aria-hidden="true">❯</span>
        <div className="ubody">
          <div className="utext">{e.text}</div>
          <span className="faint echo-state">{ECHO_LABEL[e.state]}{e.attachments.length > 0 ? ` · ${e.attachments.length} adj.` : ""}</span>
        </div>
        <time className="ts" dateTime={e.at}>{formatClock(e.at)}</time>
      </div>
    </article>
  );
}

/** Título del chat vacío: subagente, Claude arrancando o sesión (de Claude o de un motor) lista. */
function emptyTitle(agentId: string | null, info: SessionInfo | null): string {
  if (agentId) return "Sin transcript todavía";
  if (info?.engine) return `Sesión de ${ENGINE_LABEL[info.engine]} lista`;
  return info?.status === "starting" ? "Claude está arrancando" : "Sesión lista";
}

export function ChatPane({ sessionId, agentId }: { sessionId: SessionId; agentId: string | null }) {
  const api = useApi();
  const info = useSessionInfo(sessionId);
  const state = useSession(sessionId);
  const asks = useAsks(sessionId);
  const interrupting = useStore((s) => s.interruptingAsks);
  const raw = agentId ? state.agentMessages[agentId] ?? noMessages : state.messages;
  const agent = agentId ? state.agents.find((a) => a.agentId === agentId) : null;
  const loaded = agentId ? raw !== noMessages : state.historyLoaded || state.messages.length > 0;
  const isMain = agentId === null;
  // Un reset vacía también los hilos de subagente, pero el arranque solo recarga el
  // principal: el panel de un subagente vuelve a pedir el suyo con cada generación.
  const agentGeneration = agentId ? state.generation : 0;

  useEffect(() => {
    // El hilo principal ya cargado lo mantienen al día los eventos `messages`, y un
    // reset lo recarga desde bootstrap: remontar el panel no vuelve a pedir la página.
    const mainLoaded = !agentId && store.getState().bySession[sessionId]?.historyLoaded === true;
    if (!mainLoaded) void loadHistory(api, sessionId, agentId);
    if (!agentId) void refreshAgents(api, sessionId);
    if (!agentId && typeof api.workflows === "function") void refreshWorkflows(api, sessionId);
  }, [api, sessionId, agentId, agentGeneration]);

  const paging = pagingOf(state, agentId);
  const onLoadOlder = useCallback(() => void loadOlder(api, sessionId, agentId), [api, sessionId, agentId]);
  const onRetry = useCallback(() => void loadHistory(api, sessionId, agentId, true), [api, sessionId, agentId]);
  const onPinned = useCallback(
    (pinned: boolean) => store.dispatch({ type: "historyPaging", id: sessionId, agentId, patch: { pinned } }),
    [sessionId, agentId],
  );
  // Visibles e índice de resultados: se extienden con lo nuevo en vez de recorrer todo el hilo.
  const derivedCache = useMemo(() => createThreadDerivedCache(), [sessionId, agentId]);
  const { visible, results } = useMemo(() => deriveThread(derivedCache, raw), [derivedCache, raw]);
  const { items, pendingEngines } = useTimeline(sessionId, agentId, visible, info);
  const bookmarks = isMain && info ? conversationKey(info) : null;
  const scope = useMemo(() => ({ sessionId, readOnly: agentId !== null, bookmarks }), [sessionId, agentId, bookmarks]);
  const isLoaded = useCallback((uuid: string) => raw.some((m) => m.uuid === uuid), [raw]);
  const visibleAsks = agentId ? asks.filter((a) => a.kind === "permission" && a.agentId === agentId) : asks;
  const echoes = isMain ? state.echoes : [];
  const search = useThreadSearch(sessionId, agentId);

  const tail = (
    <>
      {echoes.map((e) => <EchoMessage key={e.clientId} e={e} />)}
      <LiveBubble sessionId={sessionId} agentId={agentId} />
      {pendingEngines.map((t) => <EngineBlock key={t.id} task={t} />)}
      {isMain && info?.waiting?.kind === "trust" && <TrustCard info={info} />}
      {isMain && info && <MenuBlock info={info} />}
      {visibleAsks.map((a) => <AskCard key={a.askId} ask={a} interrupting={interrupting.includes(a.askId)} />)}
    </>
  );
  const empty = items.length === 0 && echoes.length === 0 && visibleAsks.length === 0 && info?.status !== "working" && info?.waiting === null;

  return (
    <ChatScopeContext.Provider value={scope}>
      <div className="chat" data-session={sessionId} data-search={search.open || undefined}>
        {search.open && <ThreadSearchBar search={search} items={items} results={results} paging={paging} onLoadOlder={onLoadOlder} />}
        {!loaded ? (
          <Skeleton />
        ) : empty && paging.loadError ? (
          <div className="empty-state term-empty">
            <HistoryError error={paging.loadError} onRetry={onRetry} />
          </div>
        ) : empty ? (
          <div className="empty-state term-empty">
            <div>
              <p className="mono-banner" aria-hidden="true">✻ ULTRON Sessions</p>
              <h2>{emptyTitle(agentId, info)}</h2>
              {agentId && <p>El subagente aún no ha escrito nada.</p>}
              {!agentId && info?.engine && <p>Trabaja en <code>{info.cwd}</code> con un proceso de {ENGINE_LABEL[info.engine]} que sigue vivo entre turnos; el hilo se conserva al cerrar y se puede retomar.</p>}
            </div>
          </div>
        ) : (
          <>
            <MessageList items={items} results={results} tail={tail} paging={paging} onLoadOlder={onLoadOlder} onRetry={onRetry} onPinned={onPinned} searchJump={search.jump} />
            {bookmarks && <BookmarksMenu sessionId={sessionId} conversation={bookmarks} isLoaded={isLoaded} />}
          </>
        )}
        {agentId ? (
          <div className="composer">
            <p className="composer-note">
              Transcript de <b>{agent?.type ?? "subagente"}</b>{agent ? ` · ${agent.description}` : ""}. Solo lectura: escribe en la sesión principal.
            </p>
          </div>
        ) : (
          <StableComposer sessionId={sessionId} />
        )}
      </div>
    </ChatScopeContext.Provider>
  );
}
