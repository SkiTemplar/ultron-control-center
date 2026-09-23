// Ajustes → Arranque (2026-09-23): el interruptor enseña la DECISIÓN guardada,
// no lo que haya en el registro, y desactivado cuenta lo que siga lanzándose
// al iniciar sesión. Se prueba contra el contrato de `maria_arranque_estado` /
// `maria_arranque_set` con `invoke` simulado.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { ArranqueSection } from "../ArranqueSection";

type Estado = {
  activado_en_ajustes: boolean;
  registrado: boolean;
  comando: string;
  apunta_aqui: boolean;
  bloqueado_por_windows: boolean;
  tareas_de_inicio: string[];
  tareas_apagadas: string[];
  problema: string;
};

const APAGADO: Estado = {
  activado_en_ajustes: false,
  registrado: false,
  comando: "",
  apunta_aqui: false,
  bloqueado_por_windows: false,
  tareas_de_inicio: [],
  tareas_apagadas: ["\\ULTRON-QdrantBoot"],
  problema: "",
};

const ENCENDIDO: Estado = {
  ...APAGADO,
  activado_en_ajustes: true,
  registrado: true,
  comando: '"C:\\x\\control-center.exe" --from-autostart',
  apunta_aqui: true,
  tareas_apagadas: [],
};

const mockInvoke = vi.mocked(invoke);

function servir(estado: Estado, tras: Estado = estado) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "maria_arranque_estado") return estado;
    if (cmd === "maria_arranque_set") return tras;
    throw new Error(`comando inesperado: ${cmd}`);
  });
}

describe("ArranqueSection", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("desactivado: casilla sin marcar, sin entrada ni tareas, y las apagadas a la vista", async () => {
    servir(APAGADO);
    render(<ArranqueSection />);
    await screen.findByText("desactivado");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByText("sin entrada de arranque")).toBeInTheDocument();
    expect(screen.getByText("ninguna tarea de mar.ia al iniciar sesión")).toBeInTheDocument();
    expect(screen.getByText(/ULTRON-QdrantBoot/)).toBeInTheDocument();
  });

  it("activarlo manda activar=true y enseña lo que devuelve el backend", async () => {
    servir(APAGADO, ENCENDIDO);
    render(<ArranqueSection />);
    await screen.findByText("desactivado");
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("maria_arranque_set", { activar: true }),
    );
    await screen.findByText("activo");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("caso negativo: activado pero sin entrada NO se pinta como activo", async () => {
    // Lo que pasaba antes al revés: la casilla seguía al registro. Si la
    // decisión es «activado» y falta la entrada, se dice, no se disimula.
    servir({ ...ENCENDIDO, registrado: false, apunta_aqui: false, problema: "falta" });
    render(<ArranqueSection />);
    await screen.findByText("activado, pero no arranca");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("desactivado con una tarea que sigue encendida la nombra", async () => {
    servir({ ...APAGADO, tareas_de_inicio: ["\\ULTRON-QdrantWatchdog"], tareas_apagadas: [] });
    render(<ArranqueSection />);
    await screen.findByText(/siguen lanzándose al iniciar sesión: \\ULTRON-QdrantWatchdog/);
  });
});
