// «+ Claude» (14-10): proyectos recientes arriba, el resto por ámbito y
// filtro en el desplegable.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dropdown, filterOptions } from "../components/Dropdown";
import { arrangeProjects, OTHER_SCOPE, scopeOf, shortPath } from "../project-groups";
import type { ProjectRef } from "../types";

const p = (id: string, path: string, lastActive?: string): ProjectRef => ({ id, name: id, path, lastActive });

describe("ámbito y ruta corta", () => {
  it("el ámbito es la primera carpeta bajo la personal", () => {
    expect(scopeOf("C:\\Users\\ana\\CARRERA\\ASIGNATURAS\\TFG")).toBe("Carrera");
    expect(scopeOf("C:\\Users\\ana\\.ultron\\control-center")).toBe("Ultron");
    expect(scopeOf("/home/ana/proyectos_web/x")).toBe("Proyectos web");
    expect(scopeOf("C:\\Users\\ana")).toBe("Inicio");
    expect(scopeOf("D:\\juegos\\rdr2")).toBe(OTHER_SCOPE);
  });

  it("abrevia la carpeta personal (caso negativo: otra unidad queda igual)", () => {
    expect(shortPath("C:\\Users\\ana\\CARRERA\\TFG")).toBe("~\\CARRERA\\TFG");
    expect(shortPath("D:\\juegos\\rdr2")).toBe("D:\\juegos\\rdr2");
  });
});

describe("arrangeProjects", () => {
  const H = "C:\\Users\\ana";
  const list = [
    p("viejo", `${H}\\Carrera\\viejo`, "2026-01-01T00:00:00Z"),
    p("hoy", `${H}\\Personal\\hoy`, "2026-10-14T10:00:00Z"),
    p("ayer", `${H}\\Carrera\\ayer`, "2026-10-13T10:00:00Z"),
    p("b-carrera", `${H}\\Carrera\\b`),
    p("a-carrera", `${H}\\Carrera\\a`),
    p("solo", `${H}\\Documents\\solo`),
    p("fuera", "D:\\juegos\\fuera"),
  ];

  it("recientes del más nuevo al más viejo, sin repetirse en su ámbito", () => {
    const r = arrangeProjects(list, 2);
    expect(r.recent.map((x) => x.id)).toEqual(["hoy", "ayer"]);
    const carrera = r.groups.find((g) => g.scope === "Carrera");
    expect(carrera?.projects.map((x) => x.id)).toEqual(["a-carrera", "b-carrera", "viejo"]);
  });

  it("ámbitos de un solo proyecto y rutas de fuera van a «Otros», al final", () => {
    const r = arrangeProjects(list, 2);
    expect(r.groups.map((g) => g.scope)).toEqual(["Carrera", OTHER_SCOPE]);
    expect(r.groups[1].projects.map((x) => x.id)).toEqual(["fuera", "solo"]);
  });

  it("sin fechas no hay recientes", () => {
    expect(arrangeProjects([p("x", `${H}\\A\\x`)]).recent).toEqual([]);
  });
});

describe("filtro del desplegable", () => {
  const OPTS = [
    { value: "tfg", label: "TFG — Trabajo Fin de Grado", description: "~\\CARRERA\\TFG", group: "Carrera" },
    { value: "dvj", label: "DVJ — Diseño de Videojuegos", description: "~\\CARRERA\\DVJ", group: "Carrera" },
    { value: "web", label: "Web del club", description: "~\\Personal\\web", group: "Personal" },
  ];

  it("filtra por etiqueta, ruta o grupo sin tildes ni mayúsculas, con todas las palabras", () => {
    expect(filterOptions(OPTS, "diseno").map((o) => o.value)).toEqual(["dvj"]);
    expect(filterOptions(OPTS, "carrera trabajo").map((o) => o.value)).toEqual(["tfg"]);
    expect(filterOptions(OPTS, "personal").map((o) => o.value)).toEqual(["web"]);
    expect(filterOptions(OPTS, "  ")).toBe(OPTS);
    expect(filterOptions(OPTS, "zzz")).toEqual([]);
  });

  it("escribir filtra, Enter elige la primera coincidencia y sin coincidencias lo dice", async () => {
    const onSelect = vi.fn();
    render(<Dropdown label="Proyectos" trigger="+ Claude" options={OPTS} onSelect={onSelect} searchable="Filtrar" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "+ Claude" })));
    const input = screen.getByRole("searchbox", { name: "Filtrar" });
    fireEvent.change(input, { target: { value: "nada" } });
    expect(screen.getByRole("status").textContent).toContain("Sin coincidencias");
    fireEvent.change(input, { target: { value: "club" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("web");
  });
});
