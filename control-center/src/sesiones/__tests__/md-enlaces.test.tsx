// Enlaces del Markdown: las anclas (notas al pie) se quedan en el hilo y las rutas
// abren el editor; solo lo que tiene esquema web sale al navegador. Caso negativo:
// un enlace http no se trata como fichero.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { MdLink, linkTarget } from "../components/chat/md-blocks";
import { ApiContext } from "../context";

afterEach(cleanup);

describe("linkTarget", () => {
  it("clasifica anclas, rutas con línea, rutas de Windows y file://", () => {
    expect(linkTarget("#user-content-fn-1")).toEqual({ kind: "anchor", id: "user-content-fn-1" });
    expect(linkTarget("src/app.ts#L12")).toEqual({ kind: "file", path: "src/app.ts", line: 12 });
    expect(linkTarget("./docs/guia%20rapida.md")).toEqual({ kind: "file", path: "./docs/guia rapida.md", line: undefined });
    expect(linkTarget("C:/proyecto/main.rs:40")).toEqual({ kind: "file", path: "C:/proyecto/main.rs", line: 40 });
    expect(linkTarget("file:///C:/p/a.md")).toEqual({ kind: "file", path: "C:/p/a.md" });
    expect(linkTarget("docs/README.md#instalar")).toEqual({ kind: "file", path: "docs/README.md", line: undefined });
  });

  it("caso negativo: http, https y mailto siguen siendo externos; un % suelto no rompe", () => {
    expect(linkTarget("https://example.com/a")).toEqual({ kind: "external" });
    expect(linkTarget("mailto:x@example.com")).toEqual({ kind: "external" });
    expect(linkTarget("notas%zz.md")).toMatchObject({ kind: "file", path: "notas%zz.md" });
  });
});

describe("MdLink", () => {
  function mount(href: string, openInEditor = vi.fn(async () => undefined), openUrl = vi.fn(async () => undefined)) {
    const api = { isMock: true, openInEditor, openUrl } as unknown as SesionesApi;
    render(
      <ApiContext.Provider value={api}>
        <div className="md">
          <MdLink href={href}>enlace</MdLink>
          <p id="user-content-fn-1">nota</p>
        </div>
      </ApiContext.Provider>,
    );
    return openInEditor;
  }

  it("una ruta relativa abre el editor y no navega", () => {
    const open = mount("src/app.ts#L3");
    const a = screen.getByRole("link", { name: "enlace" });
    expect(a.getAttribute("target")).toBeNull();
    fireEvent.click(a);
    expect(open).toHaveBeenCalledWith("src/app.ts", 3, undefined);
  });

  it("una nota al pie desplaza a su destino dentro del mensaje", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    mount("#user-content-fn-1");
    fireEvent.click(screen.getByRole("link", { name: "enlace" }));
    expect(scroll).toHaveBeenCalled();
  });

  it("caso negativo: un enlace https abre el navegador del sistema y no llama al editor", () => {
    const openUrl = vi.fn(async () => undefined);
    const open = mount("https://example.com/docs", undefined, openUrl);
    const a = screen.getByRole("link", { name: "enlace" });
    // Con target=_blank la webview de Tauri rechaza el clic (ACL): no debe llevarlo.
    expect(a.getAttribute("target")).toBeNull();
    expect(a.getAttribute("href")).toBe("https://example.com/docs");
    fireEvent.click(a);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
    expect(open).not.toHaveBeenCalled();
  });

  it("un enlace desnudo (tarjeta de enlace) también abre el navegador", () => {
    const openUrl = vi.fn(async () => undefined);
    const api = { isMock: true, openInEditor: vi.fn(), openUrl } as unknown as SesionesApi;
    const { container } = render(
      <ApiContext.Provider value={api}>
        <MdLink href="https://example.com/a">https://example.com/a</MdLink>
      </ApiContext.Provider>,
    );
    const card = container.querySelector("a.linkcard") as HTMLAnchorElement;
    expect(card.getAttribute("target")).toBeNull();
    fireEvent.click(card);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
  });

  it("caso negativo: un esquema no web no se manda al navegador", () => {
    const openUrl = vi.fn(async () => undefined);
    mount("javascript:alert(1)", undefined, openUrl);
    fireEvent.click(screen.getByRole("link", { name: "enlace" }));
    expect(openUrl).not.toHaveBeenCalled();
  });
});
