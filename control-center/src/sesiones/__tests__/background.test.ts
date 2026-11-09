import { describe, expect, it } from "vitest";
import { backgroundText, backgroundWork, displayStatus, NO_BACKGROUND } from "../background";
import { statusLine } from "../components/chat/status-line";
import { sessionMeta } from "../components/Sidebar";
import type { AgentNode, SessionInfo } from "../types";
import type { WorkflowRun } from "../workflows";

const agent = (agentId: string, status: AgentNode["status"]): AgentNode => ({
  agentId, parentAgentId: null, type: "Explore", description: "", status, startedAt: "", turns: 0, tokens: 0,
});

const run = (runId: string, status: WorkflowRun["status"], agentIds: string[]): WorkflowRun => ({
  runId, name: "wf", description: "", status, startedAt: null, endedAt: null, durationMs: null, phases: [],
  agents: agentIds.map((id) => ({
    key: id, agentId: id, label: id, phase: "", status: "running", attempt: 1, agentType: null, model: null, startedAt: null,
    lastAt: null, durationMs: null, contextTokens: null, toolCalls: null, lastActivity: null, resultPreview: null,
  })),
  totalTokens: null, totalToolCalls: null, resultPreview: null, error: null,
});

const info: SessionInfo = {
  id: "s1", projectId: "p", projectName: "home", cwd: "/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
  startedAt: new Date().toISOString(), bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: new Date().toISOString(), turnId: null,
  screen: "prompt", permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

describe("trabajo en segundo plano de una sesión", () => {
  it("cuenta subagentes vivos y runs en curso; los agentes de un run en curso no cuentan dos veces", () => {
    const bg = backgroundWork({
      agents: [agent("a", "running"), agent("b", "done"), agent("w1", "running")],
      workflows: { r1: run("r1", "running", ["w1"]), r2: run("r2", "completed", ["w2"]) },
    });
    expect(bg).toEqual({ agents: 1, workflows: 1 });
    expect(backgroundText(bg)).toBe("1 subagente y 1 workflow");
  });

  it("caso negativo: sin nada vivo no hay segundo plano y la sesión libre sigue «idle»", () => {
    const bg = backgroundWork({ agents: [agent("a", "done"), agent("b", "error")], workflows: { r: run("r", "failed", []) } });
    expect(bg).toEqual(NO_BACKGROUND);
    expect(displayStatus("idle", bg)).toBe("idle");
    expect(backgroundWork(undefined)).toEqual(NO_BACKGROUND);
  });

  it("solo la sesión libre pasa a «background»: trabajando, esperando o terminada mandan", () => {
    const bg = { agents: 2, workflows: 0 };
    expect(displayStatus("idle", bg)).toBe("background");
    for (const st of ["working", "waiting", "exited", "starting"] as const) expect(displayStatus(st, bg)).toBe(st);
  });

  it("la línea de estado dice «Turno acabado» con trabajo vivo y «Listo» sin él", () => {
    const now = Date.now();
    const bg = statusLine(info, [], [], { now, background: { agents: 2, workflows: 1 } });
    expect(bg).toEqual({ tone: "bg", text: "Turno acabado · en segundo plano: 2 subagentes y 1 workflow", actions: [] });
    expect(statusLine(info, [], [], { now, background: NO_BACKGROUND })).toEqual({ tone: "idle", text: "Listo", actions: [] });
    expect(statusLine(info, [], [], { now, lastTurnAborted: true, background: { agents: 1, workflows: 0 } }).text)
      .toBe("Interrumpido · en segundo plano: 1 subagente");
  });

  it("la fila de la barra lateral nombra el segundo plano en vez de la hora", () => {
    expect(sessionMeta(info, { agents: 0, workflows: 2 })).toEqual({ text: "home · en segundo plano: 2 workflows", warn: false });
    expect(sessionMeta({ ...info, status: "working" }, { agents: 1, workflows: 0 })).toEqual({ text: "home · 1 subagente", warn: false });
  });
});
