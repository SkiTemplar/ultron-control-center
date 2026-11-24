import { describe, expect, it } from "vitest";
import { PNG_LONG_SIDE, PNG_MAX_AREA, pngTargetSize, svgIntrinsicSize } from "../components/chat/md-diagrams";

describe("tamaño del PNG exportado de un diagrama", () => {
  it("Mermaid (width=100%) toma el tamaño del viewBox, no los 300×150 por defecto", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 640px;" viewBox="0 0 640.5 480"><g/></svg>`;
    expect(svgIntrinsicSize(svg)).toEqual({ w: 640.5, h: 480 });
  });

  it("Graphviz en pt sin viewBox usa width y height absolutos", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300pt" height="150pt"><g/></svg>`;
    expect(svgIntrinsicSize(svg)).toEqual({ w: 400, h: 200 });
  });

  it("caso negativo: sin viewBox ni tamaño absoluto no inventa uno", () => {
    expect(svgIntrinsicSize(`<svg xmlns="http://www.w3.org/2000/svg" width="100%"><g/></svg>`)).toBeNull();
    expect(svgIntrinsicSize("no es svg")).toBeNull();
  });

  it("el lado largo llega a 8192 px y mantiene la proporción", () => {
    expect(pngTargetSize(640, 480)).toEqual({ w: PNG_LONG_SIDE, h: 6144 });
    expect(pngTargetSize(200, 800)).toEqual({ w: 2048, h: PNG_LONG_SIDE });
  });

  it("un diagrama casi cuadrado se limita por área para no dar un canvas vacío", () => {
    const t = pngTargetSize(1000, 1000);
    expect(t.w * t.h).toBeLessThanOrEqual(PNG_MAX_AREA);
    expect(t.w).toBe(t.h);
    expect(t.w).toBe(8000);
  });
});
