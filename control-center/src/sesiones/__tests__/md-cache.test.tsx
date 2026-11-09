import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Markdown, mdCache, renderMarkdown } from "../components/chat/Markdown";
import { LruCache } from "../components/chat/md-cache";
import { DIAGRAM_SETTLE_MS, Diagram, svgCache } from "../components/chat/md-diagrams";
import { ApiContext } from "../context";

const mermaidRender = vi.hoisted(() => vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>' })));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: mermaidRender } }));

describe("LruCache", () => {
  it("expulsa lo menos usado por número de entradas y por peso", () => {
    const c = new LruCache<string>(2, 10, (_k, v) => v.length);
    c.set("a", "xx");
    c.set("b", "yy");
    c.get("a");
    c.set("c", "zz");
    expect([c.get("a"), c.get("b"), c.get("c")]).toEqual(["xx", undefined, "zz"]);
    c.set("d", "123456789");
    expect(c.weight).toBeLessThanOrEqual(10);
    expect(c.get("d")).toBe("123456789");
  });

  it("un valor más pesado que el tope no entra ni vacía la caché (caso negativo)", () => {
    const c = new LruCache<string>(5, 4, (_k, v) => v.length);
    c.set("a", "ab");
    c.set("big", "abcdef");
    expect(c.get("big")).toBeUndefined();
    expect(c.get("a")).toBe("ab");
  });
});

describe("caché del Markdown", () => {
  it("el mismo texto reutiliza el árbol procesado al volver a montarse", () => {
    const text = "Texto con **negrita** y $x^2$ único-1";
    const first = render(<Markdown text={text} />);
    const tree = mdCache.get(text);
    expect(tree).toBeDefined();
    first.unmount();
    render(<Markdown text={text} />);
    expect(renderMarkdown(text)).toBe(tree);
    expect(screen.getByText("negrita")).toBeTruthy();
  });

  it("el texto en streaming no se guarda (caso negativo)", () => {
    const before = mdCache.size;
    const a = renderMarkdown("en vivo único-2", true);
    const b = renderMarkdown("en vivo único-2", true);
    expect(a).not.toBe(b);
    expect(mdCache.size).toBe(before);
    expect(mdCache.get("en vivo único-2")).toBeUndefined();
  });
});

describe("caché de diagramas", () => {
  const api = {} as SesionesApi;
  const diagram = (code: string) => <ApiContext.Provider value={api}><Diagram kind="mermaid" code={code} /></ApiContext.Provider>;

  it("al volver a montarse sale dibujado al momento, sin volver a llamar a mermaid", async () => {
    mermaidRender.mockClear();
    const first = render(diagram("graph TD; A-->B"));
    await waitFor(() => expect(first.container.querySelector(".diagram-body svg")).not.toBeNull());
    expect(mermaidRender).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = render(diagram("graph TD; A-->B"));
    expect(second.container.querySelector(".diagram-body svg")).not.toBeNull();
    expect(second.container.textContent).not.toContain("Dibujando");
    expect(mermaidRender).toHaveBeenCalledTimes(1);
    expect(svgCache.size).toBeGreaterThan(0);
  });

  it("un código distinto sí se dibuja de nuevo (caso negativo)", async () => {
    mermaidRender.mockClear();
    const view = render(diagram("graph TD; X-->Y"));
    expect(view.container.textContent).toContain("Dibujando");
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(1));
  });

  it("en streaming no redibuja cada delta: espera a que el código se asiente", async () => {
    mermaidRender.mockClear();
    const view = render(diagram("graph TD; S1"));
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(1));
    view.rerender(diagram("graph TD; S1-->"));
    view.rerender(diagram("graph TD; S1-->S2"));
    await new Promise((r) => window.setTimeout(r, DIAGRAM_SETTLE_MS / 4));
    // Caso negativo: los deltas intermedios no llegan a mermaid.
    expect(mermaidRender).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(2), { timeout: DIAGRAM_SETTLE_MS * 3 });
  });
});
