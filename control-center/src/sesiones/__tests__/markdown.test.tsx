import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Markdown } from "../components/chat/Markdown";
import { cellNumber, codeFileName, compareCells, diffKind, parsePathRef } from "../components/chat/md-plugins";
import { ApiContext } from "../context";

function renderMd(text: string, api: Partial<SesionesApi> = {}) {
  const full = { readImage: vi.fn().mockResolvedValue("data:image/png;base64,AA=="), openInEditor: vi.fn().mockResolvedValue(undefined), ...api } as unknown as SesionesApi;
  const view = render(
    <ApiContext.Provider value={full}>
      <Markdown text={text} />
    </ApiContext.Provider>,
  );
  return { ...view, api: full };
}

describe("imágenes locales en Markdown", () => {
  it("una ruta absoluta de Windows sobrevive al saneado y se pide al backend", async () => {
    const { api } = renderMd("![cap](C:/Users/R/cap.png) y ![otra](D:\\fotos\\b.jpg)");
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    expect(api.readImage).toHaveBeenCalledWith("C:/Users/R/cap.png");
    expect(api.readImage).toHaveBeenCalledWith("D:\\fotos\\b.jpg");
  });

  it("una URL con protocolo no admitido sigue saneada (caso negativo)", () => {
    const { container, api } = renderMd("![x](javascript:alert(1))");
    expect(api.readImage).not.toHaveBeenCalled();
    expect(container.querySelector("img")?.getAttribute("src") ?? "").not.toContain("javascript");
  });
});

describe("utilidades del Markdown", () => {
  it("reconoce rutas con línea y descarta lo que no lo es (caso negativo)", () => {
    expect(parsePathRef("src/sesiones/timeline.ts:42")).toEqual({ path: "src/sesiones/timeline.ts", line: 42, isImage: false });
    expect(parsePathRef("C:\\Users\\R\\captura.png")).toMatchObject({ isImage: true });
    expect(parsePathRef("Cargo.toml")).toMatchObject({ path: "Cargo.toml" });
    expect(parsePathRef("npm run build")).toBeNull();
    expect(parsePathRef("https://x.com/a.ts")).toBeNull();
    expect(parsePathRef("v1.2")).toBeNull();
  });

  it("lee números en formato español y ordena numérico o por texto", () => {
    expect(cellNumber("1.234,5")).toBe(1234.5);
    expect(cellNumber("12 %")).toBe(12);
    expect(cellNumber("3,42 $")).toBe(3.42);
    expect(cellNumber("-7")).toBe(-7);
    expect(cellNumber("abc")).toBeNull();
    expect(compareCells("9", "10")).toBeLessThan(0);
    expect(compareCells("b", "a")).toBeGreaterThan(0);
  });

  it("saca el fichero del meta y clasifica líneas de diff", () => {
    expect(codeFileName("src/a.ts")).toBe("src/a.ts");
    expect(codeFileName('title="b.rs"')).toBe("b.rs");
    expect(codeFileName("{1,3}")).toBeNull();
    expect(["+a", "-b", "@@ x", "+++ f", " c"].map(diffKind)).toEqual(["add", "del", "hunk", "ctx", "ctx"]);
  });
});

describe("Markdown del chat", () => {
  it("pinta callouts con su título y sin el marcador", () => {
    const { container } = renderMd("> [!WARNING]\n> Cuidado con el binario viejo");
    const callout = container.querySelector(".callout-warning");
    expect(callout?.textContent).toContain("Atención");
    expect(callout?.textContent).toContain("Cuidado con el binario viejo");
    expect(callout?.textContent).not.toContain("[!WARNING]");
  });

  it("sanea el HTML en bruto: <details> sí, <script> y onclick no (caso negativo)", () => {
    const { container } = renderMd('<details><summary>Más</summary>dentro</details>\n\n<script>alert(1)</script><b onclick="x()">b</b>');
    expect(container.querySelector("details summary")?.textContent).toBe("Más");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")?.getAttribute("onclick")).toBeNull();
  });

  it("abre en VS Code las rutas citadas en código en línea", () => {
    const { api } = renderMd("Mira `src/a.ts:12` y `npm test`.");
    fireEvent.click(screen.getByText("src/a.ts:12"));
    expect(api.openInEditor).toHaveBeenCalledWith("src/a.ts", 12, undefined);
    expect(screen.getByText("npm test").classList.contains("pathref")).toBe(false);
  });

  it("alinea números, ordena la tabla al pulsar la cabecera y colorea ✓/✗", () => {
    const { container } = renderMd("| Caso | Tiempo |\n|---|---|\n| b ✓ | 10 ms |\n| a ✗ | 9 ms |");
    const firstCell = () => container.querySelector("tbody tr td")?.textContent;
    expect(container.querySelector("td.num")).not.toBeNull();
    expect(container.querySelector(".mark-ok")?.textContent).toBe("✓");
    fireEvent.click(screen.getByText("Tiempo"));
    expect(firstCell()).toBe("a ✗");
    fireEvent.click(screen.getByText("Tiempo"));
    expect(firstCell()).toBe("b ✓");
  });

  it("renderiza fórmulas con KaTeX y muestra el fichero del bloque de código", () => {
    const { container } = renderMd("$a^2$\n\n```ts src/x.ts\nconst a = 1;\n```");
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".cb-file")?.textContent).toContain("src/x.ts");
  });
});
