// DelegationPanel con invoke simulado: errores visibles, guardado real y
// ningún botón mudo (contrato 2026-10-26, §4).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DelegationPanel } from "./DelegationPanel";
import type { DelegationConfig } from "./delegationTypes";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const CONFIG: DelegationConfig = {
  version: 1,
  chain: ["codex", "agy"],
  tiers: { complex: { start: "codex" }, standard: { start: "agy" }, trivial: { start: "agy" } },
  relayOnCheckFail: true,
  engines: {
    codex: { runner: "codex", model: "gpt-5.6-terra", enabled: true },
    agy: { runner: "agy", model: "gemini-3.8-flash-high", enabled: true },
  },
};

function backend(overrides: Record<string, () => unknown> = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (overrides[cmd]) return overrides[cmd]();
    if (cmd === "ai_router_get_delegation") return structuredClone(CONFIG);
    if (cmd === "ai_router_delegation_status") {
      return { chain: CONFIG.chain, engines: [], configSource: "default" };
    }
    if (cmd === "ai_router_delegation_ledger") return [];
    return null;
  });
}

describe("DelegationPanel", () => {
  beforeEach(() => invokeMock.mockReset());

  it("si no puede leer la configuración enseña el error y el reintento", async () => {
    backend({
      ai_router_get_delegation: () => {
        throw new Error("comando no registrado");
      },
    });
    render(<DelegationPanel />);
    expect(await screen.findByText(/comando no registrado/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("avisa cuando delegate.mjs usa la configuración por defecto y pide el ledger con limit 50", async () => {
    backend();
    render(<DelegationPanel />);
    expect(await screen.findByText(/falta o no parsea/)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("ai_router_delegation_ledger", { limit: 50 });
  });

  it("guardar sin cambios lo explica y no llama al backend", async () => {
    backend();
    render(<DelegationPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Guardar \(sin cambios\)/ }));
    expect(await screen.findByText("No hay cambios que guardar.")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("ai_router_set_delegation", expect.anything());
  });

  it("reordenar y guardar manda la cadena nueva a ai_router_set_delegation", async () => {
    backend();
    render(<DelegationPanel />);
    const down = await screen.findAllByTitle("Bajar un puesto");
    fireEvent.click(down[0]);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("ai_router_set_delegation", {
        config: expect.objectContaining({ chain: ["agy", "codex"] }),
      }),
    );
    expect(await screen.findByText("Cadena guardada.")).toBeInTheDocument();
  });

  it("un error del backend al guardar queda a la vista", async () => {
    backend({
      ai_router_set_delegation: () => {
        throw new Error("runner desconocido");
      },
    });
    render(<DelegationPanel />);
    fireEvent.click((await screen.findAllByTitle("Bajar un puesto"))[0]);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("runner desconocido")).toBeInTheDocument();
  });
});
