// PortfolioView — tablero macro de proyectos (`proyectos`) con tarjetas
// enlazadas a proyectos registrados por `Card.project`.

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { PortfolioView } from "../PortfolioView";
import CardEditorModal from "../../projects/CardEditorModal";
import { BoardExtensionsContext } from "../../projects/project-board/BoardExtensions";
import type { Card, KanbanBoard, ProjectInfo } from "../../../types";

function card(id: string, title: string, columnId: string, project?: string): Card {
  return {
    id,
    column_id: columnId,
    title,
    description: "",
    agent: null,
    prompt_template: null,
    cwd: null,
    ...(project ? { project } : {}),
    tags: [],
    order: 0,
    created_at: "epoch:1",
    updated_at: "epoch:1",
    runs: [],
  };
}

const BOARD: KanbanBoard = {
  project_id: "proyectos",
  columns: [
    { id: "col-activo", name: "Activo", order: 0, role: "doing" },
    { id: "col-sin", name: "Sin clasificar", order: 1, role: "todo" },
  ],
  cards: [
    card("c-arc", "Arcadia", "col-activo", "arcadia"),
    card("c-ghost", "Fantasma", "col-activo", "borrado"),
    card("c-idea", "Idea suelta", "col-sin"),
  ],
  default_agent: null,
  default_prompt_template: null,
  schema_version: 1,
};

function project(id: string, name: string, path: string): ProjectInfo {
  return {
    id, name, path, ide: null, language: null, type_: null, status: null, last_active: null, tags: [],
  };
}

const PROJECTS: ProjectInfo[] = [
  project("arcadia", "Arcadia", "C:\\P\\Arcadia"),
  project("wordle", "Wordle", "D:\\juegos\\wordle"),
  project("proyectos", "Proyectos", "C:\\P"),
];

function mockBackend() {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "kanban_load") return BOARD;
    if (cmd === "list_projects") return PROJECTS;
    return null;
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  mockBackend();
});

describe("PortfolioView", () => {
  it("«Abrir» en una tarjeta vinculada llama al manejador con el id y el nombre", async () => {
    const onOpen = vi.fn();
    render(<PortfolioView onOpenProject={onOpen} />);
    fireEvent.click(await screen.findByRole("button", { name: "Abrir Arcadia" }));
    expect(onOpen).toHaveBeenCalledWith("arcadia", "Arcadia");
    // El clic en «Abrir» no abre el editor de la tarjeta.
    expect(screen.queryByText("Editar tarjeta")).toBeNull();
  });

  it("un vínculo a un proyecto no registrado enseña la insignia y ningún «Abrir»", async () => {
    render(<PortfolioView onOpenProject={vi.fn()} />);
    expect(await screen.findByText("proyecto no encontrado")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Abrir / })).toHaveLength(1);
  });

  it("el selector solo lista proyectos sin tarjeta (ni el propio tablero)", async () => {
    render(<PortfolioView onOpenProject={vi.fn()} />);
    await screen.findByRole("button", { name: "Abrir Arcadia" });
    fireEvent.click(screen.getByRole("button", { name: "+ Añadir proyecto" }));
    const list = await screen.findByRole("list", { name: "Proyectos sin tarjeta" });
    const names = within(list).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["WordleD:\\juegos\\wordle"]);
  });

  it("añadir un proyecto crea la tarjeta vinculada en la columna todo", async () => {
    render(<PortfolioView onOpenProject={vi.fn()} />);
    await screen.findByRole("button", { name: "Abrir Arcadia" });
    fireEvent.click(screen.getByRole("button", { name: "+ Añadir proyecto" }));
    fireEvent.click(await screen.findByText("Wordle"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("kanban_create_card", {
        projectId: "proyectos",
        columnId: "col-sin",
        partial: { title: "Wordle", description: "D:\\juegos\\wordle", project: "wordle" },
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Tarjeta «Wordle» añadida a «Sin clasificar».");
  });

  it("CASO NEGATIVO: sin registro de proyectos no se marcan vínculos como rotos", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "kanban_load") return BOARD;
      if (cmd === "list_projects") throw new Error("registro ilegible");
      return null;
    });
    render(<PortfolioView onOpenProject={vi.fn()} />);
    expect(await screen.findByText(/No se pudo leer el registro de proyectos/)).toBeInTheDocument();
    expect(screen.queryByText("proyecto no encontrado")).toBeNull();
    expect(screen.getByRole("button", { name: "+ Añadir proyecto" })).toBeDisabled();
  });
});

describe("CardEditorModal — Proyecto vinculado", () => {
  const editProps = {
    projectId: "proyectos",
    board: BOARD,
    mode: "edit" as const,
    columnId: "col-activo",
    card: BOARD.cards[0],
    onClose: () => {},
    onSaved: () => {},
  };

  it("en Portfolio enseña el selector y envía el vínculo elegido", async () => {
    render(
      <BoardExtensionsContext.Provider value={{ linkableProjects: [{ id: "arcadia", name: "Arcadia" }, { id: "wordle", name: "Wordle" }] }}>
        <CardEditorModal {...editProps} />
      </BoardExtensionsContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("Proyecto vinculado"), { target: { value: "wordle" } });
    fireEvent.click(screen.getByText("Guardar"));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "kanban_update_card",
        expect.objectContaining({ patch: expect.objectContaining({ project: "wordle" }) }),
      ),
    );
  });

  it("CASO NEGATIVO: en un tablero normal no hay selector ni se envía project", async () => {
    render(<CardEditorModal {...editProps} projectId="otro" />);
    expect(screen.queryByLabelText("Proyecto vinculado")).toBeNull();
    fireEvent.click(screen.getByText("Guardar"));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("kanban_update_card", expect.anything()));
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "kanban_update_card");
    expect((call?.[1] as { patch: object }).patch).not.toHaveProperty("project");
  });
});
