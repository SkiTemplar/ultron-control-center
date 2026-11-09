// Auditoría 2026-10-18: cuatro vistas se quedaban cargando para siempre cuando
// su invoke() no respondía. Cada caso deja colgado el comando de la vista
// (promesa que nunca se resuelve), avanza el reloj más allá del plazo y exige
// que el indicador de carga desaparezca y se vea el error. Sin plazo, el
// indicador sigue ahí y el test falla.

import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MemoryStatusCard } from "../dashboard/MemoryStatusCard";
import { SessionsPane } from "../sessions/SessionsPane";
import { Usage } from "../Usage";
import { Diagnostics } from "../system/Diagnostics";

const NEVER = () => new Promise<never>(() => {});

/** invoke() que deja colgados los comandos dados y responde null al resto. */
function hang(commands: string[]) {
  vi.mocked(invoke).mockImplementation(((cmd: string) =>
    commands.includes(cmd) ? NEVER() : Promise.resolve(null)) as typeof invoke);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("una carga sin respuesta termina en error, no en spinner eterno", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("Panel → Sistema de memoria", async () => {
    hang(["memory_health", "memory_stats"]);
    await act(async () => {
      render(<MemoryStatusCard />);
    });
    expect(screen.getByText("Cargando…")).toBeInTheDocument();

    await advance(21_000);

    expect(screen.queryByText("Cargando…")).not.toBeInTheDocument();
    expect(screen.getByText(/no respondió a «memory_health»/)).toBeInTheDocument();
  });

  it("Session Monitor", async () => {
    hang(["list_active_sessions"]);
    await act(async () => {
      render(<SessionsPane />);
    });
    expect(screen.getByText("Cargando sesiones…")).toBeInTheDocument();

    await advance(21_000);

    expect(screen.queryByText("Cargando sesiones…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/no respondió a «list_active_sessions»/);
  });

  it("Session Monitor no apila consultas mientras una sigue en vuelo", async () => {
    hang(["list_active_sessions"]);
    await act(async () => {
      render(<SessionsPane />);
    });
    // Tres ciclos de polling de 4 s con la primera consulta todavía colgada.
    await advance(12_500);

    const calls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "list_active_sessions");
    expect(calls).toHaveLength(1);
  });

  it("Usage → botón de la cabecera", async () => {
    hang(["claude_usage"]);
    await act(async () => {
      render(<Usage />);
    });
    expect(screen.getByRole("button", { name: "Cargando…" })).toBeInTheDocument();

    // Plazo de 90 s; el siguiente refresco automático (120 s) aún no ha empezado.
    await advance(91_000);

    expect(screen.getByRole("button", { name: "Actualizar" })).toBeInTheDocument();
    expect(screen.getByText(/no respondió a «claude_usage»/)).toBeInTheDocument();
  });

  it("System → Diagnóstico", async () => {
    hang(["run_diagnostic_native", "event_log_recent"]);
    await act(async () => {
      render(<Diagnostics />);
    });
    expect(screen.getByRole("button", { name: "Ejecutando…" })).toBeInTheDocument();

    await advance(61_000);

    expect(screen.queryByRole("button", { name: "Ejecutando…" })).not.toBeInTheDocument();
    expect(screen.getByText(/no respondió a «run_diagnostic_native»/)).toBeInTheDocument();
  });
});
