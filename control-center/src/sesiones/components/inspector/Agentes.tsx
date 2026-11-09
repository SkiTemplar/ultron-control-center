// Árbol de subagentes en vivo. Clic: abre su transcript en el panel con foco;
// Mayús+clic: en un panel nuevo.

import { useMemo } from "react";
import { ENGINE_LABEL } from "../../engines";
import { interventions } from "../../engine-session";
import { formatTokens } from "../../parse";
import { useSession, useStore } from "../../store";
import { addNote } from "../../bootstrap";
import type { AgentNode, EngineTask, SessionId, SessionInfo } from "../../types";
import { relayTasks, relayTurnTokens } from "../hud/hud-data";
import { prettyModel } from "../TopBar";
import { openAgentThread as open } from "../../open-agents";
import { externalRuns, type ExternalRun } from "./externos";
import { NoSession } from "./Inspector";

/**
 * Tope de turnos del agente (`maxTurns` de su frontmatter en
 * `~/.claude/agents/<tipo>.md`) si el backend lo manda; sin él no se inventa
 * un denominador (los topes van de 60 a 200).
 */
const budgetOf = (a: AgentNode): number | null => {
  const max = a.maxTurns;
  return typeof max === "number" && max > 0 ? max : null;
};

function badge(a: AgentNode): string {
  if (a.status === "done") return `✓ ${a.turns}`;
  if (a.status === "error") return "error";
  if (a.status === "stale") return "sin señal";
  const max = budgetOf(a);
  return max === null ? `${a.turns} turnos` : `${a.turns}/${max}`;
}

/** Medidor de turnos frente al tope; ámbar desde el 80 % y rojo al llegar. */
function TurnMeter({ a }: { a: AgentNode }) {
  const max = budgetOf(a);
  if (a.status !== "running" || max === null) return null;
  const ratio = a.turns / max;
  const tone = ratio >= 1 ? "err" : ratio >= 0.8 ? "warn" : undefined;
  return <span className="meter" title={`${a.turns} de ${max} turnos (maxTurns)`}><i className={tone} style={{ width: `${Math.min(100, ratio * 100)}%` }} /></span>;
}

const STATUS_ORDER: Record<AgentNode["status"], number> = { running: 0, stale: 1, error: 2, done: 3 };

/** Lo vivo primero; dentro de cada estado se conserva el orden de lanzamiento. */
const liveFirst = (nodes: AgentNode[]): AgentNode[] =>
  [...nodes].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

function nodeTitle(a: AgentNode): string {
  const hint = a.status === "stale"
    ? "Sin escrituras desde hace más de 10 min: puede seguir con una orden larga o haber muerto."
    : "Ver transcript · Mayús: en panel nuevo";
  return a.description ? `${a.description}\n${hint}` : hint;
}

function Branch({ nodes, parent, session, current }: { nodes: AgentNode[]; parent: string | null; session: SessionInfo; current: string | null }) {
  const kids = liveFirst(nodes.filter((n) => n.parentAgentId === parent));
  if (kids.length === 0) return null;
  return (
    <div className="kids">
      {kids.map((a) => (
        <div key={a.agentId} className="tree">
          <button className="node" aria-current={current === a.agentId} onClick={(e) => open(session.id, a.agentId, e.shiftKey)} title={nodeTitle(a)}>
            <span className={`dot ${a.status}`} />
            <span className="t">{a.type} <small>· {formatTokens(a.tokens)}</small></span>
            <span className="badge num">{badge(a)}</span>
            <span className="s">{a.description}</span>
            <TurnMeter a={a} />
          </button>
          <Branch nodes={nodes} parent={a.agentId} session={session} current={current} />
        </div>
      ))}
    </div>
  );
}

/** Nodos cuyo padre no está en la lista se cuelgan de la raíz. */
function withRoots(nodes: AgentNode[]): AgentNode[] {
  const ids = new Set(nodes.map((a) => a.agentId));
  return nodes.map((a) => (a.parentAgentId && !ids.has(a.parentAgentId) ? { ...a, parentAgentId: null } : a));
}

/** Subagentes por run de `Workflow`, en el orden en que aparece cada run. */
function byWorkflowRun(nodes: AgentNode[]): Array<[string, AgentNode[]]> {
  const runs = new Map<string, AgentNode[]>();
  for (const a of nodes) {
    if (a.workflowRun) runs.set(a.workflowRun, [...(runs.get(a.workflowRun) ?? []), a]);
  }
  return [...runs.entries()];
}

/** Un run con sus agentes: abierto mientras tenga alguno en marcha. */
function WorkflowGroup({ name, nodes, session, current }: { name: string; nodes: AgentNode[]; session: SessionInfo; current: string | null }) {
  const count = (status: AgentNode["status"]) => nodes.filter((a) => a.status === status).length;
  const running = count("running");
  const parts = [`${count("done")}/${nodes.length}`];
  if (running > 0) parts.push(`${running} en curso`);
  if (count("stale") > 0) parts.push(`${count("stale")} sin señal`);
  if (count("error") > 0) parts.push(`${count("error")} con error`);
  return (
    <details className="wf-group" open={running > 0} data-testid="agentes-workflow">
      <summary>
        <span className={`dot ${running > 0 ? "running" : count("error") > 0 ? "error" : ""}`} />
        <span className="name" title={name}>{name}</span>
        <span className="num">{parts.join(" · ")}</span>
      </summary>
      <Branch nodes={withRoots(nodes)} parent={null} session={session} current={current} />
    </details>
  );
}

const EXTERNAL_STATUS: Record<ExternalRun["status"], string> = {
  running: "en curso",
  done: "✓",
  error: "error",
  background: "segundo plano",
  expired: "caducada",
};

/** Codex, AGY o Gemini lanzados por Claude con Bash (`externos.ts`). */
function ExternalRuns({ runs }: { runs: ExternalRun[] }) {
  if (runs.length === 0) return null;
  return (
    <div className="kids" data-testid="agentes-externos">
      {runs.map((r) => (
        <div key={r.id} className={`node ${r.engine}`} title={r.status === "expired" ? "Lanzado por Claude con Bash; el turno acabó sin resultado" : "Lanzado por Claude con Bash"}>
          <span className={`dot ${r.engine} ${r.status}`} />
          <span className="t">{r.label} <small>Bash</small></span>
          <span className="badge num">{EXTERNAL_STATUS[r.status]}</span>
          <span className="s">{r.description}</span>
        </div>
      ))}
    </div>
  );
}


const RELAY_STATUS: Record<EngineTask["status"], string> = {
  running: "en curso",
  done: "terminada",
  error: "error",
  cancelled: "cancelada",
};

/** Lleva el chat al bloque de la tarea; si no está pintado, lo dice. */
function goToEngineTask(sessionId: SessionId, taskId: string): void {
  const el = document.getElementById(`engine-task-${taskId}`);
  if (el) {
    el.scrollIntoView({ block: "start" });
    return;
  }
  addNote(sessionId, "warn", "El bloque de esa tarea del relevo no está en el chat visible: ábrelo en el panel de la sesión principal.");
}

/** Tareas del relevo: persisten en el árbol al terminar, con eventos y tokens. */
function RelayNodes({ tasks, sessionId }: { tasks: EngineTask[]; sessionId: SessionId }) {
  if (tasks.length === 0) return null;
  return (
    <div className="kids" data-testid="agentes-relevo">
      {tasks.map((t) => {
        const tokens = relayTurnTokens([t]);
        return (
          <button key={t.id} className={`node ${t.engine}`} data-testid={`relevo-${t.id}`} onClick={() => goToEngineTask(sessionId, t.id)} title="Ir al bloque de la tarea en el chat">
            <span className={`dot ${t.engine} ${t.status}`} />
            <span className="t">{ENGINE_LABEL[t.engine]} <small>relevo · {RELAY_STATUS[t.status]}</small></span>
            <span className="badge num">{t.events.length} ev{tokens === null ? "" : ` · ${formatTokens(tokens)} tok`}</span>
            <span className="s">{t.prompt}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Agentes({ session, currentAgent }: { session: SessionInfo | null; currentAgent: string | null }) {
  const state = useSession(session?.id ?? null);
  const engines = useStore((s) => s.engines);
  const relay = useStore((s) => (session ? s.relays[session.id] ?? null : null));
  const sessionStatus = session?.status;
  const external = useMemo(() => externalRuns(state.messages, sessionStatus), [state.messages, sessionStatus]);
  if (!session) return <NoSession />;
  const running = state.agents.filter((a) => a.status === "running").length;
  const relayed = relayTasks(engines, relay, session.id);
  const relayIds = new Set(relayed.map((t) => t.id));
  const tasks = interventions(engines).filter((t) => t.status === "running" && !relayIds.has(t.id) && (t.sessionId === session.id || t.cwd === session.cwd));
  const loose = withRoots(state.agents.filter((a) => !a.workflowRun));
  const runs = byWorkflowRun(state.agents);

  return (
    <>
      <div className="sect">Árbol de la sesión</div>
      <div className="tree">
        <button className="node" aria-current={currentAgent === null} onClick={(e) => open(session.id, null, e.shiftKey)}>
          <span className={`dot ${session.status}`} />
          <span className="t">Sesión principal <small>{prettyModel(state.status?.model ?? session.model)}</small></span>
          <span className="badge num">{state.status ? formatTokens(state.status.contextTokens) : "—"}</span>
          <span className="s">{running > 0 ? `Esperando a ${running} subagente${running === 1 ? "" : "s"}` : session.status === "working" ? "Trabajando" : "En espera"}</span>
        </button>
        {runs.length > 0 && (
          <div className="kids">
            {runs.map(([runId, nodes]) => (
              <WorkflowGroup key={runId} name={state.workflows[runId]?.name || runId} nodes={nodes} session={session} current={currentAgent} />
            ))}
          </div>
        )}
        <Branch nodes={loose} parent={null} session={session} current={currentAgent} />
        {tasks.length > 0 && (
          <div className="kids">
            {tasks.map((t) => (
              <div key={t.id} className={`node ${t.engine}`}>
                <span className={`dot ${t.engine} running`} />
                <span className="t">{ENGINE_LABEL[t.engine]} <small>{t.kind === "opinion" ? "segunda opinión" : t.engine === "codex" ? t.mode : "tarea"}</small></span>
                <span className="badge num">{t.events.length} ev</span>
                <span className="s">{t.prompt}</span>
                <span className="meter"><i style={{ width: `${Math.min(95, t.events.length * 10)}%` }} /></span>
              </div>
            ))}
          </div>
        )}
        <RelayNodes tasks={relayed} sessionId={session.id} />
        <ExternalRuns runs={external} />
      </div>
      {state.agents.length === 0 && external.length === 0 && relayed.length === 0 && <p className="note">Sin subagentes.</p>}
    </>
  );
}
