// KgEditorPane — unit tests
//
// Covers:
//   (1) carga inicial llama kg_read_graph y renderiza entidades
//   (2) crear entidad invoca kg_create_entities con los datos del formulario
//   (3) borrar entidad muestra confirmacion inline y al confirmar invoca kg_delete_entity
//   (4) crear relacion invoca kg_create_relations con origen/tipo/destino

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { KgEditorPane } from "../KgEditorPane";
import type { KgGraph } from "../memoryTypes";

// ---------------------------------------------------------------------------
// Grafos de prueba
// ---------------------------------------------------------------------------

const GRAPH_INICIAL: KgGraph = {
  entities: [
    { name: "Proyecto", entity_type: "project", observations: ["obs1", "obs2"] },
    { name: "Agente",   entity_type: "agent",   observations: [] },
  ],
  relations: [
    { from: "Proyecto", to: "Agente", relation_type: "usa" },
  ],
};

const GRAPH_VACIO: KgGraph = { entities: [], relations: [] };

const GRAPH_TRAS_CREAR: KgGraph = {
  entities: [
    ...GRAPH_INICIAL.entities,
    { name: "NuevaEntidad", entity_type: "concept", observations: ["linea1"] },
  ],
  relations: GRAPH_INICIAL.relations,
};

const GRAPH_TRAS_BORRAR: KgGraph = {
  entities: [GRAPH_INICIAL.entities[1]!],
  relations: [],
};

const GRAPH_TRAS_RELACION: KgGraph = {
  entities: GRAPH_INICIAL.entities,
  relations: [
    ...GRAPH_INICIAL.relations,
    { from: "Proyecto", to: "Agente", relation_type: "depende_de" },
  ],
};

// Resetear el mock completamente entre tests para no acumular llamadas
beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

// ---------------------------------------------------------------------------
// (1) Carga inicial
// ---------------------------------------------------------------------------

describe("KgEditorPane — carga inicial", () => {
  it("invoca kg_read_graph al montar", async () => {
    vi.mocked(invoke).mockResolvedValue(GRAPH_INICIAL);
    render(<KgEditorPane />);

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("kg_read_graph"),
    );
  });

  it("renderiza las entidades devueltas por kg_read_graph", async () => {
    vi.mocked(invoke).mockResolvedValue(GRAPH_INICIAL);
    render(<KgEditorPane />);

    // getAllByText porque el nombre aparece tambien en los <option> de los selectores
    await waitFor(() => {
      expect(screen.getAllByText("Proyecto").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Agente").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("muestra el contador de entidades y relaciones en la cabecera", async () => {
    vi.mocked(invoke).mockResolvedValue(GRAPH_INICIAL);
    render(<KgEditorPane />);

    await waitFor(() =>
      expect(screen.getByText(/2 entidades · 1 relaciones/)).toBeTruthy(),
    );
  });

  it("muestra la relacion cargada del grafo", async () => {
    vi.mocked(invoke).mockResolvedValue(GRAPH_INICIAL);
    render(<KgEditorPane />);

    await waitFor(() => {
      expect(screen.getByText("usa")).toBeTruthy();
    });
  });

  it("muestra mensaje cuando no hay entidades", async () => {
    vi.mocked(invoke).mockResolvedValue(GRAPH_VACIO);
    render(<KgEditorPane />);

    await waitFor(() =>
      expect(screen.getByText(/Sin entidades/)).toBeTruthy(),
    );
  });
});

// ---------------------------------------------------------------------------
// (2) Crear entidad
// ---------------------------------------------------------------------------

describe("KgEditorPane — crear entidad", () => {
  it("invoca kg_create_entities con nombre, tipo y observaciones", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(GRAPH_INICIAL)   // kg_read_graph inicial
      .mockResolvedValueOnce(GRAPH_TRAS_CREAR); // kg_create_entities

    render(<KgEditorPane />);

    // Esperar que la carga inicial termine (aparece el boton deshabilitado)
    await waitFor(() => screen.getByPlaceholderText("nombre"));

    fireEvent.change(screen.getByPlaceholderText("nombre"), {
      target: { value: "NuevaEntidad" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("entityType (por defecto: entity)"),
      { target: { value: "concept" } },
    );
    fireEvent.change(
      screen.getByPlaceholderText("observaciones (una por linea)"),
      { target: { value: "linea1" } },
    );

    fireEvent.click(screen.getByRole("button", { name: /Crear entidad/i }));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("kg_create_entities", {
        entities: [
          {
            name: "NuevaEntidad",
            entity_type: "concept",
            observations: ["linea1"],
          },
        ],
      }),
    );
  });

  it("usa 'entity' como tipo por defecto cuando el campo tipo esta vacio", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(GRAPH_INICIAL)
      .mockResolvedValueOnce(GRAPH_TRAS_CREAR);

    render(<KgEditorPane />);

    await waitFor(() => screen.getByPlaceholderText("nombre"));

    fireEvent.change(screen.getByPlaceholderText("nombre"), {
      target: { value: "SinTipo" },
    });
    // No rellenamos el campo tipo

    fireEvent.click(screen.getByRole("button", { name: /Crear entidad/i }));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("kg_create_entities", {
        entities: [
          expect.objectContaining({ entity_type: "entity" }),
        ],
      }),
    );
  });

  it("el boton Crear entidad esta deshabilitado cuando el nombre esta vacio", async () => {
    vi.mocked(invoke).mockResolvedValue(GRAPH_INICIAL);
    render(<KgEditorPane />);

    await waitFor(() => screen.getByPlaceholderText("nombre"));

    const btn = screen.getByRole("button", { name: /Crear entidad/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (3) Borrar entidad — confirmacion inline
// ---------------------------------------------------------------------------

describe("KgEditorPane — borrar entidad", () => {
  it("muestra el banner de confirmacion al hacer click en Borrar", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(GRAPH_INICIAL)
      .mockResolvedValueOnce(GRAPH_TRAS_BORRAR);

    render(<KgEditorPane />);

    // findByRole espera automaticamente a que aparezca el boton
    const borrarBtn = await screen.findByRole("button", {
      name: /Borrar entidad Proyecto/i,
    });

    fireEvent.click(borrarBtn);

    await waitFor(() =>
      expect(screen.getByRole("alertdialog")).toBeTruthy(),
    );
    expect(screen.getByText(/Borrar entidad "Proyecto"/)).toBeTruthy();
  });

  it("invoca kg_delete_entity al confirmar el borrado", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(GRAPH_INICIAL)
      .mockResolvedValueOnce(GRAPH_TRAS_BORRAR);

    render(<KgEditorPane />);

    const borrarBtn = await screen.findByRole("button", {
      name: /Borrar entidad Proyecto/i,
    });
    fireEvent.click(borrarBtn);

    await waitFor(() => screen.getByRole("alertdialog"));
    fireEvent.click(screen.getByRole("button", { name: /Confirmar/i }));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("kg_delete_entity", {
        name: "Proyecto",
      }),
    );
  });

  it("oculta el banner al cancelar sin invocar kg_delete_entity", async () => {
    vi.mocked(invoke).mockResolvedValue(GRAPH_INICIAL);

    render(<KgEditorPane />);

    const borrarBtn = await screen.findByRole("button", {
      name: /Borrar entidad Proyecto/i,
    });
    fireEvent.click(borrarBtn);

    await waitFor(() => screen.getByRole("alertdialog"));

    // Limpiar el historial de llamadas justo antes de cancelar
    vi.mocked(invoke).mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Cancelar/i }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).toBeNull(),
    );

    // kg_delete_entity NO debe haberse llamado desde que limpiamos el spy
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "kg_delete_entity",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// (4) Crear relacion
// ---------------------------------------------------------------------------

describe("KgEditorPane — crear relacion", () => {
  it("invoca kg_create_relations con origen, tipo y destino correctos", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(GRAPH_INICIAL)
      .mockResolvedValueOnce(GRAPH_TRAS_RELACION);

    render(<KgEditorPane />);

    // Esperar que los selectores se pueblen (las entidades estan cargadas)
    await screen.findByRole("button", { name: /Borrar entidad Proyecto/i });

    fireEvent.change(
      screen.getByRole("combobox", { name: /Entidad origen/i }),
      { target: { value: "Proyecto" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /Tipo de relacion/i }),
      { target: { value: "depende_de" } },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: /Entidad destino/i }),
      { target: { value: "Agente" } },
    );

    // El boton debe habilitarse ahora
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Crear relacion/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: /Crear relacion/i }));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("kg_create_relations", {
        relations: [
          { from: "Proyecto", to: "Agente", relation_type: "depende_de" },
        ],
      }),
    );
  });

  it("usa 'relates_to' como tipo por defecto cuando el campo tipo esta vacio", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(GRAPH_INICIAL)
      .mockResolvedValueOnce(GRAPH_TRAS_RELACION);

    render(<KgEditorPane />);

    await screen.findByRole("button", { name: /Borrar entidad Proyecto/i });

    fireEvent.change(
      screen.getByRole("combobox", { name: /Entidad origen/i }),
      { target: { value: "Proyecto" } },
    );
    // No rellenamos el tipo de relacion
    fireEvent.change(
      screen.getByRole("combobox", { name: /Entidad destino/i }),
      { target: { value: "Agente" } },
    );

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Crear relacion/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByRole("button", { name: /Crear relacion/i }));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("kg_create_relations", {
        relations: [
          expect.objectContaining({ relation_type: "relates_to" }),
        ],
      }),
    );
  });

  it("el boton Crear relacion esta deshabilitado si origen == destino", async () => {
    vi.mocked(invoke).mockResolvedValue(GRAPH_INICIAL);

    render(<KgEditorPane />);

    await screen.findByRole("button", { name: /Borrar entidad Proyecto/i });

    fireEvent.change(
      screen.getByRole("combobox", { name: /Entidad origen/i }),
      { target: { value: "Proyecto" } },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: /Entidad destino/i }),
      { target: { value: "Proyecto" } },
    );

    const btn = screen.getByRole("button", { name: /Crear relacion/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
