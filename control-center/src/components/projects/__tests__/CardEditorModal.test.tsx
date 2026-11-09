// CardEditorModal — H12 (auditoría 2026-10-17).
//
// "Run again" lanzaba kanban_dispatch_card, que abría un Claude invisible, sin
// el prompt de la tarjeta y con bypass de permisos. Ahora el botón abre una
// sesión visible en Sessions y copia el prompt; el run huérfano enseña su
// motivo en vez de quedarse en «running».

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import CardEditorModal from "../CardEditorModal";
import type { Card, KanbanBoard } from "../../../types";

const CARD: Card = {
  id: "card-1",
  column_id: "col-doing",
  title: "Arreglar el login",
  description: "El botón no responde",
  agent: null,
  prompt_template: null,
  cwd: null,
  tags: [],
  order: 0,
  created_at: "epoch:1",
  updated_at: "epoch:1",
  runs: [
    {
      session_id: "pty-0000000000000001",
      started_at: "epoch:1",
      ended_at: "epoch:2",
      status: { kind: "failed" },
      exit_code: null,
      error: "El run lanzó un PTY de Claude invisible que nadie seguía",
    },
  ],
};

const BOARD: KanbanBoard = {
  project_id: "proj-1",
  columns: [{ id: "col-doing", name: "In Progress", order: 0, role: "doing" }],
  cards: [CARD],
  default_agent: null,
  default_prompt_template: "Tarea: {title}\n{description}",
  schema_version: 1,
};

const writeText = vi.fn();

function renderEdit() {
  return render(
    <CardEditorModal
      projectId="proj-1"
      board={BOARD}
      mode="edit"
      columnId="col-doing"
      card={CARD}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

describe("CardEditorModal — Abrir en Sessions", () => {
  it("abre Sessions del proyecto y copia el prompt con las variables sustituidas", async () => {
    renderEdit();
    fireEvent.click(screen.getByText("Abrir en Sessions"));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("sesiones_launch", { projectId: "proj-1" });
    });
    expect(writeText).toHaveBeenCalledWith("Tarea: Arreglar el login\nEl botón no responde");
    expect(await screen.findByRole("status")).toHaveTextContent(/portapapeles/);
    // Caso negativo: el despacho invisible por PTY no se invoca nunca.
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("kanban_dispatch_card", expect.anything());
    expect(screen.queryByText("Run again")).toBeNull();
  });

  it("enseña el error si Sessions no puede abrir la sesión", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("id de proyecto no válido");
    renderEdit();
    fireEvent.click(screen.getByText("Abrir en Sessions"));
    expect(
      await screen.findByText(/No se pudo abrir la sesión en Sessions: id de proyecto no válido/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("muestra el motivo del run fallido", () => {
    renderEdit();
    expect(screen.getByText(/PTY de Claude invisible/)).toBeInTheDocument();
  });
});
