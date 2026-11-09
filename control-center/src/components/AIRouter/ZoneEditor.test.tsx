// ZoneEditor sin backend: enseña el error y un botón de reintento, nunca un
// catálogo de zonas inventado (auditoría Kirkardo del 2026-10-23).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZoneEditor } from "./ZoneEditor";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const chatZone = {
  id: "chat",
  label: "Chat",
  category: "general",
  primary: { provider_id: "groq", model: "openai/gpt-oss-120b", max_tokens: 0 },
  fallbacks: [],
};

function backend(zones: () => unknown) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "ai_router_list_zones") return zones();
    return [];
  });
}

describe("ZoneEditor", () => {
  beforeEach(() => invokeMock.mockReset());

  it("si falla el backend enseña el error y no enseña zonas", async () => {
    backend(() => {
      throw new Error("ipc caído");
    });
    render(<ZoneEditor />);
    expect(await screen.findByRole("alert")).toHaveTextContent("ipc caído");
    expect(screen.queryByText(/Actualizar las estadísticas de uso/)).toBeNull();
    expect(screen.queryByText(/\d+ zonas/)).toBeNull();
    expect(screen.queryByText("No hay zonas configuradas.")).toBeNull();
  });

  it("el reintento vuelve a pedir las zonas y quita el error", async () => {
    let fail = true;
    backend(() => {
      if (fail) throw new Error("ipc caído");
      return [chatZone];
    });
    render(<ZoneEditor />);
    await screen.findByRole("alert");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("1 zonas")).toBeInTheDocument();
  });

  it("con el backend vacío enseña el estado vacío, sin zonas por defecto", async () => {
    backend(() => []);
    render(<ZoneEditor />);
    expect(await screen.findByText("No hay zonas configuradas.")).toBeInTheDocument();
    expect(screen.getByText("0 zonas")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
