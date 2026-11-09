// Pestaña Adjuntos: rutas citadas o escritas por Claude, resueltas contra el
// cwd de la sesión, deduplicadas por ruta absoluta y filtradas por su estado
// en disco; acciones Abrir / Abrir carpeta / Copiar ruta.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Markdown } from "../components/chat/Markdown";
import { Adjuntos } from "../components/inspector/Adjuntos";
import { collectAttachments } from "../components/inspector/adjuntos-collect";
import { extractPaths, pathKey, resolvePath } from "../components/inspector/rutas-sesion";
import { ApiContext } from "../context";
import { store } from "../store";
import type { ChatMessage, PathStatus } from "../types";

const CWD = "C:\\Users\\yo\\proy";

function msg(uuid: string, role: ChatMessage["role"], blocks: ChatMessage["blocks"]): ChatMessage {
  return { uuid, role, timestamp: "2026-10-19T10:00:00Z", blocks, agentId: null };
}

describe("extractPaths", () => {
  it("relativas, absolutas de Windows y POSIX, y entre comillas invertidas", () => {
    const text = "Render en `.tmp/brag-ultron/brag.mp4` (también out/b.webm). Log: C:\\Users\\yo\\x\\run.log, "
      + "copia en /home/yo/a.png y `C:\\Mis vídeos\\final 2.mov:12`. Mira [aquí](docs/guia.pdf).";
    expect(extractPaths(text)).toEqual([
      ".tmp/brag-ultron/brag.mp4",
      "C:\\Mis vídeos\\final 2.mov",
      "out/b.webm",
      "C:\\Users\\yo\\x\\run.log",
      "/home/yo/a.png",
      "docs/guia.pdf",
    ]);
  });

  it("caso negativo: URLs, órdenes, versiones y palabras con barra no son rutas", () => {
    const text = "Ver https://x.example/a/logo.png y file://srv/a.mp4; ejecuta `npm run build`, "
      + "`console.log()`, versión 1.2/3.4, y/o, TCP/IP, `src/sesiones`.";
    expect(extractPaths(text)).toEqual([]);
  });
});

describe("resolvePath", () => {
  it("resuelve relativas contra el cwd y normaliza separadores, `.` y `..`", () => {
    expect(resolvePath(".tmp/brag-ultron/brag.mp4", CWD)).toBe("C:\\Users\\yo\\proy\\.tmp\\brag-ultron\\brag.mp4");
    expect(resolvePath("./out/../out/a.png", CWD)).toBe("C:\\Users\\yo\\proy\\out\\a.png");
    expect(resolvePath("c:/Users/yo/x.mp4")).toBe("C:\\Users\\yo\\x.mp4");
    expect(resolvePath("/c/Users/yo/x.mp4", CWD)).toBe("C:\\Users\\yo\\x.mp4");
    expect(resolvePath("out/a.png", "/home/yo/p")).toBe("/home/yo/p/out/a.png");
  });

  it("caso negativo: relativa sin cwd, UNC, `~` o por encima de la raíz → null", () => {
    expect(resolvePath("out/a.png")).toBeNull();
    expect(resolvePath("\\\\srv\\share\\a.png", CWD)).toBeNull();
    expect(resolvePath("~/a.png", CWD)).toBeNull();
    expect(resolvePath("../../../../a.png", CWD)).toBeNull();
    expect(pathKey("C:\\A\\B.png")).toBe(pathKey("c:\\a\\b.PNG"));
  });
});

describe("collectAttachments con cwd", () => {
  it("Write/Edit de cualquier tipo y rutas del texto, deduplicadas por ruta absoluta", () => {
    const messages = [
      msg("a1", "assistant", [
        { kind: "toolUse", id: "t1", name: "Write", input: { file_path: "C:\\Users\\yo\\proy\\src\\main.rs" }, summary: "" },
        { kind: "text", text: "Hecho: `src/main.rs`, `.tmp/v.mp4` y C:/Users/yo/proy/.tmp/V.MP4" },
      ]),
    ];
    const { output } = collectAttachments(messages, [], CWD);
    expect(output.map((o) => [o.path, o.isSpeculative])).toEqual([
      ["C:\\Users\\yo\\proy\\src\\main.rs", false],
      ["C:\\Users\\yo\\proy\\.tmp\\v.mp4", true],
    ]);
  });

  it("una ruta citada que luego escribe una herramienta deja de ser especulativa", () => {
    const messages = [
      msg("a1", "assistant", [{ kind: "text", text: "Voy a escribir `out/r.md`." }]),
      msg("a2", "assistant", [{ kind: "toolUse", id: "t", name: "Edit", input: { file_path: "out/r.md" }, summary: "" }]),
    ];
    const { output } = collectAttachments(messages, [], CWD);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ path: "C:\\Users\\yo\\proy\\out\\r.md", isSpeculative: false });
  });

  it("caso negativo: una relativa del texto sin cwd no se inventa una ruta", () => {
    const { output } = collectAttachments([msg("a", "assistant", [{ kind: "text", text: "en out/a.mp4" }])]);
    expect(output).toEqual([]);
  });
});

describe("rutas citadas en el chat", () => {
  it("un vídeo entre comillas invertidas se abre con la app del sistema y el código sigue en VS Code", () => {
    const api = { isMock: true, readImage: vi.fn(async () => ""), openFile: vi.fn(async () => undefined), openInEditor: vi.fn(async () => undefined) };
    render(<ApiContext.Provider value={api as unknown as SesionesApi}><Markdown text="Listo: `.tmp/brag-ultron/brag.mp4` y `src/a.ts:3`" /></ApiContext.Provider>);
    fireEvent.click(screen.getByText(".tmp/brag-ultron/brag.mp4"));
    fireEvent.click(screen.getByText("src/a.ts:3"));
    expect(api.openFile).toHaveBeenCalledWith(".tmp/brag-ultron/brag.mp4", undefined);
    expect(api.openInEditor).toHaveBeenCalledWith("src/a.ts", 3, undefined);
    expect(api.openFile).toHaveBeenCalledTimes(1);
  });
});

function status(path: string, exists: boolean, canOpen = exists): PathStatus {
  return { path, abs: exists ? path : null, exists, isFile: exists, canOpen, size: exists ? 10 : null, error: exists ? null : `no existe: ${path}` };
}

describe("Adjuntos (componente)", () => {
  function mount(existing: string[], canOpen: (p: string) => boolean = () => true) {
    const api = {
      isMock: true,
      readImage: vi.fn(async () => "data:image/png;base64,AA=="),
      openFile: vi.fn(async () => undefined),
      revealPath: vi.fn(async () => undefined),
      pathsStatus: vi.fn(async (paths: readonly string[]) => paths.map((p) => ({ ...status(p, existing.includes(p)), canOpen: existing.includes(p) && canOpen(p) }))),
    };
    const id = `adj-${Math.random().toString(36).slice(2)}`;
    store.dispatch({
      type: "messages", id, messages: [
        msg("a1", "assistant", [
          { kind: "toolUse", id: "t1", name: "Write", input: { file_path: "out/borrado.txt" }, summary: "" },
          { kind: "text", text: "Vídeo en `.tmp/brag.mp4`, script en `out/run.bat` y nada en `out/fantasma.mp4`." },
        ]),
      ],
    });
    render(<ApiContext.Provider value={api as unknown as SesionesApi}><Adjuntos sessionId={id} cwd={CWD} /></ApiContext.Provider>);
    return api;
  }

  it("enseña lo que existe con sus acciones, marca lo escrito y borrado, y oculta lo citado que no existe", async () => {
    const mp4 = "C:\\Users\\yo\\proy\\.tmp\\brag.mp4";
    const bat = "C:\\Users\\yo\\proy\\out\\run.bat";
    const api = mount([mp4, bat], (p) => !p.endsWith(".bat"));
    const salida = screen.getByTestId("adjuntos-salida");
    await waitFor(() => expect(within(salida).getByText("brag.mp4")).toBeTruthy());
    expect(within(salida).queryByText("fantasma.mp4")).toBeNull();
    expect(within(salida).getByText(/No está en disco: no existe: .*borrado\.txt/)).toBeTruthy();
    const filas = within(salida).getAllByTestId("adjunto");
    expect(filas).toHaveLength(3);
    const [borrado, video, script] = filas;
    expect((within(borrado).getByText("Abrir") as HTMLButtonElement).disabled).toBe(true);
    expect((within(script).getByText("Abrir") as HTMLButtonElement).disabled).toBe(true);
    expect(within(script).getByText("Abrir").getAttribute("title")).toMatch(/Por seguridad/);
    fireEvent.click(within(video).getByText("Abrir"));
    fireEvent.click(within(video).getByText("Abrir carpeta"));
    expect(api.openFile).toHaveBeenCalledWith(mp4, CWD);
    expect(api.revealPath).toHaveBeenCalledWith(mp4, CWD);
    expect(within(video).getByText("brag.mp4").getAttribute("title")).toBe(mp4);
  });
});

describe("Adjuntos: la lista de rutas se queda vacía", () => {
  const MP4 = "C:\\Users\\yo\\proy\\.tmp\\brag.mp4";

  function sessionWith(text: string | null): string {
    const id = `adj-vacia-${Math.random().toString(36).slice(2)}`;
    store.dispatch({ type: "messages", id, messages: text === null ? [] : [msg("a1", "assistant", [{ kind: "text", text }])] });
    return id;
  }

  function setup(pathsStatus: (paths: readonly string[]) => Promise<PathStatus[]>) {
    const api = { isMock: true, readImage: vi.fn(async () => ""), openFile: vi.fn(), revealPath: vi.fn(), pathsStatus: vi.fn(pathsStatus) };
    const view = (sessionId: string) => <ApiContext.Provider value={api as unknown as SesionesApi}><Adjuntos sessionId={sessionId} cwd={CWD} /></ApiContext.Provider>;
    return { api, view };
  }

  it("descarta las filas comprobadas antes: una ruta citada no reaparece con el estado viejo", async () => {
    let calls = 0;
    const { view } = setup((paths) => (calls++ === 0 ? Promise.resolve(paths.map((p) => status(p, true))) : new Promise<PathStatus[]>(() => {})));
    const { rerender } = render(view(sessionWith("Vídeo en `.tmp/brag.mp4`.")));
    await waitFor(() => expect(within(screen.getByTestId("adjuntos-salida")).getByText("brag.mp4")).toBeTruthy());
    rerender(view(sessionWith(null)));
    await waitFor(() => expect(screen.getByText("Rutas resueltas contra el directorio de la sesión.")).toBeTruthy());
    // Otra sesión cita la misma ruta y su consulta sigue pendiente: sin el
    // reinicio, el mapa viejo la daría por existente.
    rerender(view(sessionWith("Otra vez `.tmp/brag.mp4`.")));
    expect(screen.getByText("Comprobando ficheros…")).toBeTruthy();
    expect(within(screen.getByTestId("adjuntos-salida")).queryByText("brag.mp4")).toBeNull();
    expect(calls).toBe(2);
  });

  it("no se queda en «Comprobando» ni con el error de la lista anterior", async () => {
    const pendiente = setup(() => new Promise<PathStatus[]>(() => {}));
    const a = render(pendiente.view(sessionWith("Vídeo en `.tmp/brag.mp4`.")));
    expect(screen.getByText("Comprobando ficheros…")).toBeTruthy();
    a.rerender(pendiente.view(sessionWith(null)));
    await waitFor(() => expect(screen.queryByText("Comprobando ficheros…")).toBeNull());
    a.unmount();

    const fallo = setup(() => Promise.reject(new Error("sin puente")));
    const b = render(fallo.view(sessionWith("Vídeo en `.tmp/brag.mp4`.")));
    await waitFor(() => expect(screen.getByText(/No se pudo comprobar qué ficheros existen: sin puente/)).toBeTruthy());
    b.rerender(fallo.view(sessionWith(null)));
    await waitFor(() => expect(screen.queryByText(/No se pudo comprobar/)).toBeNull());
    b.unmount();
  });

  it("caso negativo: con rutas, una consulta nueva no borra el resultado de la anterior", async () => {
    const { api, view } = setup(async (paths) => paths.map((p) => status(p, true)));
    const id = sessionWith("Vídeo en `.tmp/brag.mp4`.");
    const { rerender, unmount } = render(view(id));
    await waitFor(() => expect(within(screen.getByTestId("adjuntos-salida")).getByText("brag.mp4")).toBeTruthy());
    rerender(view(id));
    expect(within(screen.getByTestId("adjuntos-salida")).getByText("brag.mp4")).toBeTruthy();
    expect(api.pathsStatus).toHaveBeenCalledWith([MP4]);
    unmount();
  });
});
