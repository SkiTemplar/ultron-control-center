// Exportar la conversación (`sesiones_export`): menú de la barra superior,
// `/exportar md|html` desde el composer (sin pisar el `/export` de Claude Code)
// y avisos visibles para éxito, cancelación y fallo (nunca un no-op silencioso).

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { ExportMenu } from "../components/ExportMenu";
import { EXPORT_USAGE, FALLBACK_COMMANDS, parseExportFormat, withSessionCommands } from "../components/composer/commands";
import { routeSlash } from "../components/composer/route";
import { useChatSubmit } from "../components/composer/useChatSubmit";
import { ApiContext } from "../context";
import { exportConversation, exportStore } from "../export";
import { store } from "../store";
import type { ExportResult, SessionInfo } from "../types";

const SID = "exp1";
const RESULT: ExportResult = { path: "C:/Users/r/Documents/ultron-2026-10-15.html", messages: 812, bytes: 6_400_000 };

const info: SessionInfo = {
  id: SID, projectId: "p", projectName: "ultron", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

function fakeApi(exportImpl: () => Promise<ExportResult | null> = async () => RESULT) {
  return {
    exportConversation: vi.fn(exportImpl),
    openExport: vi.fn(async () => {}),
    runCommand: vi.fn(async () => ({ disposition: "written" })),
  };
}

const asApi = (f: ReturnType<typeof fakeApi>) => f as unknown as SesionesApi;
const notes = () => store.getState().bySession[SID]?.notes ?? [];
const lastNote = () => notes()[notes().length - 1];

beforeEach(() => {
  act(() => store.dispatch({ type: "sessions", sessions: [info] }));
  exportStore.dispatch(() => ({ busy: null, last: null }));
});

afterEach(cleanup);

describe("/exportar en el composer", () => {
  it("md y html van a la ruta de exportación aunque la lista viva no los traiga", () => {
    expect(routeSlash("/exportar md", FALLBACK_COMMANDS, true)).toEqual({ type: "export", command: "exportar", format: "md" });
    expect(routeSlash("/exportar HTML", FALLBACK_COMMANDS, true)).toEqual({ type: "export", command: "exportar", format: "html" });
  });

  it("caso negativo: sin formato o con uno desconocido no exporta", () => {
    expect(routeSlash("/exportar", FALLBACK_COMMANDS, true)).toEqual({ type: "export", command: "exportar", format: null });
    expect(parseExportFormat("pdf")).toBeNull();
  });

  it("no pisa el /export nativo de Claude Code", () => {
    expect(routeSlash("/export", FALLBACK_COMMANDS, true)).toEqual({ type: "menu", command: "export", args: "" });
  });

  it("aparece en el autocompletado una sola vez", () => {
    const once = withSessionCommands(FALLBACK_COMMANDS);
    expect(once.filter((c) => c.name === "exportar")).toHaveLength(1);
    expect(withSessionCommands(once)).toBe(once);
  });

  it("el envío llama a sesiones_export y no a la CLI", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useChatSubmit(asApi(api), SID, { commands: FALLBACK_COMMANDS, live: true }, () => {}));
    let ok = false;
    await act(async () => {
      ok = await result.current({ text: "/exportar html", attachments: [], delegate: false, mode: "auto" });
    });
    expect(ok).toBe(true);
    expect(api.exportConversation).toHaveBeenCalledWith({ id: SID, format: "html" });
    expect(api.runCommand).not.toHaveBeenCalled();
  });

  it("sin formato: nota de error con el uso y el borrador se conserva", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useChatSubmit(asApi(api), SID, { commands: FALLBACK_COMMANDS, live: true }, () => {}));
    let ok = true;
    await act(async () => {
      ok = await result.current({ text: "/exportar", attachments: [], delegate: false, mode: "auto" });
    });
    expect(ok).toBe(false);
    expect(api.exportConversation).not.toHaveBeenCalled();
    expect(lastNote()).toMatchObject({ level: "info", text: EXPORT_USAGE });
  });
});

describe("exportConversation", () => {
  it("éxito: nota con la ruta y aviso para abrirlo", async () => {
    await act(async () => {
      await exportConversation(asApi(fakeApi()), SID, "html");
    });
    expect(lastNote()).toMatchObject({ level: "info" });
    expect(lastNote().text).toContain(RESULT.path);
    expect(lastNote().text).toContain("812 mensajes");
    expect(exportStore.getState()).toMatchObject({ busy: null, last: { sessionId: SID, format: "html", result: RESULT } });
  });

  it("cancelar el diálogo deja constancia", async () => {
    await act(async () => {
      await exportConversation(asApi(fakeApi(async () => null)), SID, "md");
    });
    expect(lastNote()).toMatchObject({ level: "info", text: "Exportación cancelada." });
    expect(exportStore.getState().last).toBeNull();
  });

  it("un fallo del backend se muestra como error", async () => {
    await act(async () => {
      await exportConversation(asApi(fakeApi(async () => { throw new Error("el destino debe terminar en .md"); })), SID, "md");
    });
    expect(lastNote().level).toBe("error");
    expect(lastNote().text).toContain("el destino debe terminar en .md");
    expect(exportStore.getState().busy).toBeNull();
  });

  it("una segunda exportación con el diálogo abierto avisa y no llama al backend", async () => {
    const api = fakeApi();
    exportStore.dispatch((s) => ({ ...s, busy: SID }));
    await act(async () => {
      await exportConversation(asApi(api), SID, "md");
    });
    expect(api.exportConversation).not.toHaveBeenCalled();
    expect(lastNote().level).toBe("warn");
  });
});

describe("menú Exportar de la barra superior", () => {
  function mount(api: ReturnType<typeof fakeApi>) {
    render(<ApiContext.Provider value={asApi(api)}><ExportMenu sessionId={SID} /></ApiContext.Provider>);
  }

  it("ofrece Markdown y HTML y exporta el elegido", async () => {
    const api = fakeApi();
    mount(api);
    fireEvent.click(screen.getByRole("button", { name: /Exportar/ }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Markdown (.md)", "HTML (.html)"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Markdown (.md)" }));
    });
    expect(api.exportConversation).toHaveBeenCalledWith({ id: SID, format: "md" });
  });

  it("tras guardar muestra la ruta con Abrir y Mostrar en carpeta", async () => {
    const api = fakeApi();
    mount(api);
    fireEvent.click(screen.getByRole("button", { name: /Exportar/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "HTML (.html)" }));
    });
    expect(screen.getByRole("status").textContent).toContain(RESULT.path);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    });
    expect(api.openExport).toHaveBeenLastCalledWith(RESULT.path, false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mostrar en carpeta" }));
    });
    expect(api.openExport).toHaveBeenLastCalledWith(RESULT.path, true);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("si abrir falla, el error llega al chat", async () => {
    const api = fakeApi();
    api.openExport.mockRejectedValueOnce(new Error("ya no existe"));
    exportStore.dispatch((s) => ({ ...s, last: { sessionId: SID, format: "md", result: RESULT } }));
    mount(api);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    });
    expect(lastNote().level).toBe("error");
    expect(lastNote().text).toContain("ya no existe");
  });

  it("mientras exporta, el botón queda deshabilitado", () => {
    exportStore.dispatch((s) => ({ ...s, busy: SID }));
    mount(fakeApi());
    expect(screen.getByRole("button", { name: /Exportando/ })).toHaveProperty("disabled", true);
  });
});
