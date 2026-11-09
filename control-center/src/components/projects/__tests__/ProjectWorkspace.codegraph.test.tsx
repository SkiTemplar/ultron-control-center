// H20: la tarjeta CodeGraph no puede tragarse el fallo de `codegraph init`.
//
// Antes, `handleCodeGraphInit` tenía un `catch {}` sin mensaje y, si el init
// salía bien, marcaba la tarjeta como indexada sin comprobar el índice ni
// cargar el resumen. Auditoría 2026-10-23: con índice la tarjeta abre el
// visor (no una sesión), y los fallos de `codegraph_is_indexed` y
// `codegraph_summary` se enseñan.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ProjectWorkspace from "../ProjectWorkspace";

vi.mock("../../../state/ProjectsTabsContext", () => ({
  useProjectsTabs: () => ({ close: vi.fn() }),
}));
vi.mock("../ProjectBoard", () => ({ default: () => null }));
vi.mock("../../../lib/project-usage", () => ({
  fetchProjectUsage: vi.fn().mockResolvedValue({ ok: false }),
  usageSubtitle: () => "",
}));

const PROJECT = { id: "p1", name: "Alpha", path: "C:\\proyectos\\alpha" };

type Handlers = Record<string, (args?: unknown) => unknown>;

function mockCommands(handlers: Handlers) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (h) return h(args);
    if (cmd === "list_projects") return [PROJECT];
    if (cmd === "git_repo_state") return { is_repo: false, branch: null, remote: null, ahead: 0, behind: 0, dirty: false, dirty_count: 0, path: PROJECT.path };
    if (cmd === "project_session_log") return [];
    return null;
  });
}

async function codeGraphCard() {
  await waitFor(() => expect(screen.getByText(/Sin índice/)).toBeTruthy());
  return screen.getByTitle("Indexar este proyecto con codegraph init");
}

describe("ProjectWorkspace — tarjeta CodeGraph", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("enseña el error de codegraph init en vez de tragárselo", async () => {
    mockCommands({
      codegraph_is_indexed: () => false,
      codegraph_init_project: () => {
        throw "codegraph no está instalado o no está en el PATH";
      },
    });
    render(<ProjectWorkspace projectId="p1" />);
    fireEvent.click(await codeGraphCard());
    await waitFor(() => expect(screen.getByText(/no está en el PATH/)).toBeTruthy());
    expect(screen.getByText(/Sin índice/)).toBeTruthy();
  });

  it("tras indexar comprueba el índice y carga el resumen", async () => {
    let indexed = false;
    mockCommands({
      codegraph_is_indexed: () => indexed,
      codegraph_init_project: () => {
        indexed = true;
        return "ok";
      },
      codegraph_summary: () => ({ files: 12, nodes: 340, edges: 900, languages: [], last_indexed_at: null }),
    });
    render(<ProjectWorkspace projectId="p1" />);
    fireEvent.click(await codeGraphCard());
    await waitFor(() => expect(screen.getByText("12 archivos · 340 símbolos · 900 aristas")).toBeTruthy());
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("codegraph_init_project", { path: PROJECT.path });
  });

  it("indexado: abre el visor y no lanza ninguna sesión", async () => {
    mockCommands({
      codegraph_is_indexed: () => true,
      codegraph_summary: () => ({
        files: 3,
        nodes: 13,
        edges: 19,
        languages: [["typescript", 2], ["rust", 1]],
        last_indexed_at: 1_792_744_895_444,
      }),
      codegraph_files: () => ({ files: [], modules: [], total_files: 3, truncated: false }),
    });
    render(<ProjectWorkspace projectId="p1" />);
    const card = await screen.findByTitle(/Abrir el visor del grafo de código/);
    // Lenguajes y frescura van en el tooltip: el dato calculado se enseña.
    expect(card.getAttribute("title")).toMatch(/typescript \(2\), rust \(1\)/);
    expect(card.getAttribute("title")).toMatch(/Última indexación/);
    fireEvent.click(card);
    expect(await screen.findByRole("dialog", { name: "CodeGraph de Alpha" })).toBeTruthy();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("spawn_session", expect.anything());
  });

  it("un fallo al comprobar el índice no se confunde con «sin índice»", async () => {
    mockCommands({
      codegraph_is_indexed: () => {
        throw "IPC caído";
      },
    });
    render(<ProjectWorkspace projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/Error al comprobar el índice/)).toBeTruthy());
    expect(screen.getByText(/No se pudo comprobar el índice: IPC caído/)).toBeTruthy();
    expect(screen.queryByText(/Sin índice/)).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("codegraph_init_project", expect.anything());
  });

  it("un fallo del resumen se enseña en vez de tragarse", async () => {
    mockCommands({
      codegraph_is_indexed: () => true,
      codegraph_summary: () => {
        throw "consulta a codegraph.db: database is locked";
      },
    });
    render(<ProjectWorkspace projectId="p1" />);
    await waitFor(() => expect(screen.getByText("Indexado · resumen no disponible")).toBeTruthy());
    expect(screen.getByText(/No se pudo leer el resumen del índice: .*database is locked/)).toBeTruthy();
  });

  it("un init que sale bien sin crear el índice no marca la tarjeta como indexada", async () => {
    mockCommands({
      codegraph_is_indexed: () => false,
      codegraph_init_project: () => "ok",
    });
    render(<ProjectWorkspace projectId="p1" />);
    fireEvent.click(await codeGraphCard());
    await waitFor(() => expect(screen.getByText(/sin crear .codegraph\/codegraph.db/)).toBeTruthy());
    expect(screen.getByText(/Sin índice/)).toBeTruthy();
  });
});
