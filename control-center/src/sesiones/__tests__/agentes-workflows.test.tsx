// Árbol de Agentes con workflows grandes: agrupado por run, lo vivo primero y sin
// pintar como terminado a un subagente que solo lleva un rato sin escribir.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Agentes } from "../components/inspector/Agentes";
import { SESSIONS } from "../mock/data";
import { store } from "../store";
import type { AgentNode } from "../types";

const session = SESSIONS[0];

function agent(agentId: string, extra: Partial<AgentNode> = {}): AgentNode {
  return {
    agentId,
    parentAgentId: null,
    type: "Explore",
    description: `tarea ${agentId}`,
    status: "done",
    startedAt: "2026-11-02T10:00:00.000Z",
    turns: 3,
    tokens: 100,
    ...extra,
  };
}

function renderWith(agents: AgentNode[]) {
  store.dispatch({ type: "agents", id: session.id, agents });
  render(<Agentes session={session} currentAgent={null} />);
}

afterEach(() => {
  cleanup();
  store.dispatch({ type: "agents", id: session.id, agents: [] });
});

describe("Agentes: estados y workflows", () => {
  it("un subagente sin señal no sale como terminado ni cuenta como en curso", () => {
    renderWith([agent("callado", { status: "stale" })]);
    const node = screen.getByRole("button", { name: /tarea callado/ });
    expect(node.textContent).toContain("sin señal");
    expect(node.textContent).not.toContain("✓");
    expect(node.title).toContain("más de 10 min");
    expect(screen.queryByText(/Esperando a/)).toBeNull();
  });

  it("lo vivo sale antes que lo terminado aunque se lanzara después", () => {
    renderWith([agent("viejo"), agent("vivo", { status: "running" }), agent("mudo", { status: "stale" })]);
    const names = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    const pos = (id: string) => names.findIndex((n) => n.includes(`tarea ${id}`));
    expect(pos("vivo")).toBeLessThan(pos("mudo"));
    expect(pos("mudo")).toBeLessThan(pos("viejo"));
  });

  it("agrupa por run con su recuento y deja fuera a los sueltos", () => {
    renderWith([
      agent("w1", { workflowRun: "wf_a" }),
      agent("w2", { workflowRun: "wf_a", status: "running" }),
      agent("w3", { workflowRun: "wf_a", status: "stale" }),
      agent("suelto"),
    ]);
    const group = screen.getByTestId("agentes-workflow") as HTMLDetailsElement;
    expect(group.open).toBe(true);
    const summary = group.querySelector("summary")?.textContent ?? "";
    expect(summary).toContain("wf_a");
    expect(summary).toContain("1/3");
    expect(summary).toContain("1 en curso");
    expect(summary).toContain("1 sin señal");
    expect(within(group).queryByText(/tarea suelto/)).toBeNull();
    expect(screen.getByRole("button", { name: /tarea suelto/ })).toBeTruthy();
  });

  it("un run acabado queda plegado, y un padre de fuera del run no pierde al hijo", () => {
    renderWith([agent("w1", { workflowRun: "wf_b", parentAgentId: "fuera" })]);
    const group = screen.getByTestId("agentes-workflow") as HTMLDetailsElement;
    expect(group.open).toBe(false);
    expect(within(group).getByText(/tarea w1/)).toBeTruthy();
  });
});
