// Respuesta en vivo: una entrada por (paso, bloque) del puente, hasta que su
// mensaje definitivo la retira por identidad (§5.3). El razonamiento va plegado
// en una línea desplegable (O6) y las herramientas del turno en una sola línea
// con el recuento (O5, F14), la misma del mensaje guardado: dice qué corre y se
// despliega. Sin respuesta guardada en el turno, lleva la cabecera «Claude · modelo».

import { memo, useMemo, useState } from "react";
import { usePrefs } from "../../prefs";
import { useSession, useSessionInfo } from "../../store";
import { useStream, type StreamEntry } from "../../stream";
import { currentTurnActivity, turnHasReply } from "../../timeline";
import type { SessionId } from "../../types";
import type { LiveTool } from "../../session-state";
import { prettyModel } from "../TopBar";
import { Markdown, MarkdownBlocks } from "./Markdown";
import { splitBlocks, toolLabel } from "./terminal-format";
import { LiveToolRow } from "./ToolRow";

function StreamText({ text, done }: { text: string; done: boolean }) {
  const { blocks, tail } = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="line">
      <span className="mk reply live" aria-hidden="true">⏺</span>
      <div className="stream">
        {blocks.length > 0 && <MarkdownBlocks blocks={blocks} />}
        {tail && <Markdown text={tail} live />}
        {!done && <span className="caret" aria-hidden="true" />}
      </div>
    </div>
  );
}

const TAIL_CHARS = 110;

/** Última frase del razonamiento, para seguirlo sin desplegar. */
export function thinkingTail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TAIL_CHARS ? `…${flat.slice(flat.length - TAIL_CHARS)}` : flat;
}

function LiveThinking({ text, active }: { text: string; active: boolean }) {
  const words = text.trim().split(/\s+/).length;
  return (
    <details className="think live" data-active={active}>
      <summary>
        <span className="mk" aria-hidden="true">✻</span>
        {active ? "Razonando…" : "Razonamiento"}
        <span className="faint">· {words} {words === 1 ? "palabra" : "palabras"}</span>
        {active && <span className="think-tail faint">{thinkingTail(text)}</span>}
      </summary>
      <p>{text}</p>
    </details>
  );
}

const SUMMARY_CHARS = 32;

/** «2 acciones · Bash 1 (Start-Sleep 600…) · Read 1»: como la línea del mensaje guardado. */
export function liveActivitySummary(tools: readonly LiveTool[]): string {
  const byName = new Map<string, LiveTool[]>();
  tools.forEach((t) => byName.set(t.name, [...(byName.get(t.name) ?? []), t]));
  const parts = [...byName.entries()].slice(0, 4).map(([name, list]) => {
    const running = list.find((t) => t.phase === "start" && t.summary.trim());
    const hint = running ? running.summary.split("\n")[0].trim() : "";
    const clipped = hint.length > SUMMARY_CHARS ? `${hint.slice(0, SUMMARY_CHARS - 1)}…` : hint;
    return `${toolLabel(name)} ${list.length}${clipped ? ` (${clipped})` : ""}`;
  });
  const more = byName.size > 4 ? " · …" : "";
  return `${tools.length} ${tools.length === 1 ? "acción" : "acciones"} · ${parts.join(" · ")}${more}`;
}

function LiveActivity({ tools }: { tools: readonly LiveTool[] }) {
  const [open, setOpen] = useState(false);
  const summary = liveActivitySummary(tools);
  return (
    <>
      <button className="activity" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="live-folded"
        title={open ? "Plegar las herramientas del turno" : "Ver las herramientas del turno"}>
        <span className="mk res" aria-hidden="true">⎿</span>
        <span className="act-sum" title={summary}>{summary}</span>
        <span className="faint act-more">· {open ? "plegar" : "ver detalle"}</span>
      </button>
      {open && (
        <div className="tools">
          {tools.map((t) => <LiveToolRow key={t.toolUseId} tool={t} />)}
        </div>
      )}
    </>
  );
}

function Entry({ e, showThinking }: { e: StreamEntry; showThinking: boolean }) {
  return (
    <>
      {showThinking && e.thinking && <LiveThinking text={e.thinking} active={!e.text && !e.done && !e.stepDone} />}
      {e.text && <StreamText text={e.text} done={e.done || e.stepDone} />}
    </>
  );
}

function LiveBubbleImpl({ sessionId, agentId }: { sessionId: SessionId; agentId: string | null }) {
  const entries = useStream(sessionId, agentId);
  const state = useSession(sessionId);
  const info = useSessionInfo(sessionId);
  const liveTools = useMemo(() => state.liveTools.filter((t) => t.agentId === agentId), [state.liveTools, agentId]);
  // Con herramientas ya en el transcript, la línea de actividad del mensaje lleva el recuento: no se repite aquí.
  const persisted = useMemo(() => (agentId === null ? currentTurnActivity(state.messages, []).tools : 0), [agentId, state.messages]);
  const replied = useMemo(() => turnHasReply(state.messages), [state.messages]);
  const { showThinking, compactTools } = usePrefs();
  if (entries.length === 0 && (liveTools.length === 0 || (compactTools && persisted > 0))) return null;

  return (
    <article className="msg assistant live" data-engine="claude" aria-busy={entries.some((e) => !e.done)} data-testid="live-bubble">
      {agentId === null && !replied && (
        <div className="meta">
          <span className="who">Claude</span>
          {info?.model && <span className="model">{prettyModel(info.model)}</span>}
        </div>
      )}
      {compactTools && liveTools.length > 0 && persisted === 0 && <LiveActivity tools={liveTools} />}
      {!compactTools && liveTools.length > 0 && (
        <div className="tools">
          {liveTools.map((t) => <LiveToolRow key={t.toolUseId} tool={t} />)}
        </div>
      )}
      {entries.map((e) => <Entry key={e.key} e={e} showThinking={showThinking} />)}
    </article>
  );
}

/** Memoizada: se repinta por sus propias suscripciones (texto en vivo y sesión), no con cada render del chat. */
export const LiveBubble = memo(LiveBubbleImpl);
