// Panel lateral del chat — cambios editables (P1) y pestañas con teclado (P12).
//
// Cubre:
//   (1) `siguientePestana`: la parte pura de la navegación por flechas, con el
//       caso negativo de que las teclas que NO son de la tira no se traguen
//       (si no, el diff dejaría de hacer scroll con arriba/abajo).
//   (2) Sin proyecto no hay acciones de git: el panel dice qué hacer y nada
//       más. Un botón que no puede actuar es peor que no tenerlo.
//   (3) Con proyecto: preparar/quitar, descartar y confirmar; «descartar» NO
//       se ofrece sobre un fichero sin seguir, y «confirmar» está apagado
//       mientras no haya mensaje.
//   (4) Las pestañas se recorren con las flechas y solo la activa es tabulable.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { PanelLateral } from "../PanelLateral";
import { siguientePestana } from "../panelLateralNav";

type Cambio = {
  path: string;
  index_status: string;
  worktree_status: string;
  staged: boolean;
  untracked: boolean;
};

const MODIFICADO: Cambio = {
  path: "src/uno.ts",
  index_status: " ",
  worktree_status: "M",
  staged: false,
  untracked: false,
};
const SIN_SEGUIR: Cambio = {
  path: "notas.txt",
  index_status: "?",
  worktree_status: "?",
  staged: false,
  untracked: true,
};

function pintar(props: Partial<Parameters<typeof PanelLateral>[0]> = {}) {
  const onPanel = vi.fn();
  render(
    <PanelLateral
      panel="cambios"
      onPanel={onPanel}
      onCerrar={vi.fn()}
      artefacto={null}
      onArtefacto={vi.fn()}
      threadId="hilo-1"
      proyecto=""
      refresco={0}
      onAviso={vi.fn()}
      {...props}
    />,
  );
  return { onPanel };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) =>
    cmd === "git_changes" ? [MODIFICADO, SIN_SEGUIR] : null,
  );
});

describe("siguientePestana", () => {
  it("recorre las pestañas y da la vuelta por los dos lados", () => {
    expect(siguientePestana("ArrowRight", 0, 3)).toBe(1);
    expect(siguientePestana("ArrowRight", 2, 3)).toBe(0);
    expect(siguientePestana("ArrowLeft", 0, 3)).toBe(2);
    expect(siguientePestana("Home", 2, 3)).toBe(0);
    expect(siguientePestana("End", 0, 3)).toBe(2);
  });

  it("no se traga las teclas que no son suyas", () => {
    // Caso negativo: si devolviera un índice para ArrowDown, el componente
    // haría preventDefault y el diff dejaría de poder recorrerse.
    expect(siguientePestana("ArrowDown", 0, 3)).toBeNull();
    expect(siguientePestana("Enter", 0, 3)).toBeNull();
    expect(siguientePestana("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("panel Cambios sin proyecto", () => {
  it("explica qué hacer y no ofrece ninguna acción de git", async () => {
    pintar();
    expect(await screen.findByText(/no trabaja sobre ningún proyecto/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /preparar todo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^confirmar/i })).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("git_changes", expect.anything());
  });
});

describe("panel Cambios con proyecto", () => {
  it("prepara un fichero llamando a git_stage con su ruta", async () => {
    pintar({ proyecto: "/repo" });
    const caja = await screen.findByLabelText(/preparar src\/uno\.ts/i);
    fireEvent.click(caja);
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("git_stage", {
        path: "/repo",
        files: ["src/uno.ts"],
      }),
    );
  });

  it("no ofrece descartar sobre un fichero sin seguir", async () => {
    // Descartar uno sin seguir sería borrarlo: git no tiene copia de él.
    pintar({ proyecto: "/repo" });
    expect(await screen.findByLabelText(/descartar los cambios de src\/uno\.ts/i)).toBeTruthy();
    expect(screen.queryByLabelText(/descartar los cambios de notas\.txt/i)).toBeNull();
  });

  it("confirmar está apagado sin mensaje y sin nada preparado", async () => {
    pintar({ proyecto: "/repo" });
    const boton = (await screen.findByRole("button", {
      name: /^confirmar/i,
    })) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);

    // Con mensaje pero sin ficheros preparados sigue apagado: un commit vacío
    // no es un commit.
    fireEvent.change(screen.getByLabelText(/mensaje del commit/i), {
      target: { value: "arregla el login" },
    });
    expect((screen.getByRole("button", { name: /^confirmar/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("con algo preparado y mensaje, confirmar llama a git_commit", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "git_changes" ? [{ ...MODIFICADO, staged: true, index_status: "M" }] : null,
    );
    pintar({ proyecto: "/repo" });
    fireEvent.change(await screen.findByLabelText(/mensaje del commit/i), {
      target: { value: "arregla el login" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^confirmar/i }));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("git_commit", {
        path: "/repo",
        message: "arregla el login",
      }),
    );
  });
});

describe("pestañas del panel lateral", () => {
  it("las flechas mueven la pestaña activa y solo la activa es tabulable", async () => {
    const { onPanel } = pintar({ proyecto: "/repo" });
    const pestanas = await screen.findAllByRole("tab");
    expect(pestanas.map((p) => p.textContent)).toEqual(["cambios", "web", "ficheros"]);
    expect(pestanas[0].getAttribute("aria-selected")).toBe("true");
    expect(pestanas.map((p) => p.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    fireEvent.keyDown(pestanas[0], { key: "ArrowRight" });
    expect(onPanel).toHaveBeenCalledWith("web");

    fireEvent.keyDown(pestanas[0], { key: "ArrowLeft" });
    expect(onPanel).toHaveBeenLastCalledWith("ficheros");

    fireEvent.keyDown(pestanas[0], { key: "End" });
    expect(onPanel).toHaveBeenLastCalledWith("ficheros");
  });

  it("una tecla ajena no cambia de pestaña", async () => {
    // Caso negativo: con el foco en la tira, ArrowDown tiene que seguir
    // siendo scroll y no saltar de panel.
    const { onPanel } = pintar({ proyecto: "/repo" });
    const pestanas = await screen.findAllByRole("tab");
    fireEvent.keyDown(pestanas[0], { key: "ArrowDown" });
    expect(onPanel).not.toHaveBeenCalled();
  });
});
