// Contenido hostil o accidental en el Markdown del chat, siempre a través de
// `<Markdown>`: rutas de red que no deben salir del front, URL con `%` inválido,
// `data-callout` con nombres del prototipo y `$` que no son fórmulas.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { createTauriApi } from "../api-tauri";
import { ChatScopeContext } from "../components/chat/ChatContext";
import { Markdown, MarkdownBlocks } from "../components/chat/Markdown";
import { isAbsolutePath, parsePathRef } from "../components/chat/md-plugins";
import { isNetworkPath } from "../components/inspector/rutas-sesion";
import { ApiContext } from "../context";
import { createMockApi } from "../mock/api-mock";
import { store } from "../store";
import type { SessionInfo } from "../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._args: unknown[]) => Promise.resolve("data:image/png;base64,AA==")) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

afterEach(cleanup);

function fakeApi() {
  return {
    isMock: true,
    readImage: vi.fn(async () => "data:image/png;base64,AA=="),
    openInEditor: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
  };
}

function renderMd(text: string, opts: { live?: boolean; sessionId?: string } = {}) {
  const api = fakeApi();
  const scope = opts.sessionId ? { sessionId: opts.sessionId, readOnly: false } : null;
  const view = render(
    <ApiContext.Provider value={api as unknown as SesionesApi}>
      <ChatScopeContext.Provider value={scope}>
        <Markdown text={text} live={opts.live} />
      </ChatScopeContext.Provider>
    </ApiContext.Provider>,
  );
  return { ...view, api };
}

function withSession(id: string, cwd: string): string {
  const info = { id, title: id, projectId: "p", projectName: "p", cwd, status: "idle" } as unknown as SessionInfo;
  store.dispatch({ type: "sessions", sessions: [info] });
  return id;
}

// Markdown consume un nivel de barra invertida: para que la URL lleve dos hay que escribir cuatro.
const UNC_IMAGES = [
  "![](//evil.example/s/x.png)",
  "![](\\\\\\\\evil.example\\\\s\\\\x.png)",
  "![](%5C%5Cevil.example%5Cs%5Cx.png)",
  "![](/\\\\evil.example/s/x.png)",
  "![](\\\\/evil.example/s/x.png)",
  "![](//?/UNC/evil.example/s/x.png)",
  "![](\\\\\\\\?\\\\UNC\\\\evil.example\\\\s\\\\x.png)",
  "![](/??/UNC/evil.example/s/x.png)",
];

describe("rutas de red: no salen del front", () => {
  it("clasifica UNC, dispositivo y NT, y no confunde rutas locales (caso negativo)", () => {
    for (const p of ["//h/s/x.png", "\\\\h\\s\\x.png", "/\\h/s", "\\/h/s", " //h/s", "\\\\?\\UNC\\h\\s", "//./c:/x", "\\??\\UNC\\h\\s", "/??/UNC/h/s"]) {
      expect(isNetworkPath(p), p).toBe(true);
      expect(isAbsolutePath(p), p).toBe(false);
    }
    for (const p of ["C:/a/b.png", "C:\\a\\b.png", "/c/Users/a.png", "/tmp/a.png", "a/b.png", "./a.png", "~/a.png"]) {
      expect(isNetworkPath(p), p).toBe(false);
    }
    expect(isAbsolutePath("C:/a/b.png")).toBe(true);
    expect(isAbsolutePath("/tmp/a.png")).toBe(true);
    expect(isAbsolutePath("~/a.png")).toBe(true);
    expect(isAbsolutePath("a/b.png")).toBe(false);
  });

  it.each(UNC_IMAGES)("%s no llama a readImage y lo explica, con y sin cwd", (md) => {
    const sinCwd = renderMd(md);
    expect(sinCwd.api.readImage).not.toHaveBeenCalled();
    expect(sinCwd.container.querySelector(".img-miss")?.getAttribute("title")).toContain("red");
    cleanup();
    const conCwd = renderMd(md, { sessionId: withSession("con-cwd", "C:\\proy") });
    expect(conCwd.api.readImage).not.toHaveBeenCalled();
    expect(conCwd.container.querySelector(".img-miss")?.getAttribute("title")).toContain("red");
  });

  it("una imagen relativa con cwd de red tampoco se pide", () => {
    const { api, container } = renderMd("![](a.png)", { sessionId: withSession("cwd-red", "\\\\nas\\proy") });
    expect(api.readImage).not.toHaveBeenCalled();
    expect(container.querySelector(".img-miss")?.getAttribute("title")).toContain("red");
  });

  it("caso negativo: una imagen local sigue llegando a readImage", async () => {
    const { api } = renderMd("![](C:/x/a.png) y ![](b.png)", { sessionId: withSession("local", "C:\\proy") });
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    expect(api.readImage).toHaveBeenCalledWith("C:/x/a.png");
    expect(api.readImage).toHaveBeenCalledWith("C:\\proy\\b.png");
  });

  it("el código en línea no toma una ruta de red por una cita", () => {
    expect(parsePathRef("//evil.example/s/x.png")).toBeNull();
    expect(parsePathRef("\\\\evil.example\\s\\x.png")).toBeNull();
    const { api } = renderMd("`//evil.example/s/x.png` y `\\\\evil.example\\s\\x.png`");
    expect(api.readImage).not.toHaveBeenCalled();
  });

  it("un enlace a una ruta de red no se abre y lo dice", () => {
    const { api } = renderMd("[a](//evil.example/s/x.md)");
    fireEvent.click(screen.getByRole("link", { name: "a" }));
    expect(api.openInEditor).not.toHaveBeenCalled();
    expect(api.openFile).not.toHaveBeenCalled();
  });

  it("los adaptadores rechazan la ruta sin invocar el comando; una local sí pasa", async () => {
    invoke.mockClear();
    const real = createTauriApi();
    await expect(real.readImage("//evil.example/s/x.png")).rejects.toThrow(/red/);
    await expect(real.readImage("\\\\evil.example\\s\\x.png")).rejects.toThrow(/red/);
    expect(invoke).not.toHaveBeenCalled();
    await real.readImage("C:/x/a.png");
    expect(invoke).toHaveBeenCalledWith("sesiones_read_image", { path: "C:/x/a.png" });
    await expect(createMockApi({ autoplay: false }).readImage("//evil.example/s/x.png")).rejects.toThrow(/red/);
  });
});

describe("URL con % inválido: no derriban el render", () => {
  const LINKS = ["https://x.com/50%off", "https://x.com/caf%E9", "<https://x.com/%E9>", "https://es.wikipedia.org/wiki/Espa%C3"];

  it.each(LINKS)("%s sale como enlace con la ruta en crudo", (md) => {
    const { container } = renderMd(md);
    const card = container.querySelector("a.linkcard");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".lc-path")?.textContent).toMatch(/%/);
  });

  it("streaming: la cola con %C3 no rompe y al completarse %C3%B1 se decodifica", () => {
    const api = fakeApi();
    const wrap = (text: string) => (
      <ApiContext.Provider value={api as unknown as SesionesApi}><Markdown text={text} live /></ApiContext.Provider>
    );
    const view = render(wrap("Mira https://es.wikipedia.org/wiki/Espa%C3"));
    expect(view.container.querySelector(".lc-path")?.textContent).toBe("/wiki/Espa%C3");
    view.rerender(wrap("Mira https://es.wikipedia.org/wiki/Espa%C3%B1a"));
    expect(view.container.querySelector(".lc-path")?.textContent).toBe("/wiki/España");
  });

  it("MarkdownBlocks aguanta el mismo texto en un trozo cerrado", () => {
    const api = fakeApi();
    const { container } = render(
      <ApiContext.Provider value={api as unknown as SesionesApi}><MarkdownBlocks blocks={["https://x.com/caf%E9\n\n"]} /></ApiContext.Provider>,
    );
    expect(container.querySelector(".lc-path")?.textContent).toBe("/caf%E9");
  });

  it.each(["![x](a%ZZ.png)", "![x](a%E9.png)"])("%s llega a LocalThumb sin lanzar", async (md) => {
    const { api } = renderMd(md, { sessionId: withSession("img", "C:\\proy") });
    expect(await screen.findByRole("img")).not.toBeNull();
    expect(api.readImage).toHaveBeenCalledTimes(1);
  });
});

describe("nombres del prototipo como clave", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("data-callout=%s es una cita normal", (kind) => {
    const { container } = renderMd(`<blockquote data-callout="${kind}">hola</blockquote>`);
    expect(container.querySelector("blockquote")?.textContent).toBe("hola");
    expect(container.querySelector(".callout")).toBeNull();
  });

  it("caso negativo: un data-callout válido sigue siendo un callout", () => {
    const { container } = renderMd('<blockquote data-callout="tip">hola</blockquote>');
    expect(container.querySelector(".callout-tip")).not.toBeNull();
  });

  it("un bloque ```constructor es código y no un diagrama", () => {
    const { container } = renderMd("```constructor\nx\n```");
    expect(container.querySelector(".diagram")).toBeNull();
    expect(container.querySelector(".codeblock")).not.toBeNull();
  });
});

describe("$ que no es una fórmula", () => {
  it.each([
    ["Coste: 3,42 $ frente a 5,10 $ del plan.", "Coste: 3,42 $ frente a 5,10 $ del plan."],
    ["3,42\u00a0$ frente a 5,10\u00a0$", "3,42\u00a0$ frente a 5,10\u00a0$"],
    ["En bash usa $HOME y luego $PATH", "En bash usa $HOME y luego $PATH"],
    ["$env:HOME y $env:PATH", "$env:HOME y $env:PATH"],
    ["$HOME/$PATH", "$HOME/$PATH"],
    ["\"$HOME\":\"$PATH\"", "\"$HOME\":\"$PATH\""],
    ["De 10$ a 20$ al mes", "De 10$ a 20$ al mes"],
    ["De $10 a $20 al mes", "De $10 a $20 al mes"],
    ["Entre $10-$20", "Entre $10-$20"],
    ["US$5 y US$6", "US$5 y US$6"],
    ["Cuesta 5 $\ny otros 6 $", "Cuesta 5 $\ny otros 6 $"],
  ])("%s queda como texto", (md, text) => {
    const { container } = renderMd(md);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it.each([
    ["$a^2$"],
    ["El coste es $O(n \\log n)$."],
    ["($x$)"],
    ["$x$-axis"],
    ["Con $a$ y $b$ basta"],
    ["$a + b$"],
    ["$$x^2$$"],
    ["$$\nx^2\n$$"],
    ["$$ x^2 $$"],
  ])("caso negativo: %s sigue siendo una fórmula", (md) => {
    const { container } = renderMd(md);
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("un importe suelto no se come la fórmula que viene detrás", () => {
    const { container } = renderMd("Son 3,42 $ y la cota es $a^2$ al mes");
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.textContent).toContain("Son 3,42 $ y la cota es ");
    expect(container.textContent).toContain(" al mes");
  });

  it("\\$ escapado sigue siendo literal y el código en línea no se toca", () => {
    const { container } = renderMd("\\$a\\$ y `$a$`");
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe("$a$ y $a$");
  });
});

describe("enlaces a rutas locales", () => {
  it.each([
    ["[a](C:/x/y.md)", "C:/x/y.md"],
    ["[a](C:\\x\\y.md)", "C:\\x\\y.md"],
    ["[a](file:///C:/x/y.md)", "C:/x/y.md"],
    ["[a](</C:/x y/z.md>)", "C:/x y/z.md"],
  ])("%s abre el editor con la ruta limpia", (md, path) => {
    const { api } = renderMd(md);
    const link = screen.getByRole("link", { name: "a" });
    expect(link.getAttribute("href")).toBeTruthy();
    expect(link.getAttribute("target")).toBeNull();
    fireEvent.click(link);
    expect(api.openInEditor).toHaveBeenCalledWith(path, undefined, undefined);
  });

  it("un vídeo con ruta de Windows va a la app del sistema", () => {
    const { api } = renderMd("[v](C:/x/video.mp4)");
    fireEvent.click(screen.getByRole("link", { name: "v" }));
    expect(api.openFile).toHaveBeenCalledWith("C:/x/video.mp4", undefined);
    expect(api.openInEditor).not.toHaveBeenCalled();
  });

  it("con línea: C:/x/y.rs:40 la conserva", () => {
    const { api } = renderMd("[a](C:/x/y.rs:40)");
    fireEvent.click(screen.getByRole("link", { name: "a" }));
    expect(api.openInEditor).toHaveBeenCalledWith("C:/x/y.rs", 40, undefined);
  });

  it("un destino que el saneado borra no es un enlace muerto: se dice (caso negativo)", () => {
    const { container, api } = renderMd("[a](javascript:alert(1)) y [b](file://host/s/x.md)");
    expect(container.querySelector("a")).toBeNull();
    const dead = container.querySelectorAll(".link-blocked");
    expect(dead).toHaveLength(2);
    expect(dead[0].getAttribute("title")).toMatch(/no admitido/);
    fireEvent.click(dead[0]);
    expect(api.openInEditor).not.toHaveBeenCalled();
  });

  it("caso negativo: un enlace https sigue abriéndose fuera", () => {
    const { api } = renderMd("[a](https://example.com/x)");
    const link = screen.getByRole("link", { name: "a" });
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("href")).toBe("https://example.com/x");
    fireEvent.click(link);
    expect(api.openUrl).toHaveBeenCalledWith("https://example.com/x");
    expect(api.openInEditor).not.toHaveBeenCalled();
  });
});
