// useNewProjectWizard — unit tests
//
// Covers:
//   (1) Un nombre invalido bloquea el avance del paso "nombre" — que es lo
//       que, en la UI, deshabilita llegar al boton "Crear" (canAdvance()
//       gatea el "Siguiente" del stepper). Caso negativo: nombre invalido
//       vs. nombre valido en el mismo paso.
//   (2) La vista previa de ruta (previewPath) compone raiz + subcarpeta +
//       nombre; sin raiz seleccionada no hay vista previa (negativo).

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cliList, cliRoots, type CliRoot } from "../../../lib/project-create-cli";
import { useNewProjectWizard } from "./useNewProjectWizard";

vi.mock("../../../lib/project-create-cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/project-create-cli")>();
  return {
    ...actual,
    cliRoots: vi.fn(),
    cliList: vi.fn(),
    cliTemplates: vi.fn(),
    cliSubjectNew: vi.fn(),
    cliMkdir: vi.fn(),
    cliCreate: vi.fn(),
  };
});

const PERSONAL_ROOT: CliRoot = {
  id: "personal",
  label: "Personal",
  path: "C:\\Users\\dev\\Proyectos",
  kind: "personal",
  exists: true,
};

function setup() {
  vi.mocked(cliRoots).mockResolvedValue({ ok: true, roots: [PERSONAL_ROOT] });
  // El paso "carpeta" dispara cliList al entrar — resolverlo siempre evita
  // un unhandled rejection cuando los tests avanzan el stepper.
  vi.mocked(cliList).mockResolvedValue({ ok: true, root: PERSONAL_ROOT.id, sub: "", entries: [] });
  return renderHook(() => useNewProjectWizard({ open: true, onClose: vi.fn() }));
}

beforeEach(() => {
  vi.mocked(cliRoots).mockReset();
  vi.mocked(cliList).mockReset();
});

async function selectPersonalRoot(result: ReturnType<typeof setup>["result"]) {
  await waitFor(() => expect(result.current.roots).not.toBeNull());
  act(() => result.current.setRootId(PERSONAL_ROOT.id));
  await waitFor(() => expect(result.current.selectedRoot?.id).toBe(PERSONAL_ROOT.id));
}

describe("useNewProjectWizard — canAdvance en el paso nombre", () => {
  it("nombre invalido bloquea el avance; nombre valido lo permite (caso negativo incluido)", async () => {
    const { result } = setup();
    await selectPersonalRoot(result);

    act(() => result.current.next()); // tipo -> carpeta
    act(() => result.current.next()); // carpeta -> nombre
    expect(result.current.currentStep).toBe("nombre");

    act(() => result.current.setName("a/b"));
    expect(result.current.canAdvance()).toBe(false);

    act(() => result.current.setName("Proyecto válido"));
    expect(result.current.canAdvance()).toBe(true);
  });
});

describe("useNewProjectWizard — previewPath", () => {
  it("compone raiz + subcarpeta + nombre; sin raiz seleccionada no hay vista previa", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.roots).not.toBeNull());

    // Negativo: sin root seleccionado, no hay preview aunque haya nombre.
    act(() => result.current.setName("MiProyecto"));
    expect(result.current.previewPath).toBeNull();

    await selectPersonalRoot(result);
    act(() => result.current.setCurrentSub("sub/folder"));

    expect(result.current.previewPath).toBe(
      "C:\\Users\\dev\\Proyectos\\sub\\folder\\MiProyecto",
    );
  });
});
