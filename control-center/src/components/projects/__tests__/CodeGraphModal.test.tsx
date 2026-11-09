// Visor CodeGraph: búsqueda → vecindario → clic en un nodo para expandir, con
// detalle fichero:línea, y los fallos del backend a la vista.
//
// Graphviz (WASM) se sustituye por un render mínimo que emite un <g class="node">
// por cada `id="cg-<i>"` del DOT: lo que se prueba es el cableado del visor,
// no el layout.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CodeGraphModal } from "../codegraph/CodeGraphModal";
import type { CgNeighborhood, CgNode } from "../../../lib/codegraph";

vi.mock("@viz-js/viz", () => ({
  instance: async () => ({
    renderString: (dot: string) => {
      const groups = [...dot.matchAll(/id="(cg-\d+)", label="([^\\]*)\\n/g)]
        .map(([, id, label]) => `<g id="${id}" class="node"><title>${id}</title><text>${label}</text></g>`)
        .join("");
      return `<svg xmlns="http://www.w3.org/2000/svg">${groups}</svg>`;
    },
  }),
}));

const PATH = "C:\\proyectos\\alpha";

const node = (id: string, name: string, file: string, line: number, kind = "function"): CgNode => ({
  id,
  kind,
  name,
  qualified_name: name,
  file_path: file,
  language: "rust",
  start_line: line,
  end_line: line + 2,
  signature: `fn ${name}()`,
});

const ROUTE = node("function:route", "route", "crates/routing.rs", 1);
const PICK = node("function:pick", "pick", "crates/routing.rs", 5);
const FIRST = node("method:first", "first", "crates/routing.rs", 14, "method");
const ROUTER = node("struct:router", "Router", "crates/routing.rs", 9, "struct");

const HOODS: Record<string, CgNeighborhood> = {
  [ROUTE.id]: {
    center: ROUTE.id,
    depth: 1,
    nodes: [ROUTE, PICK, FIRST],
    edges: [
      { source: ROUTE.id, target: PICK.id, kind: "calls", line: 2 },
      { source: FIRST.id, target: ROUTE.id, kind: "calls", line: 15 },
    ],
    truncated: false,
  },
  [FIRST.id]: {
    center: FIRST.id,
    depth: 1,
    nodes: [FIRST, ROUTE, ROUTER],
    edges: [
      { source: FIRST.id, target: ROUTE.id, kind: "calls", line: 15 },
      { source: ROUTER.id, target: FIRST.id, kind: "contains", line: null },
    ],
    truncated: false,
  },
};

type Handlers = Record<string, (args: Record<string, unknown>) => unknown>;

function mockCommands(overrides: Handlers = {}) {
  const handlers: Handlers = {
    codegraph_files: () => ({
      files: [
        { path: "crates/routing.rs", language: "rust", symbols: 4, node_id: "file:routing" },
        { path: "src/main.ts", language: "typescript", symbols: 3, node_id: "file:main" },
      ],
      modules: [
        { path: "crates", files: 1, symbols: 4 },
        { path: "src", files: 1, symbols: 3 },
      ],
      total_files: 2,
      truncated: false,
    }),
    codegraph_search: () => [ROUTE],
    codegraph_neighborhood: (args) => {
      const h = HOODS[String(args.nodeId)];
      if (!h) throw `el símbolo no existe en el índice: ${String(args.nodeId)}`;
      return h;
    },
    ...overrides,
  };
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`comando inesperado: ${cmd}`);
    return h((args ?? {}) as Record<string, unknown>);
  });
}

function renderModal(onClose = vi.fn()) {
  render(<CodeGraphModal path={PATH} projectName="Alpha" onClose={onClose} />);
  return onClose;
}

async function searchAndOpenRoute() {
  fireEvent.change(screen.getByLabelText("Buscar símbolo"), { target: { value: "route" } });
  fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
  const hit = await screen.findByRole("button", { name: /route function/ });
  fireEvent.click(hit);
  await screen.findByTestId("codegraph-canvas");
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("CodeGraphModal", () => {
  it("lista ficheros y módulos con su conteo de símbolos", async () => {
    mockCommands();
    renderModal();
    expect(await screen.findByText("crates/routing.rs")).toBeTruthy();
    expect(screen.getByText(/2 ficheros indexados/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Módulos" }));
    expect(screen.getByText("1 f · 4 s")).toBeTruthy();
    // Elegir un módulo filtra la lista de ficheros.
    fireEvent.click(screen.getByText("src"));
    expect(screen.getByText("src/main.ts")).toBeTruthy();
    expect(screen.queryByText("crates/routing.rs")).toBeNull();
  });

  it("busca, abre el vecindario y enseña el detalle con fichero:línea", async () => {
    mockCommands();
    renderModal();
    await searchAndOpenRoute();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("codegraph_search", { path: PATH, query: "route", limit: null });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("codegraph_neighborhood", {
      path: PATH,
      nodeId: ROUTE.id,
      depth: 1,
      maxNodes: null,
    });
    expect(screen.getByTestId("codegraph-location").textContent).toBe("crates/routing.rs:1");
    const canvas = screen.getByTestId("codegraph-canvas");
    expect(canvas.querySelectorAll("g.node")).toHaveLength(3);
  });

  it("clic en un nodo lo selecciona y expande su vecindario", async () => {
    mockCommands();
    renderModal();
    await searchAndOpenRoute();
    const firstNode = screen.getByTestId("codegraph-canvas").querySelector("#cg-2 text");
    expect(firstNode?.textContent).toBe("first");
    fireEvent.click(firstNode as Element);
    await waitFor(() =>
      expect(screen.getByTestId("codegraph-canvas").querySelectorAll("g.node")).toHaveLength(4),
    );
    expect(screen.getByTestId("codegraph-location").textContent).toBe("crates/routing.rs:14");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("codegraph_neighborhood", expect.objectContaining({ nodeId: FIRST.id }));
  });

  it("la profundidad elegida viaja al backend", async () => {
    mockCommands();
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await searchAndOpenRoute();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("codegraph_neighborhood", expect.objectContaining({ depth: 2 }));
  });

  it("un símbolo que ya no existe enseña el error del backend", async () => {
    mockCommands({ codegraph_search: () => [node("function:gone", "gone", "x.rs", 3)] });
    renderModal();
    fireEvent.change(screen.getByLabelText("Buscar símbolo"), { target: { value: "gone" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    fireEvent.click(await screen.findByRole("button", { name: /gone function/ }));
    expect(await screen.findByText(/No se pudo leer el vecindario del símbolo: el símbolo no existe/)).toBeTruthy();
  });

  it("una búsqueda sin resultados lo dice", async () => {
    mockCommands({ codegraph_search: () => [] });
    renderModal();
    fireEvent.change(screen.getByLabelText("Buscar símbolo"), { target: { value: "nada" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    expect(await screen.findByText(/Ningún símbolo coincide/)).toBeTruthy();
  });

  it("Escape cierra el visor", async () => {
    mockCommands();
    const onClose = renderModal();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
