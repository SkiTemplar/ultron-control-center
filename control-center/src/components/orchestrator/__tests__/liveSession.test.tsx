// Panel de orquestación (prompting-1, prompting-2, prompting-5, frontend-e2e-5):
// en modo ligero no presenta como actual un turno full antiguo, ya no pinta
// el log del dispatcher desconectado y el Preview se etiqueta como modo full.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LiveSessionMonitor from "../LiveSessionMonitor";
import { LIGHT_MODE_NOTICE, lastTurnHeading } from "../live-session/LastTurnPanel";
import { previewModeLabel, sessionInjectionSummary } from "../live-session/OrchestrationPreviewPanel";
import type { OrchestrationPreview } from "../live-session/types";
import type { LiveSessionFeed, SessionOrchestration } from "../../sessions/sessionTypes";
import { fmtWhen } from "../../sessions/orchShared";

const NOW = new Date("2026-10-23T10:00:00Z");

const OLD_TURN: SessionOrchestration = {
  ts: "2026-09-28T15:58:42Z",
  session_id: "s1",
  project: "ultron",
  prompt: "revisa el kanban",
  route: "review",
  workflow: null,
  agents: [],
  skills: [],
  memories: [],
  cross_project: false,
  warnings: [],
};

function feed(mode: "light" | "full", orchestrations: SessionOrchestration[]): LiveSessionFeed {
  return {
    orchestrations,
    orchestrate_mode: mode,
    dense_enabled: false,
    subagents: [],
    running_subagents: [],
    generated_at: NOW.toISOString(),
  };
}

const PREVIEW: OrchestrationPreview = {
  prompt: "arregla el login",
  route: "bug_fix",
  project_id: null,
  workflow: null,
  delegate_agents: [],
  delegate_skills: [],
  memories: [],
  constraints: [],
  warnings: [],
  token_budget: 1500,
  cross_project: false,
  tone: { id: "cani", name: "Cani", reason: "señal", explicit: false },
};

describe("fmtWhen", () => {
  it("un turno de otro día lleva la fecha, no solo la hora", () => {
    expect(fmtWhen(OLD_TURN.ts, NOW)).toMatch(/2026/);
  });
});

describe("lastTurnHeading", () => {
  it("en modo ligero lo marca como histórico con fecha y antigüedad", () => {
    const h = lastTurnHeading("light", OLD_TURN.ts, NOW);
    expect(h).toMatch(/modo full/);
    expect(h).toMatch(/2026/);
    expect(h).toMatch(/hace 24 días/);
  });

  it("en modo full es el último turno", () => {
    expect(lastTurnHeading("full", NOW.toISOString(), NOW)).toBe("Último turno");
  });
});

describe("LiveSessionMonitor", () => {
  it("en modo ligero enseña el estado y no lo llama «en vivo»", () => {
    render(<LiveSessionMonitor feed={feed("light", [OLD_TURN])} />);
    expect(screen.getByText("Orquestación (modo ligero)")).toBeInTheDocument();
    expect(screen.queryByText(/Orquestación en vivo/)).not.toBeInTheDocument();
    expect(screen.getByText(LIGHT_MODE_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText("Último turno")).not.toBeInTheDocument();
    expect(screen.getByText(/Último turno registrado en modo full/)).toBeInTheDocument();
  });

  it("sin turnos en modo ligero no promete que el hook los registrará", () => {
    render(<LiveSessionMonitor feed={feed("light", [])} />);
    expect(screen.getByText(LIGHT_MODE_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(/el hook UserPromptSubmit la registra/)).not.toBeInTheDocument();
  });

  it("ya no pinta «Routing reciente» ni «skill inyectada»", () => {
    render(<LiveSessionMonitor feed={feed("full", [OLD_TURN])} />);
    expect(screen.queryByText(/Routing reciente/)).not.toBeInTheDocument();
    expect(screen.queryByText(/skill inyectada/)).not.toBeInTheDocument();
    expect(screen.getByText("Orquestación en vivo (modo full)")).toBeInTheDocument();
  });

  it("el previsualizador se etiqueta como modo full con el denso apagado", () => {
    render(<LiveSessionMonitor feed={feed("light", [])} />);
    expect(screen.getByText(/Previsualizar orquestación \(modo full\)/)).toBeInTheDocument();
    expect(screen.getByText(/ULTRON_DENSE=0/)).toBeInTheDocument();
  });
});

describe("Preview: qué entra de verdad en sesión", () => {
  it("en modo ligero solo el tono", () => {
    const s = sessionInjectionSummary("light", PREVIEW);
    expect(s).toMatch(/solo entra el tono «Cani»/);
    expect(s).toMatch(/apagada/);
  });

  it("sin tono detectado lo dice", () => {
    expect(sessionInjectionSummary("light", { ...PREVIEW, tone: null })).toMatch(/tono por defecto/);
  });

  it("la etiqueta distingue denso activo y apagado", () => {
    expect(previewModeLabel(true)).not.toMatch(/ULTRON_DENSE=0/);
    expect(previewModeLabel(false)).toMatch(/solo FTS5/);
  });
});
