// Un mensaje del transcript en estética de terminal (E2): `❯` para el prompt
// del usuario, `⏺` para la respuesta, `✻` para el razonamiento y las
// herramientas con su línea `⎿`. Al final de cada turno, acciones de copiar y
// segunda opinión de otro motor.

import { memo, useEffect, useState } from "react";
import { useApi } from "../../context";
import { formatClock, segmentBlocks, type ToolResultBlock } from "../../parse";
import type { Block, ChatMessage } from "../../types";
import { usePrefs } from "../../prefs";
import { broughtHeader, type TurnActivity, type TurnStats } from "../../timeline";
import { openViewerFrom, toggleTurn, useUi } from "../../ui";
import { prettyModel } from "../TopBar";
import { Markdown } from "./Markdown";
import { CommandCard } from "./CommandCard";
import { toolLabel } from "./terminal-format";
import { TurnActions } from "./TurnActions";
import { PinButton, usePin } from "./Bookmarks";
import { ToolGroup } from "./ToolRow";

type ImageBlock = Extract<Block, { kind: "image" }>;

function fileName(path?: string): string {
  return path ? path.split(/[\\/]/).pop() ?? path : "imagen";
}

function ImageShot({ block }: { block: ImageBlock }) {
  const api = useApi();
  const [src, setSrc] = useState<string | null>(block.dataUrl ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (block.dataUrl || !block.path) return;
    let alive = true;
    api
      .readImage(block.path)
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [api, block.dataUrl, block.path]);
  const name = fileName(block.path);
  return (
    <button className="shot" onClick={(e) => src && openViewerFrom(e.currentTarget, { src, caption: name, path: block.path })} aria-label={`Ver ${name} a pantalla completa`} disabled={!src}>
      {src ? <img src={src} alt={name} loading="lazy" data-gallery="" data-path={block.path} /> : <span className="loading">{failed ? "No se pudo leer la imagen" : "Cargando imagen…"}</span>}
      <span className="cap">{name}</span>
    </button>
  );
}

function UserMessage({ m }: { m: ChatMessage }) {
  const { conversation, pinned } = usePin(m);
  const text = m.blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("\n");
  const images = m.blocks.filter((b): b is ImageBlock => b.kind === "image");
  const brought = broughtHeader(text);
  if (m.kind === "command" || m.kind === "bash") return <CommandCard m={m} />;
  if (brought) {
    // El bloque del motor ya enseña el resumen: aquí solo queda constancia.
    return (
      <details className="msg user brought" data-role="user">
        <summary><span className="mk prompt" aria-hidden="true">❯</span> {brought} traído a Claude <time className="ts" dateTime={m.timestamp}>{formatClock(m.timestamp)}</time></summary>
        <div className="utext">{text}</div>
      </details>
    );
  }
  return (
    <article className={`msg user${pinned ? " pinned" : ""}`} data-role="user" data-msg-uuid={m.uuid}>
      <div className="line">
        <span className="mk prompt" aria-hidden="true">❯</span>
        <div className="ubody">
          <span className="sr-only">Tú:</span>
          <div className="utext">{text}</div>
          {m.queued && <span className="faint echo-state" data-testid="queued-mark">añadido durante el turno</span>}
          {images.length > 0 && (
            <div className="shots">
              {images.map((b, i) => <ImageShot key={i} block={b} />)}
            </div>
          )}
        </div>
        <time className="ts" dateTime={m.timestamp}>{formatClock(m.timestamp)}</time>
        <PinButton m={m} conversation={conversation} pinned={pinned} />
      </div>
    </article>
  );
}

interface ItemProps {
  m: ChatMessage;
  results: Map<string, ToolResultBlock>;
  /** Continúa el turno del mensaje anterior: sin hora ni modelo. */
  continued?: boolean;
  /** Último mensaje del asistente del turno: lleva las acciones. */
  endsTurn?: boolean;
  /** Turno al que pertenece (para plegar o desplegar su actividad). */
  turn?: string;
  /** Solo en la primera respuesta del turno: herramientas de todo el turno. */
  activity?: TurnActivity;
  /** Solo en la última respuesta del turno: tokens y gasto. */
  stats?: TurnStats;
  /** Aviso del sistema dentro de un turno: se pliega con la actividad. */
  inTurn?: boolean;
}

function Thinking({ text }: { text: string }) {
  const words = text.trim().split(/\s+/).length;
  return (
    <details className="think">
      <summary><span className="mk" aria-hidden="true">✻</span> Razonamiento <span className="faint">· {words} palabras</span></summary>
      <p>{text}</p>
    </details>
  );
}

/** Imágenes que devolvieron las herramientas (p. ej. Read de un PNG). */
function ToolImages({ ids, results }: { ids: string[]; results: Map<string, ToolResultBlock> }) {
  const urls = ids.flatMap((id) => results.get(id)?.images ?? []);
  if (urls.length === 0) return null;
  return (
    <div className="shots indent">
      {urls.map((url, i) => <ImageShot key={i} block={{ kind: "image", mediaType: "", dataUrl: url }} />)}
    </div>
  );
}

function ActivityLine({ turn, activity, open }: { turn: string; activity: TurnActivity; open: boolean }) {
  const top = activity.byName.slice(0, 4).map(([name, n]) => `${toolLabel(name)} ${n}`).join(" · ");
  const more = activity.byName.length > 4 ? " · …" : "";
  const system = activity.system ? ` · ${activity.system} ${activity.system === 1 ? "aviso" : "avisos"}` : "";
  const summary = `${activity.tools} ${activity.tools === 1 ? "acción" : "acciones"}${top ? ` · ${top}` : ""}${more}${system}`;
  return (
    <button className="activity" aria-expanded={open} onClick={() => toggleTurn(turn)}
      title={open ? "Plegar herramientas y razonamiento del turno" : "Ver comandos, cambios y razonamiento del turno"}>
      <span className="mk res" aria-hidden="true">⎿</span>
      <span className="act-sum" title={summary}>{summary}</span>
      <span className="faint act-more">· {open ? "plegar" : "ver detalle"}</span>
    </button>
  );
}

interface Visibility {
  compactTools: boolean;
  /** El turno del mensaje está desplegado. */
  expanded: boolean;
}

function assistantView(m: ChatMessage, results: Map<string, ToolResultBlock>, activity: TurnActivity | undefined, compactTools: boolean, expanded: boolean) {
  const segments = segmentBlocks(m.blocks);
  const compact = compactTools && !expanded;
  const visible = compact ? segments.filter((s) => s.kind === "text" || s.kind === "image") : segments;
  const toolIds = segments.flatMap((s) => (s.kind === "tools" ? s.tools.map((t) => t.id) : []));
  const hasImages = toolIds.some((id) => (results.get(id)?.images?.length ?? 0) > 0);
  const showActivity = Boolean(activity && (activity.tools > 0 || (activity.system ?? 0) > 0) && compactTools);
  return { compact, visible, toolIds, hasImages, showActivity };
}

function isSystemLike(m: ChatMessage): boolean {
  return m.role === "system" || m.kind === "interrupted" || m.kind === "taskNotification" || m.kind === "compactSummary";
}

/**
 * La fila no pinta nada (respuesta que solo trae herramientas plegadas, aviso
 * plegado). La lista virtual la omite: una fila de 0 px montada durante el
 * autodesplazamiento no la notifica el ResizeObserver y se quedaba con la
 * altura estimada, dejando huecos en blanco entre párrafos.
 */
export function rendersNothing(m: ChatMessage, props: Pick<ItemProps, "results" | "endsTurn" | "activity" | "inTurn">, vis: Visibility): boolean {
  if (isSystemLike(m)) return Boolean(props.inTurn && vis.compactTools && !vis.expanded);
  if (m.role === "user") return false;
  const view = assistantView(m, props.results, props.activity, vis.compactTools, vis.expanded);
  return view.compact && view.visible.length === 0 && !view.hasImages && !view.showActivity && !props.endsTurn;
}

function AssistantMessage({ m, results, continued, endsTurn, turn = "", activity, stats }: ItemProps) {
  const prefs = usePrefs();
  const expanded = useUi((s) => Boolean(s.expandedTurns[turn]));
  const { conversation, pinned } = usePin(m);
  const { compact, visible, toolIds, hasImages, showActivity } = assistantView(m, results, activity, prefs.compactTools, expanded);
  if (compact && visible.length === 0 && !hasImages && !showActivity && !endsTurn) return null;
  let marked = false;
  return (
    <article className={`msg assistant${continued ? " cont" : ""}${pinned ? " pinned" : ""}`} data-role="assistant" data-engine="claude" data-msg-uuid={m.uuid}>
      {!continued && (
        <div className="meta">
          <span className="who">Claude</span>
          {m.model && <span className="model">{prettyModel(m.model)}</span>}
          <time dateTime={m.timestamp}>{formatClock(m.timestamp)}</time>
          <PinButton m={m} conversation={conversation} pinned={pinned} />
        </div>
      )}
      {continued && <PinButton m={m} conversation={conversation} pinned={pinned} floating />}
      {showActivity && activity && <ActivityLine turn={turn} activity={activity} open={expanded} />}
      {visible.map((s, i) => {
        if (s.kind === "thinking") return prefs.showThinking ? <Thinking key={i} text={s.text} /> : null;
        if (s.kind === "image") return <div key={i} className="shots indent"><ImageShot block={s.block} /></div>;
        if (s.kind === "tools") return <ToolGroup key={i} tools={s.tools} results={results} />;
        const first = !marked;
        marked = true;
        return (
          <div key={i} className="line">
            <span className={`mk reply${first ? "" : " dim"}`} aria-hidden="true">⏺</span>
            <Markdown text={s.text} />
          </div>
        );
      })}
      <ToolImages ids={toolIds} results={results} />
      {endsTurn && <TurnActions m={m} stats={stats} />}
    </article>
  );
}

const SYSTEM_LABEL: Partial<Record<NonNullable<ChatMessage["kind"]>, string>> = {
  interrupted: "interrumpido",
  compactSummary: "resumen de la compactación",
  taskNotification: "tarea en segundo plano",
};

function SystemMessage({ m, folded }: { m: ChatMessage; folded: boolean }) {
  if (folded) return null;
  const text = m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("\n").trim();
  const first = text.split("\n")[0].slice(0, 90);
  const label = (m.kind && SYSTEM_LABEL[m.kind]) ?? "sistema";
  return (
    <details className="msg system" data-kind={m.kind}>
      <summary><span className="mk" aria-hidden="true">·</span> {label}: {first || "mensaje interno"}</summary>
      <div className="sys-body">{text}</div>
    </details>
  );
}

function MessageImpl({ m, results, continued, endsTurn, turn, activity, stats, inTurn }: ItemProps) {
  const prefs = usePrefs();
  const expanded = useUi((s) => Boolean(turn && s.expandedTurns[turn]));
  const folded = Boolean(inTurn && prefs.compactTools && !expanded);
  if (isSystemLike(m)) return <SystemMessage m={m} folded={folded} />;
  if (m.role === "user") return <UserMessage m={m} />;
  return <AssistantMessage m={m} results={results} continued={continued} endsTurn={endsTurn} turn={turn} activity={activity} stats={stats} />;
}

/**
 * El índice de resultados se rehace con cada evento; a una fila solo le importan
 * los resultados de sus propias herramientas, así que se comparan esos y no el Map.
 */
export function sameMessageProps(a: ItemProps, b: ItemProps): boolean {
  if (a.m !== b.m || a.continued !== b.continued || a.endsTurn !== b.endsTurn || a.turn !== b.turn) return false;
  if (a.activity !== b.activity || a.stats !== b.stats || a.inTurn !== b.inTurn) return false;
  if (a.results === b.results) return true;
  return a.m.blocks.every((blk) => blk.kind !== "toolUse" || a.results.get(blk.id) === b.results.get(blk.id));
}

export const Message = memo(MessageImpl, sameMessageProps);
