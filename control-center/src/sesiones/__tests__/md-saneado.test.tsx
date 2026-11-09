// Tabla de vectores contra el saneado real: HTML en bruto a través de `<Markdown>`,
// SVG de diagramas a través de `cleanSvg` y atributos `sandbox` de las vistas previas.
// Protege de una actualización de `dompurify`, `rehype-sanitize` o `mermaid`.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Markdown } from "../components/chat/Markdown";
import { cleanSvg } from "../components/chat/md-diagrams";
import { ApiContext } from "../context";

afterEach(cleanup);

function renderMd(text: string, api: Partial<SesionesApi> = {}) {
  const full = { isMock: true, readImage: vi.fn(async () => "data:image/png;base64,AA=="), openInEditor: vi.fn(async () => undefined), ...api } as unknown as SesionesApi;
  return render(<ApiContext.Provider value={full}><Markdown text={text} /></ApiContext.Provider>);
}

const EVENT_ATTR = /^on/i;

function hasEventHandler(root: Element): boolean {
  return [...root.querySelectorAll("*")].some((el) => [...el.attributes].some((a) => EVENT_ATTR.test(a.name)));
}

describe("HTML en bruto a través de <Markdown>", () => {
  it.each([
    ["<script>", "<script>alert(1)</script>", "script"],
    ["<iframe>", '<iframe src="https://evil.example"></iframe>', "iframe"],
    ["<object>", '<object data="https://evil.example"></object>', "object"],
    ["<embed>", '<embed src="https://evil.example">', "embed"],
    ["<style>", "<style>body{display:none}</style>", "style"],
    ["<link>", '<link rel="stylesheet" href="https://evil.example/x.css">', "link"],
    ["<meta>", '<meta http-equiv="refresh" content="0;url=https://evil.example">', "meta"],
    ["<base>", '<base href="https://evil.example/">', "base"],
    ["<svg>", '<svg onload="alert(1)"><circle r="1"/></svg>', "svg"],
    ["<math>", '<math><mtext>x</mtext></math>', "math"],
  ])("%s no llega al DOM", (_name, html, tag) => {
    const { container } = renderMd(`${html}\n\nsigue`);
    expect(container.querySelector(tag)).toBeNull();
    expect(container.textContent).toContain("sigue");
  });

  it.each([
    ['<img src="x.png" onerror="alert(1)">'],
    ['<b onclick="alert(1)">b</b>'],
    ['<details ontoggle="alert(1)" open>d</details>'],
    ['<a href="https://x.com" onmouseover="alert(1)">a</a>'],
  ])("%s pierde el manejador", (html) => {
    const { container } = renderMd(html);
    expect(hasEventHandler(container)).toBe(false);
  });

  it.each([
    ["[a](javascript:alert(1))"],
    ["[a](JaVaScRiPt:alert(1))"],
    ["[a](data:text/html,<script>alert(1)</script>)"],
    ["[a](vbscript:msgbox(1))"],
    ['<a href="javascript:alert(1)">a</a>'],
    ['<a href="data:text/html;base64,AA==">a</a>'],
  ])("%s no deja un destino peligroso", (md) => {
    const { container } = renderMd(md);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.filter((h) => /^(javascript|data|vbscript):/i.test(h))).toEqual([]);
  });

  it("las imágenes con protocolo peligroso no llaman al backend", () => {
    const readImage = vi.fn(async () => "");
    const { container } = renderMd('![x](javascript:alert(1))\n\n<img src="vbscript:x">', { readImage } as Partial<SesionesApi>);
    expect(readImage).not.toHaveBeenCalled();
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
    expect(srcs.filter((s) => /^(javascript|vbscript):/i.test(s))).toEqual([]);
  });

  it("id y name no pueden pisar los del documento", () => {
    const { container } = renderMd('<p id="root" name="root">x</p>');
    expect(container.querySelector("#root")).toBeNull();
  });

  it("caso negativo: <details>, <kbd> y <mark> se conservan", () => {
    const { container } = renderMd("<details><summary>s</summary>d</details>\n\n<kbd>K</kbd> <mark>m</mark>");
    expect(container.querySelector("details summary")?.textContent).toBe("s");
    expect(container.querySelector("kbd")?.textContent).toBe("K");
    expect(container.querySelector("mark")?.textContent).toBe("m");
  });
});

describe("cleanSvg", () => {
  const parse = (svg: string) => {
    const host = document.createElement("div");
    host.innerHTML = cleanSvg(svg);
    return host;
  };

  it.each([
    ["script", "<svg><script>alert(1)</script></svg>"],
    ["foreignObject", "<svg><foreignObject><div>x</div></foreignObject></svg>"],
    ["iframe", '<svg><iframe src="https://evil.example"></iframe></svg>'],
    ["use", '<svg><use href="https://evil.example/x.svg#a"/></svg>'],
    ["animate", '<svg><a><animate attributeName="href" to="javascript:alert(1)"/></a></svg>'],
    ["set", '<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>'],
  ])("quita <%s>", (tag, svg) => {
    expect(parse(svg).querySelector(tag)).toBeNull();
  });

  it("quita los manejadores", () => {
    expect(hasEventHandler(parse('<svg onload="alert(1)"><circle r="1" onclick="alert(1)"/></svg>'))).toBe(false);
  });

  it.each([
    ["https", '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://evil.example/"><text>x</text></a></svg>'],
    ["https sin xlink", '<svg><a href="https://evil.example/"><text>x</text></a></svg>'],
    ["javascript", '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'],
    ["file", '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="file:///C:/x"><text>x</text></a></svg>'],
  ])("un enlace %s queda sin destino y conserva su texto", (_name, svg) => {
    const host = parse(svg);
    const a = host.querySelector("a");
    expect(a?.getAttribute("href") ?? null).toBeNull();
    expect(a?.getAttribute("xlink:href") ?? null).toBeNull();
    expect(host.innerHTML).not.toMatch(/evil\.example|javascript:|file:/);
    expect(host.textContent).toContain("x");
  });

  it("caso negativo: las formas, y las referencias internas de un degradado, sobreviven", () => {
    const host = parse('<svg><defs><linearGradient id="a"/><linearGradient id="b" href="#a"/></defs><rect fill="url(#b)" width="1" height="1"/></svg>');
    expect(host.querySelector("rect")?.getAttribute("fill")).toBe("url(#b)");
    expect(host.querySelector("#b")?.getAttribute("href")).toBe("#a");
  });
});

describe("aislamiento de las vistas previas", () => {
  const HTML = "```html\n<script>alert(1)</script>\n```";

  it("«Vista previa» no ejecuta nada: sandbox vacío", () => {
    renderMd(HTML);
    fireEvent.click(screen.getByRole("button", { name: "Vista previa" }));
    expect(screen.getByTitle("Vista previa html").getAttribute("sandbox")).toBe("");
  });

  it("«Interactivo» ejecuta scripts, pero sin allow-same-origin y solo tras el clic", async () => {
    const previewPut = vi.fn(async () => "preview://x/1");
    renderMd(HTML, { previewPut } as Partial<SesionesApi>);
    expect(previewPut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Interactivo" }));
    const frame = await screen.findByTitle("Vista interactiva html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("preview://x/1");
  });
});
