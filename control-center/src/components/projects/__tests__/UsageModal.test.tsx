// UsageModal — unit tests
//
// Covers:
//   (a) Con datos: enseña coste, sesiones, filas por modelo y el reparto
//       sesión principal / subagentes con el contexto medio.
//   (b) Negativo: un resultado `ok:false` del script se ve como error con su
//       código, no como un panel vacío (mandamiento 11).
//   (c) Negativo: si `invoke` revienta, también se ve el motivo.
//   (d) Ventana sin uso: lo dice en vez de enseñar ceros.
//   (e) Cambiar la ventana de días vuelve a pedir el dato con ese `days`.
//   (f) Aviso de subagentes: solo con subagentes caros y contexto largo.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { UsageModal } from "../UsageModal";
import type { ProjectUsage, UsageSource } from "../../../lib/project-usage";

const src = (over: Partial<UsageSource> = {}): UsageSource => ({
  messages: 0,
  costUsd: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  avgContextTokens: 0,
  ...over,
});

function usage(over: Partial<ProjectUsage> = {}): ProjectUsage {
  return {
    ok: true,
    projectId: "demo",
    projectName: "Demo",
    days: 30,
    window: { from: "2026-09-01", to: "2026-09-30" },
    dirs: 1,
    totals: { costUsd: 100, messages: 200, sessions: 7 },
    byDay: Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, costUsd: i === 29 ? 100 : 0, messages: 0 })),
    byModel: [
      { model: "claude-opus-5-5", messages: 150, costUsd: 80, priced: true, sharePct: 80 },
      { model: "claude-mystery-9", messages: 50, costUsd: 0, priced: false, sharePct: 0 },
    ],
    bySource: {
      main: src({ messages: 100, costUsd: 60, avgContextTokens: 120_000 }),
      sub: src({ messages: 100, costUsd: 40, avgContextTokens: 90_000 }),
    },
    unpricedModels: ["claude-mystery-9"],
    notes: ["Coste nocional a precio de API por token; con suscripcion no es lo que se factura."],
    ...over,
  };
}

function mockUsage(result: unknown) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "project_usage") return result;
    return null;
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("UsageModal", () => {
  it("enseña coste, sesiones, modelos y el reparto principal / subagentes", async () => {
    mockUsage(usage());
    render(<UsageModal projectId="demo" projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("100 $")).toBeInTheDocument());
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(screen.getByText("sin precio")).toBeInTheDocument();
    expect(screen.getByText(/contexto medio 120K/)).toBeInTheDocument();
    expect(screen.getByText(/contexto medio 90K/)).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("project_usage", { projectId: "demo", days: 30 });
  });

  it("negativo: un ok:false del script se ve como error con su código", async () => {
    mockUsage({ ok: false, error: { code: "PROJECT_NOT_FOUND", message: "proyecto no registrado: demo" } });
    render(<UsageModal projectId="demo" projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/PROJECT_NOT_FOUND/)).toBeInTheDocument());
    expect(screen.queryByText("Coste nocional")).not.toBeInTheDocument();
  });

  it("negativo: si invoke revienta se ve el motivo", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("node no encontrado"));
    render(<UsageModal projectId="demo" projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/node no encontrado/)).toBeInTheDocument());
  });

  it("una ventana sin uso lo dice", async () => {
    mockUsage(usage({ totals: { costUsd: 0, messages: 0, sessions: 0 }, byModel: [] }));
    render(<UsageModal projectId="demo" projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No hay uso de Claude Code en esta ventana/)).toBeInTheDocument());
  });

  it("cambiar la ventana vuelve a pedir el dato con esos días", async () => {
    mockUsage(usage());
    render(<UsageModal projectId="demo" projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("100 $")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "90 d" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("project_usage", { projectId: "demo", days: 90 }));
  });

  it("avisa de subagentes solo si pesan mucho y arrastran contexto largo", async () => {
    mockUsage(
      usage({
        bySource: {
          main: src({ messages: 20, costUsd: 20, avgContextTokens: 100_000 }),
          sub: src({ messages: 180, costUsd: 80, avgContextTokens: 320_000 }),
        },
      }),
    );
    const { unmount } = render(<UsageModal projectId="demo" projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Los subagentes son el 80 %/)).toBeInTheDocument());
    unmount();

    mockUsage(usage()); // 40 % con contexto de 90K: sin aviso
    render(<UsageModal projectId="demo" projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("100 $")).toBeInTheDocument());
    expect(screen.queryByText(/Los subagentes son el/)).not.toBeInTheDocument();
  });

  it("Escape cierra el modal", async () => {
    mockUsage(usage());
    const onClose = vi.fn();
    render(<UsageModal projectId="demo" projectName="Demo" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("100 $")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
