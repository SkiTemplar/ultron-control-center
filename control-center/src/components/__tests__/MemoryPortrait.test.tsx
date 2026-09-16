// MemoryPortrait — render del retrato y fuentes deprecables al descartar.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MemoryPortrait, memorySourceIds, type Portrait } from "../MemoryPortrait";

const PORTRAIT: Portrait = {
  generated_at: "2026-09-16T17:00:00.000Z",
  model: "sonnet",
  stats: { memorias_personales: 134, ficheros: 62 },
  resumen: "Estudiante y desarrollador.",
  bloques: [
    {
      id: "quien_es",
      titulo: "Quién eres",
      afirmaciones: [
        { id: "a1", texto: "Estudia ingeniería", fuentes: ["mem:123"], estado: "none" },
        { id: "a2", texto: "Afirmación descartada", fuentes: [], estado: "discarded" },
      ],
    },
  ],
  proyectos: [{ nombre: "ultron", que_es: "Sistema de IA personal", estado: "activo" }],
  opinion: "Exigente.",
  trato: "Directo.",
};

describe("memorySourceIds", () => {
  it("devuelve solo los ids de brain.db, sin ficheros", () => {
    expect(memorySourceIds(["mem:abc", "file:dir/x.md", "mem:"])).toEqual(["abc"]);
  });
});

describe("MemoryPortrait", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("muestra resumen, opinión y oculta las afirmaciones descartadas", async () => {
    vi.mocked(invoke).mockResolvedValue(PORTRAIT);
    render(<MemoryPortrait />);
    await waitFor(() => expect(screen.getByText("Estudiante y desarrollador.")).toBeTruthy());
    expect(screen.getByText("Exigente.")).toBeTruthy();
    expect(screen.getByText("Estudia ingeniería")).toBeTruthy();
    expect(screen.queryByText("Afirmación descartada")).toBeNull();
  });

  it("sin retrato generado lo indica en vez de quedarse en blanco", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    render(<MemoryPortrait />);
    await waitFor(() => expect(screen.getByText(/Todavía no hay retrato generado/)).toBeTruthy());
  });
});
