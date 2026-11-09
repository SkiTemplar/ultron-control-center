// Adjuntos de cualquier tipo: lo que Claude Code lee va con mención `@`; del resto
// se envía solo la ruta original, sin copiarlo, o una copia si no hay ruta.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_EXT, isReadable, MAX_BYTES, outgoingPayload, TEXT_EXT } from "../components/composer/attachment-kind";
import { localFilePath } from "../components/composer/local-file-path";
import { useAttachments, type Attachment } from "../components/composer/useAttachments";
import { collectAttachments } from "../components/inspector/adjuntos-collect";
import source from "../../../src-tauri/src/sesiones/adjuntos.rs?raw";

const saveAttachment = vi.hoisted(() => vi.fn());
vi.mock("../context", () => ({ useApi: () => ({ saveAttachment }) }));

type Listener = (e: { data: unknown }) => void;

/** Host de WebView2 que contesta `pathOf(fichero)` como hace ruta_fichero.rs. */
function stubWebview(pathOf: (f: File) => string | null, opts: { silent?: boolean; throws?: boolean } = {}) {
  const listeners = new Set<Listener>();
  const host = {
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
    postMessageWithAdditionalObjects: (m: string, [f]: File[]) => {
      if (opts.silent) return;
      if (opts.throws) throw new TypeError("additional File object is not a file on the disk");
      const data = { ultronFilePath: m.replace("ultronFilePath:", ""), path: pathOf(f) };
      listeners.forEach((l) => l({ data }));
    },
  };
  vi.stubGlobal("chrome", { webview: host });
  return { listeners };
}

function bigFile(name: string, size: number): File {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

async function addFiles(files: File[]) {
  const { result } = renderHook(() => useAttachments());
  await act(async () => {
    await result.current.add(files);
  });
  return result.current;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  saveAttachment.mockReset();
});

describe("isReadable", () => {
  it("lee imágenes, PDF y texto dentro de sus topes", () => {
    expect(isReadable("a.PNG", 1024)).toBe(true);
    expect(isReadable("a.pdf", MAX_BYTES)).toBe(true);
    expect(isReadable("a.log", 256 * 1024)).toBe(true);
  });

  it("no cita lo demás ni lo que supera el tope (caso negativo)", () => {
    expect(isReadable("a.zip", 10)).toBe(false);
    expect(isReadable("modelo.uasset", 10)).toBe(false);
    expect(isReadable("sin_extension", 10)).toBe(false);
    expect(isReadable("a.svg", 10)).toBe(false);
    expect(isReadable("a.log", 256 * 1024 + 1)).toBe(false);
    expect(isReadable("a.png", MAX_BYTES + 1)).toBe(false);
  });

  it("las listas coinciden con las del backend", () => {
    const backendText = /const TEXT_EXT: &\[&str\] = &\[([^\]]+)\]/.exec(source)?.[1] ?? "";
    expect([...backendText.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual(TEXT_EXT);
    const backendImage = /const IMAGE_EXT: [^=]+= &\[([\s\S]+?)\];/.exec(source)?.[1] ?? "";
    expect([...backendImage.matchAll(/\("(\w+)"/g)].map((m) => m[1])).toEqual(IMAGE_EXT);
  });
});

describe("outgoingPayload", () => {
  const readable: Attachment = { path: "C:/a/foto.png", previewDataUrl: null, name: "foto.png", mediaType: "image/png" };
  const route: Attachment = { path: "D:\\v\\clip.mp4", previewDataUrl: null, name: "clip.mp4", mediaType: "video/mp4", isPathOnly: true };

  it("menciona lo legible y añade al texto la ruta del resto", () => {
    expect(outgoingPayload("mira", [readable, route])).toEqual({
      text: 'mira\n\nFichero adjunto (solo ruta): "D:\\v\\clip.mp4"',
      attachments: ["C:/a/foto.png"],
    });
  });

  it("sin texto queda solo la ruta y sin rutas no cambia el texto", () => {
    expect(outgoingPayload("", [route]).text).toBe('Fichero adjunto (solo ruta): "D:\\v\\clip.mp4"');
    expect(outgoingPayload("mira", [readable]).text).toBe("mira");
  });

  it("la pestaña Adjuntos encuentra la ruta en el transcript", () => {
    const { text } = outgoingPayload("mira", [route]);
    const { input } = collectAttachments([{ uuid: "u", role: "user", timestamp: "", blocks: [{ kind: "text", text }], agentId: null }]);
    expect(input.map((i) => i.name)).toEqual(["clip.mp4"]);
  });
});

describe("localFilePath", () => {
  it("devuelve la ruta del host y deja de escuchar", async () => {
    const { listeners } = stubWebview(() => "D:\\v\\clip.mp4");
    await expect(localFilePath(new File(["x"], "clip.mp4"))).resolves.toBe("D:\\v\\clip.mp4");
    expect(listeners.size).toBe(0);
  });

  it("devuelve null fuera de WebView2, sin ruta o si el host no contesta (casos negativos)", async () => {
    await expect(localFilePath(new File(["x"], "a.zip"))).resolves.toBeNull();
    stubWebview(() => null);
    await expect(localFilePath(new File(["x"], "a.zip"))).resolves.toBeNull();
    const thrower = stubWebview(() => "x", { throws: true });
    await expect(localFilePath(new File(["x"], "a.zip"))).resolves.toBeNull();
    expect(thrower.listeners.size).toBe(0);
    vi.useFakeTimers();
    const { listeners } = stubWebview(() => "x", { silent: true });
    const pending = localFilePath(new File(["x"], "a.zip"));
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toBeNull();
    expect(listeners.size).toBe(0);
  });
});

describe("useAttachments", () => {
  it("de un binario guarda la ruta original sin copiarlo, sea cual sea su tamaño", async () => {
    stubWebview(() => "D:\\v\\clip.mp4");
    const att = await addFiles([bigFile("clip.mp4", 3 * 1024 ** 3)]);
    expect(saveAttachment).not.toHaveBeenCalled();
    expect(att.error).toBeNull();
    expect(att.items).toEqual([{ path: "D:\\v\\clip.mp4", previewDataUrl: null, name: "clip.mp4", mediaType: "application/octet-stream", isPathOnly: true }]);
  });

  it("el mismo fichero dos veces solo se adjunta una", async () => {
    stubWebview(() => "D:\\a.zip");
    const att = await addFiles([new File(["x"], "a.zip"), new File(["x"], "a.zip")]);
    expect(att.items).toHaveLength(1);
  });

  it("lo legible se copia aunque haya ruta y no lleva la marca", async () => {
    const paths = vi.fn(() => "D:\\foto.png");
    stubWebview(paths);
    saveAttachment.mockResolvedValue({ path: "C:/adj/foto.png", previewDataUrl: "data:x" });
    const att = await addFiles([new File(["x"], "foto.png", { type: "image/png" })]);
    expect(paths).not.toHaveBeenCalled();
    expect(att.items[0]).toMatchObject({ path: "C:/adj/foto.png", name: "foto.png" });
    expect(att.items[0].isPathOnly).toBeUndefined();
  });

  it("sin ruta copia el binario pequeño y sigue yendo sin mención", async () => {
    saveAttachment.mockResolvedValue({ path: "C:/adj/a.zip", previewDataUrl: null });
    const att = await addFiles([new File(["x"], "a.zip")]);
    expect(saveAttachment).toHaveBeenCalledOnce();
    expect(att.items[0]).toMatchObject({ path: "C:/adj/a.zip", isPathOnly: true });
  });

  it("sin ruta y con más de 20 MB lo dice y no adjunta nada (caso negativo)", async () => {
    const att = await addFiles([bigFile("clip.mp4", MAX_BYTES + 1)]);
    expect(saveAttachment).not.toHaveBeenCalled();
    expect(att.items).toEqual([]);
    expect(att.error).toContain("supera los 20 MB");
  });
});
