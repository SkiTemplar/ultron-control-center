// `moveCaretToEnd` enfoca el textarea en el fotograma siguiente. Si entre tanto se ha
// abierto la búsqueda del historial (Ctrl+R justo tras ↑/↓), le robaba el foco y lo
// escrito para buscar acababa en el borrador, y Enter lo enviaba a la cola.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveCaretToEnd } from "../components/composer/useComposerState";

describe("moveCaretToEnd y el foco", () => {
  let box: HTMLTextAreaElement;

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queueMicrotask(() => cb(0));
      return 0;
    });
    box = document.createElement("textarea");
    box.value = "borrador";
    document.body.append(box);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("no quita el foco a un diálogo abierto mientras tanto, pero sí coloca el cursor", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const search = document.createElement("input");
    dialog.append(search);
    box.focus();
    moveCaretToEnd(box, box.value);
    document.body.append(dialog);
    search.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(search);
    expect(box.selectionStart).toBe(box.value.length);
  });

  it("caso negativo: sin diálogo, enfoca el textarea", async () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    moveCaretToEnd(box, box.value);
    await Promise.resolve();
    expect(document.activeElement).toBe(box);
  });
});
