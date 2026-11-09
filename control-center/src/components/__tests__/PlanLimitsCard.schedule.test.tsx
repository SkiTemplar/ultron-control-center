// PlanLimitsCard — aviso de horario de uso inválido (auditoría 2026-10-26, L6).
// Un horario inválido deja el ritmo semanal en lineal; la tarjeta tiene que
// decirlo en vez de cambiar de cálculo en silencio.

import { render, act, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { PlanLimitsCard } from "../usage/PlanLimitsCard";

type ScheduleReply = { kind: "ok"; value: unknown } | { kind: "err"; message: string };

function mockBackend(reply: ScheduleReply) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "usage_schedule_get") {
      return reply.kind === "ok" ? Promise.resolve(reply.value) : Promise.reject(reply.message);
    }
    return Promise.reject(new Error("sin backend"));
  });
}

async function renderCard() {
  await act(async () => {
    render(<PlanLimitsCard />);
  });
}

describe("PlanLimitsCard: horario de uso", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("muestra el motivo cuando el horario incumple las reglas", async () => {
    mockBackend({ kind: "ok", value: { lowWeight: 0, low: {} } });
    await renderCard();
    expect(screen.getByText(/horario inválido: lowWeight debe estar en \(0, 1\]/)).toBeTruthy();
  });

  it("muestra el error del backend cuando el JSON está roto", async () => {
    mockBackend({ kind: "err", message: "usage-schedule.json no es JSON válido: expected value at line 1" });
    await renderCard();
    expect(screen.getByText(/horario inválido: usage-schedule\.json no es JSON válido/)).toBeTruthy();
  });

  it("caso negativo: sin fichero no avisa", async () => {
    mockBackend({ kind: "ok", value: null });
    await renderCard();
    expect(screen.queryByText(/horario inválido/)).toBeNull();
  });

  it("caso negativo: con un horario válido no avisa", async () => {
    mockBackend({ kind: "ok", value: { lowWeight: 0.2, low: { mon: [["00:00", "08:00"]] } } });
    await renderCard();
    expect(screen.queryByText(/horario inválido/)).toBeNull();
  });
});
