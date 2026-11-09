// Panel: la tarjeta de eventos de caída no repite el detalle genérico y corta
// en 5 con «+N más»; la de Pendientes ordena por urgencia y resume el resto.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  CrashEventsCard,
  MAX_CRASH_EVENTS,
  shortDescription,
  usefulDetail,
  type EventLogEntry,
} from "../CrashEventsCard";
import { PendingKanbanCard, pendingItems } from "../PendingKanbanCard";
import type { KanbanBoard } from "../../../types";

function evt(id: number, message: string, minutesAgo = 0): EventLogEntry {
  return {
    event_id: id,
    source: "Microsoft-Windows-Kernel-Power",
    log_name: "System",
    level: "critical",
    time_created: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    message,
  };
}

const GENERIC =
  "El sistema se ha reiniciado sin apagarse limpiamente primero.";

describe("usefulDetail", () => {
  it("omite el detalle vacío o que solo es un código", () => {
    const all = [evt(41, ""), evt(41, "0"), evt(41, "0x0000009f")];
    expect(all.map((e) => usefulDetail(e, all))).toEqual([null, null, null]);
  });

  it("omite el texto que se repite en varios eventos", () => {
    const all = [evt(41, GENERIC), evt(41, ` ${GENERIC}  `), evt(6008, "Otro texto distinto")];
    expect(usefulDetail(all[0], all)).toBeNull();
    expect(usefulDetail(all[1], all)).toBeNull();
    expect(usefulDetail(all[2], all)).toBe("Otro texto distinto");
  });

  it("omite el detalle igual a la descripción del evento", () => {
    const e = evt(41, shortDescription(evt(41, "")));
    expect(usefulDetail(e, [e])).toBeNull();
  });

  it("conserva un mensaje único con contenido (caso negativo)", () => {
    const e = evt(6008, "El último apagado del sistema a las 3:12:01 fue inesperado.");
    expect(usefulDetail(e, [e, evt(41, GENERIC)])).toBe(e.message);
  });
});

describe("CrashEventsCard", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("pinta como mucho 5 eventos, sin el detalle genérico, y un «+N más» que abre Sistema", async () => {
    const events = Array.from({ length: 8 }, (_, i) => evt(41, GENERIC, i * 60));
    vi.mocked(invoke).mockResolvedValue(events);
    const onOpenSystem = vi.fn();
    render(<CrashEventsCard onOpenSystem={onOpenSystem} />);
    await waitFor(() => expect(screen.getAllByText(/^id 41$/i)).toHaveLength(MAX_CRASH_EVENTS));
    expect(screen.queryByText(GENERIC)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /\+3 más/ }));
    expect(onOpenSystem).toHaveBeenCalledTimes(1);
  });

  it("sin eventos dice que todo está en orden y no ofrece «más»", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(<CrashEventsCard />);
    await waitFor(() => expect(screen.getByText("Todo en orden")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /más/ })).toBeNull();
  });
});

const BOARD: KanbanBoard = {
  project_id: "p",
  default_agent: null,
  default_prompt_template: null,
  schema_version: 1,
  columns: [
    { id: "b", name: "Backlog", order: 0, role: "todo" },
    { id: "w", name: "In Progress", order: 1, role: "doing" },
    { id: "x", name: "Blocked", order: 2, role: "blocked" },
    { id: "d", name: "Done", order: 3, role: "done" },
  ],
  cards: [
    ["c1", "b", "Idea suelta", 0],
    ["c2", "w", "En marcha", 0],
    ["c3", "x", "Atascada", 0],
    ["c4", "d", "Cerrada", 0],
    ["c5", "b", "Otra idea", 1],
    ["c6", "b", "Tercera idea", 2],
    ["c7", "b", "Cuarta idea", 3],
  ].map(([id, column_id, title, order]) => ({
    id: id as string,
    column_id: column_id as string,
    title: title as string,
    order: order as number,
    description: "",
    agent: null,
    prompt_template: null,
    cwd: null,
    tags: [],
    created_at: "",
    updated_at: "",
    runs: [],
  })),
};

describe("pendingItems", () => {
  it("excluye lo hecho y ordena en curso > bloqueado > backlog", () => {
    const items = pendingItems(BOARD);
    expect(items.map((i) => i.title)).toEqual([
      "En marcha",
      "Atascada",
      "Idea suelta",
      "Otra idea",
      "Tercera idea",
      "Cuarta idea",
    ]);
    expect(items[0].columnName).toBe("In Progress");
  });
});

describe("PendingKanbanCard", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("enseña la columna de cada tarjeta y resume las que no caben", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "list_projects"
        ? [{ id: "p", name: "Proyecto", last_active: new Date().toISOString() }]
        : BOARD,
    );
    const onOpenProjects = vi.fn();
    render(<PendingKanbanCard onOpenProjects={onOpenProjects} />);
    await waitFor(() => expect(screen.getByText("En marcha")).toBeTruthy());
    expect(screen.getByText("In Progress")).toBeTruthy();
    expect(screen.getByText("tarjetas pendientes")).toBeTruthy();
    expect(screen.queryByText("Cuarta idea")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+1 más en el tablero" }));
    expect(onOpenProjects).toHaveBeenCalledTimes(1);
  });
});
