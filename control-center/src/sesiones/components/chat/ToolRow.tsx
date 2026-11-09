// Herramienta en estética de terminal (E2): `⏺ Nombre(argumento)` y debajo
// `⎿ resultado` en una sola unidad plegable. Al desplegar enseña el diff
// (Edit/Write/MultiEdit) o la salida completa.

import { memo, useState } from "react";
import { toolDiffLines, toolDiffStats, toolSummary, type DiffLine, type ToolResultBlock, type ToolUseBlock } from "../../parse";
import type { LiveTool } from "../../reducer";
import { resultLine, toolLabel } from "./terminal-format";
import { WorkflowToolRow } from "./WorkflowCard";

type ToolState = "run" | "ok" | "err" | "idle";

function stateOf(result: ToolResultBlock | undefined, running: boolean): ToolState {
  if (running) return "run";
  if (!result) return "idle";
  return result.isError ? "err" : "ok";
}

const STATE_LABEL: Record<ToolState, string> = { run: "en curso", ok: "completada", err: "con error", idle: "sin resultado" };

interface HeadProps {
  name: string;
  arg: string;
  state: ToolState;
  result: string;
  stats?: { added: number; removed: number } | null;
}

function ToolHead({ name, arg, state, result, stats }: HeadProps) {
  return (
    <>
      <span className="tl-main">
        <span className={`mk tool-st ${state}`} aria-label={STATE_LABEL[state]}>{state === "run" ? <span className="spin" /> : "⏺"}</span>
        <span className="n" title={name}>{toolLabel(name)}</span>
        <span className="a" title={arg}>({arg})</span>
        {stats && (
          <span className="d"><span className="plus">+{stats.added}</span> <span className="minus">−{stats.removed}</span></span>
        )}
      </span>
      <span className={`tl-res${state === "err" ? " errc" : ""}`}>
        <span className="mk res" aria-hidden="true">⎿</span>
        <span className="r">{result}</span>
      </span>
    </>
  );
}

/** Diff de Edit/Write/MultiEdit; lo comparten la fila de herramienta y la tarjeta de permiso. */
export function DiffView({ lines, label = "Diferencias" }: { lines: readonly DiffLine[]; label?: string }) {
  return (
    <div className="diff" role="region" aria-label={label}>
      {lines.map((l, i) => (
        <div key={i} className={l.kind}>{l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}{l.text}</div>
      ))}
    </div>
  );
}

function ToolBody({ tool, result }: { tool: ToolUseBlock; result?: ToolResultBlock }) {
  const diff = toolDiffLines(tool.name, tool.input);
  return (
    <div className="tool-body">
      {diff.length > 0 ? (
        <DiffView lines={diff} />
      ) : (
        <pre>{result?.text || JSON.stringify(tool.input, null, 2)}</pre>
      )}
      {diff.length > 0 && result?.isError && <pre className="errc">{result.text}</pre>}
    </div>
  );
}

function ToolRowImpl({ tool, result }: { tool: ToolUseBlock; result?: ToolResultBlock }) {
  const [open, setOpen] = useState(false);
  const stats = toolDiffStats(tool.name, tool.input);
  const arg = tool.summary || toolSummary(tool.name, tool.input);
  const state = stateOf(result, false);
  return (
    <div className="tool" data-open={open} data-state={state}>
      <button className="tool-row" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={open ? "Plegar" : "Desplegar la salida"}>
        <ToolHead name={tool.name} arg={arg} state={state} result={resultLine(tool.name, result, stats)} stats={stats} />
      </button>
      {open && <ToolBody tool={tool} result={result} />}
    </div>
  );
}

export const ToolRow = memo(ToolRowImpl);

export function LiveToolRow({ tool }: { tool: LiveTool }) {
  const running = tool.phase === "start";
  const state: ToolState = running ? "run" : tool.isError ? "err" : "ok";
  const result = running ? "En curso…" : tool.isError ? "Error (detalle al llegar al transcript)" : "Hecho";
  return (
    <div className="tool live" data-state={state}>
      <div className="tool-row">
        <ToolHead name={tool.name} arg={tool.summary} state={state} result={result} />
      </div>
    </div>
  );
}

export function ToolGroup({ tools, results }: { tools: ToolUseBlock[]; results: Map<string, ToolResultBlock> }) {
  return (
    <div className="tools">
      {tools.map((t) =>
        t.name === "Workflow" ? (
          <WorkflowToolRow key={t.id} tool={t} result={results.get(t.id)}>
            <ToolRow tool={t} result={results.get(t.id)} />
          </WorkflowToolRow>
        ) : (
          <ToolRow key={t.id} tool={t} result={results.get(t.id)} />
        ),
      )}
    </div>
  );
}
