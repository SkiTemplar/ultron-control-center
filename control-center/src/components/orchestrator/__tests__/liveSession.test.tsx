// Panel global de subagentes y workflows (LiveSessionMonitor): tras retirar el
// modo full de memory-orchestrate (2026-11-15) ya no pinta el modo del hook,
// el último turno orquestado ni el previsualizador; sigue pintando los
// subagentes en vuelo y terminados del feed.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LiveSessionMonitor from "../LiveSessionMonitor";
import type { LiveSessionFeed } from "../../sessions/sessionTypes";

const NOW = new Date("2026-11-15T10:00:00Z");

function feed(overrides: Partial<LiveSessionFeed> = {}): LiveSessionFeed {
  return {
    subagents: [],
    running_subagents: [],
    generated_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("LiveSessionMonitor", () => {
  it("la cabecera no anuncia un modo del hook", () => {
    render(<LiveSessionMonitor feed={feed()} />);
    expect(screen.getByText("Subagentes y workflows")).toBeInTheDocument();
    expect(screen.queryByText(/modo ligero|modo full/)).not.toBeInTheDocument();
  });

  it("ya no pinta el último turno, el previsualizador ni «Routing reciente»", () => {
    render(<LiveSessionMonitor feed={feed()} />);
    expect(screen.queryByText(/Último turno/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Previsualizar orquestación/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Routing reciente/)).not.toBeInTheDocument();
  });

  it("pinta los subagentes en vuelo y los terminados del feed", () => {
    render(
      <LiveSessionMonitor
        feed={feed({
          running_subagents: [
            { agent: "code-reviewer", label: null, agent_id: "sa-1", started_at: NOW.toISOString() },
          ],
          subagents: [
            {
              ts: NOW.toISOString(),
              project: "ultron",
              agent: "debugger",
              chars: 42,
              preview: "encontró la causa",
              label: null,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Subagentes activos (1)")).toBeInTheDocument();
    expect(screen.getByText("Subagentes recientes")).toBeInTheDocument();
    expect(screen.getByText(/code-reviewer/)).toBeInTheDocument();
    expect(screen.getByText(/debugger/)).toBeInTheDocument();
  });

  it("colapsado solo enseña la cabecera", () => {
    render(<LiveSessionMonitor feed={feed()} collapsed onToggleCollapse={() => undefined} />);
    expect(screen.getByText("Subagentes y workflows")).toBeInTheDocument();
    expect(screen.queryByText(/Subagentes activos/)).not.toBeInTheDocument();
    expect(screen.queryByText("Subagentes recientes")).not.toBeInTheDocument();
  });
});
