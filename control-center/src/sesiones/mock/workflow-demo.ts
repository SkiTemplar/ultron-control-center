// Run de `Workflow` de demostración para el mock (`?mock=1&workflow=1`): una
// llamada `Workflow` en el chat de «s-mods» y un run que avanza un agente por
// paso hasta completarse.

import type { ChatMessage } from "../types";
import type { WorkflowAgent, WorkflowRun } from "../workflows";

export const DEMO_RUN_ID = "wf_demo-001";
const T0 = Date.UTC(2026, 9, 16, 9, 0, 0);

export const WORKFLOW_MESSAGES: ChatMessage[] = [
  {
    uuid: "wf-demo-call", role: "assistant", timestamp: new Date(T0).toISOString(), agentId: null,
    blocks: [{ kind: "toolUse", id: "toolu_wf_demo", name: "Workflow", input: { scriptPath: "demo.js" }, summary: "demo-revision" }],
  },
  {
    uuid: "wf-demo-result", role: "user", timestamp: new Date(T0 + 500).toISOString(), agentId: null,
    blocks: [{ kind: "toolResult", toolUseId: "toolu_wf_demo", isError: false, text: `Workflow launched in background.\nRun ID: ${DEMO_RUN_ID}` }],
  },
];

const PLAN: Array<[string, string, string]> = [
  ["diag:estado", "Diagnose", "Read: src/sesiones/workflows.ts"],
  ["diag:ui", "Diagnose", "Grep: WorkflowCard"],
  ["impl:backend", "Implement", "Bash: cargo test --lib workflows"],
  ["review", "Review", "StructuredOutput"],
];

function agentAt(i: number, step: number): WorkflowAgent {
  const [label, phase, activity] = PLAN[i];
  const started = T0 + i * 60_000;
  const status = step > i + 1 ? "done" : step === i + 1 ? "running" : null;
  return {
    key: `v2:demo${i}`, agentId: `ademo${i}`, label, phase, status: status ?? "running", attempt: i === 2 ? 2 : 1,
    agentType: "workflow-subagent", model: "opus", startedAt: started, lastAt: started + 30_000,
    durationMs: status === "done" ? 55_000 : null, contextTokens: 42_000 + i * 9_000, toolCalls: 6 + i * 3,
    lastActivity: activity, resultPreview: status === "done" ? `Resultado de ${label}` : null,
  };
}

/** Run en el paso `step` (0 = recién lanzado; `PLAN.length + 1` = completado). */
export function demoRun(step: number): WorkflowRun {
  const agents = PLAN.map((_, i) => i).filter((i) => step >= i + 1).map((i) => agentAt(i, step));
  const done = step > PLAN.length;
  const titles = ["Diagnose", "Implement", "Review"];
  return {
    runId: DEMO_RUN_ID, name: "demo-revision", description: "Revisión de demostración de la tarjeta de Workflow",
    status: done ? "completed" : "running", startedAt: T0, endedAt: done ? T0 + 300_000 : null, durationMs: done ? 300_000 : null,
    phases: titles.map((title, n) => {
      const of = agents.filter((a) => a.phase === title);
      return { index: n + 1, title, detail: null, total: of.length, done: of.filter((a) => a.status === "done").length, failed: 0, running: of.filter((a) => a.status === "running").length };
    }),
    agents, totalTokens: done ? 310_000 : null, totalToolCalls: done ? 48 : null,
    resultPreview: done ? "{\"ok\":true,\"resumen\":\"demo completada\"}" : null, error: null,
  };
}
