// Tarjeta de Workflow en el chat: se ancla a la llamada `Workflow`, pinta fases
// y agentes, abre el transcript de un agente y avisa si el run no existe.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatScopeContext } from "../components/chat/ChatContext";
import { ToolGroup } from "../components/chat/ToolRow";
import { demoRun } from "../mock/workflow-demo";
import type { ToolResultBlock, ToolUseBlock } from "../parse";
import { store } from "../store";
import { emptyWorkspace, workspaceStore } from "../workspace";

afterEach(cleanup);

const call = (id: string, name = "Workflow"): ToolUseBlock => ({ kind: "toolUse", id, name, input: {}, summary: "demo" }) as ToolUseBlock;
const launched = (id: string, runId: string): ToolResultBlock =>
  ({ kind: "toolResult", toolUseId: id, isError: false, text: `Workflow launched in background.\nRun ID: ${runId}` }) as ToolResultBlock;

function renderGroup(sessionId: string, tool: ToolUseBlock, result?: ToolResultBlock, readOnly = false) {
  const results = new Map(result ? [[tool.id, result]] : []);
  return render(
    <ChatScopeContext.Provider value={{ sessionId, readOnly }}>
      <ToolGroup tools={[tool]} results={results} />
    </ChatScopeContext.Provider>,
  );
}

describe("WorkflowCard", () => {
  it("pinta nombre, fases y agentes con su estado bajo la llamada", () => {
    store.dispatch({ type: "workflows", id: "wc1", runs: [demoRun(3)] });
    renderGroup("wc1", call("tw1"), launched("tw1", "wf_demo-001"));
    expect(screen.getByRole("region", { name: "Workflow demo-revision" })).toBeTruthy();
    expect(screen.getByText("en curso")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Fases" }).querySelectorAll("li")).toHaveLength(3);
    const agents = screen.getByRole("list", { name: "Agentes" }).querySelectorAll("button");
    expect([...agents].map((b) => b.getAttribute("data-status"))).toEqual(["done", "done", "running"]);
    expect(screen.getByText("reintento 2")).toBeTruthy();
    expect(screen.getByText("Bash: cargo test --lib workflows")).toBeTruthy();
  });

  it("clic abre el transcript del agente en el panel con foco; Mayús+clic, en uno nuevo", () => {
    workspaceStore.dispatch(() => emptyWorkspace);
    store.dispatch({ type: "workflows", id: "wc2", runs: [demoRun(3)] });
    renderGroup("wc2", call("tw2"), launched("tw2", "wf_demo-001"));
    fireEvent.click(screen.getByRole("button", { name: /diag:estado/ }));
    expect(workspaceStore.getState().panes[0]).toMatchObject({ sessionId: "wc2", agentId: "ademo0" });
    fireEvent.click(screen.getByRole("button", { name: /diag:ui/ }), { shiftKey: true });
    expect(workspaceStore.getState().panes).toHaveLength(2);
    expect(workspaceStore.getState().panes[1]).toMatchObject({ sessionId: "wc2", agentId: "ademo1" });
  });

  it("un run abortado enseña el error y se pliega al terminar", () => {
    const killed = { ...demoRun(3), status: "killed" as const, error: "Error: Workflow aborted", durationMs: 1000 };
    store.dispatch({ type: "workflows", id: "wc3", runs: [killed] });
    renderGroup("wc3", call("tw3"), launched("tw3", "wf_demo-001"));
    expect(screen.getByRole("alert").textContent).toBe("Error: Workflow aborted");
    expect(screen.queryByRole("list", { name: "Agentes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /demo-revision/ }));
    expect(screen.getByRole("list", { name: "Agentes" })).toBeTruthy();
  });

  it("se actualiza en vivo con el evento del run", () => {
    store.dispatch({ type: "workflows", id: "wc4", runs: [demoRun(1)] });
    renderGroup("wc4", call("tw4"), launched("tw4", "wf_demo-001"));
    expect(screen.getByRole("list", { name: "Agentes" }).querySelectorAll("button")).toHaveLength(1);
    act(() => store.dispatch({ type: "workflow", id: "wc4", run: demoRun(5) }));
    expect(screen.getByText("completado")).toBeTruthy();
    expect(screen.getByText("Resultado")).toBeTruthy();
  });

  it("con la lista cargada y el run ausente avisa de que no está en disco", () => {
    store.dispatch({ type: "workflows", id: "wc5", runs: [] });
    renderGroup("wc5", call("tw5"), launched("tw5", "wf_borrado-1"));
    expect(screen.getByRole("status").textContent).toContain("wf_borrado-1");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("sin lista cargada, en un subagente o en otra herramienta queda la fila normal", () => {
    renderGroup("wc6", call("tw6"), launched("tw6", "wf_demo-001"));
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();
    store.dispatch({ type: "workflows", id: "wc7", runs: [demoRun(2)] });
    renderGroup("wc7", call("tw7"), launched("tw7", "wf_demo-001"), true);
    expect(screen.queryByRole("region")).toBeNull();
    cleanup();
    renderGroup("wc7", call("tw8", "Bash"), launched("tw8", "wf_demo-001"));
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("Bash")).toBeTruthy();
  });
});
