// Inventario de adjuntos en Entrada/Salida (motores-ventanas:F7) y arrastrar
// y soltar ficheros en toda la ventana (F3).

import { describe, expect, it, vi } from "vitest";
import { baseName, collectAttachments } from "../components/inspector/adjuntos-collect";
import { attachWindowFileDrop, hasFiles } from "../drop";
import type { ChatMessage } from "../types";

function msg(uuid: string, role: ChatMessage["role"], blocks: ChatMessage["blocks"]): ChatMessage {
  return { uuid, role, timestamp: "2026-10-08T10:00:00Z", blocks, agentId: null };
}

describe("collectAttachments", () => {
  it("separa lo del usuario de lo que enseña o escribe Claude", () => {
    const messages = [
      msg("u1", "user", [
        { kind: "text", text: 'mira esto @"C:\\Users\\yo\\.ultron\\adjuntos\\2026-10-08\\abc-captura.png" y @"C:\\p\\informe.pdf"' },
        { kind: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,AA" },
      ]),
      msg("a1", "assistant", [
        { kind: "toolUse", id: "t1", name: "Write", input: { file_path: "C:\\p\\out\\grafica.png" }, summary: "" },
        { kind: "toolUse", id: "t2", name: "Write", input: { file_path: "C:\\p\\src\\main.rs" }, summary: "" },
        { kind: "text", text: "La he guardado en C:\\p\\out\\grafica.png y en /tmp/otra.jpg; la web es https://x.example/logo.png." },
      ]),
      msg("u2", "user", [{ kind: "toolResult", toolUseId: "t3", isError: false, text: "", images: ["data:image/png;base64,BB"] }]),
    ];
    const { input, output } = collectAttachments(messages);
    expect(input.map((i) => i.name)).toEqual(["abc-captura.png", "informe.pdf", "imagen"]);
    expect(input[1].isImage).toBe(false);
    // Salida: todo lo escrito (no solo imágenes) y lo citado, sin la URL.
    expect(output.map((i) => i.name)).toEqual(["grafica.png", "main.rs", "otra.jpg", "resultado 1"]);
    expect(output.map((i) => i.isImage)).toEqual([true, false, true, true]);
    expect(output.map((i) => i.isSpeculative)).toEqual([false, false, true, false]);
  });

  it("los adjuntos enviados desde la ventana no se duplican con su mención", () => {
    const path = "C:\\a\\b.png";
    const { input } = collectAttachments([msg("u", "user", [{ kind: "text", text: `@"${path}"` }])], [{ path, previewDataUrl: "data:x" }]);
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ name: "b.png", src: "data:x" });
  });

  it("nombre con separadores de Windows y sin imágenes, listas vacías (caso negativo)", () => {
    expect(baseName("C:\\a\\b.png")).toBe("b.png");
    expect(baseName("/x/y.txt")).toBe("y.txt");
    expect(collectAttachments([msg("u", "user", [{ kind: "text", text: "hola" }]), msg("a", "assistant", [{ kind: "text", text: "nada" }])]))
      .toEqual({ input: [], output: [] });
  });
});

/** Evento de arrastre sintético con `dataTransfer` (jsdom no trae DragEvent completo). */
function dragEvent(type: string, types: string[], files: File[] = [], target?: EventTarget): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types, files, dropEffect: "none" } });
  if (target) Object.defineProperty(e, "target", { value: target });
  return e;
}

describe("attachWindowFileDrop", () => {
  function setup() {
    const win = new EventTarget() as unknown as Window;
    const onFiles = vi.fn();
    const onActive = vi.fn();
    const onNoSession = vi.fn();
    const off = attachWindowFileDrop(win, { sessionFor: () => "s1", onFiles, onActive, onNoSession });
    return { win, onFiles, onActive, onNoSession, off };
  }

  it("soltar ficheros los manda a la sesión, evita la navegación y apaga la superposición", () => {
    const { win, onFiles, onActive } = setup();
    const file = new File(["x"], "a.png", { type: "image/png" });
    const enter = dragEvent("dragenter", ["Files"]);
    win.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(onActive).toHaveBeenLastCalledWith(true);
    const over = dragEvent("dragover", ["Files"]);
    win.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const drop = dragEvent("drop", ["Files"], [file]);
    win.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledWith("s1", [file]);
    expect(onActive).toHaveBeenLastCalledWith(false);
  });

  it("soltar texto no adjunta ni intercepta nada (caso negativo)", () => {
    const { win, onFiles, onActive } = setup();
    const over = dragEvent("dragover", ["text/plain"]);
    win.dispatchEvent(over);
    const drop = dragEvent("drop", ["text/plain"]);
    win.dispatchEvent(drop);
    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
    expect(onActive).not.toHaveBeenCalled();
  });

  it("si una zona propia ya atendió el drop no se adjunta dos veces", () => {
    const { win, onFiles } = setup();
    const drop = dragEvent("drop", ["Files"], [new File(["x"], "a.txt")]);
    drop.preventDefault();
    win.dispatchEvent(drop);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("hasFiles mira solo el tipo Files", () => {
    expect(hasFiles({ types: ["Files"] })).toBe(true);
    expect(hasFiles({ types: ["application/x-ultron-sesion"] })).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });
});
