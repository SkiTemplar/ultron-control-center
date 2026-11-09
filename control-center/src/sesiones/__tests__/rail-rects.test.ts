// Columna de sesiones → rectángulos para la mascota (rail-rects.ts).

import { describe, expect, it } from "vitest";
import { clipOf, collectRailReport, EMPTY_RAIL, sameReport, type RailReport } from "../rail-rects";

type Box = { x: number; y: number; w: number; h: number };

function stub(el: Element, b: Box) {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ left: b.x, top: b.y, width: b.w, height: b.h, right: b.x + b.w, bottom: b.y + b.h, x: b.x, y: b.y, toJSON: () => b }) as DOMRect;
}

function row(rail: HTMLElement, id: string | null, b: Box) {
  const wrap = document.createElement("div");
  if (id) wrap.dataset.sessionId = id;
  const btn = document.createElement("button");
  btn.className = "sess";
  wrap.appendChild(btn);
  rail.appendChild(wrap);
  stub(wrap, { ...b, w: b.w + 40 });
  stub(btn, b);
}

function rail(box: Box) {
  const el = document.createElement("aside");
  stub(el, box);
  return el;
}

describe("collectRailReport", () => {
  it("toma el botón de cada fila y su recorte: completa, parcial, encima y debajo", () => {
    const r = rail({ x: 0, y: 100, w: 280, h: 400 });
    row(r, "full", { x: 8, y: 200, w: 260, h: 40 });
    row(r, "partial", { x: 8, y: 480, w: 260, h: 40 });
    row(r, "above", { x: 8, y: 40, w: 260, h: 40 });
    row(r, "below", { x: 8, y: 520, w: 260, h: 40 });
    const rep = collectRailReport(r, 1.5);
    expect(rep.dpr).toBe(1.5);
    expect(rep.rail).toEqual({ x: 0, y: 100, w: 280, h: 400 });
    expect(rep.items.map((i) => [i.id, i.clip])).toEqual([
      ["full", "full"],
      ["partial", "partial"],
      ["above", "above"],
      ["below", "below"],
    ]);
    expect(rep.items[0].rect).toEqual({ x: 8, y: 200, w: 260, h: 40 });
  });

  it("columna de ancho 0 (layout estrecho): sin columna ni filas (negativo)", () => {
    const r = rail({ x: 0, y: 0, w: 0, h: 600 });
    row(r, "s1", { x: 8, y: 20, w: 260, h: 40 });
    expect(collectRailReport(r, 1)).toEqual({ dpr: 1, rail: null, items: [], composer: null });
  });

  it("ignora lo que no lleva data-session-id (negativo)", () => {
    const r = rail({ x: 0, y: 0, w: 280, h: 600 });
    row(r, null, { x: 8, y: 20, w: 260, h: 40 });
    row(r, "s2", { x: 8, y: 70, w: 260, h: 40 });
    expect(collectRailReport(r, 1).items.map((i) => i.id)).toEqual(["s2"]);
  });

  it("clipOf: el borde exacto no cuenta como dentro", () => {
    const railBox = { x: 0, y: 100, w: 280, h: 100 };
    expect(clipOf({ x: 0, y: 60, w: 10, h: 40 }, railBox)).toBe("above");
    expect(clipOf({ x: 0, y: 200, w: 10, h: 40 }, railBox)).toBe("below");
    expect(clipOf({ x: 0, y: 100, w: 10, h: 100 }, railBox)).toBe("full");
  });
});

describe("sameReport", () => {
  const base: RailReport = {
    dpr: 1.25,
    rail: { x: 0, y: 0, w: 280, h: 700 },
    items: [{ id: "s1", rect: { x: 8, y: 60, w: 260, h: 40 }, clip: "full" }],
    composer: null,
  };
  const moved = (dy: number): RailReport => ({ ...base, items: [{ ...base.items[0], rect: { ...base.items[0].rect, y: 60 + dy } }] });

  it("un cambio de 0,4 px no cuenta; uno de 2 px, sí", () => {
    expect(sameReport(base, moved(0.4))).toBe(true);
    expect(sameReport(base, moved(2))).toBe(false);
  });

  it("cambian el dpr, el recorte, el orden o la columna (negativo)", () => {
    expect(sameReport(base, { ...base, dpr: 1.5 })).toBe(false);
    expect(sameReport(base, { ...base, items: [{ ...base.items[0], clip: "partial" }] })).toBe(false);
    expect(sameReport(base, { ...base, items: [] })).toBe(false);
    expect(sameReport(base, { ...base, rail: null, items: [] })).toBe(false);
  });

  it("sin columna da igual el dpr: no se reenvía el vacío", () => {
    expect(sameReport(EMPTY_RAIL, { dpr: 2, rail: null, items: [], composer: null })).toBe(true);
  });

  it("aparece, desaparece o se mueve el cuadro de texto: se reenvía (negativo)", () => {
    const comp = { x: 300, y: 640, w: 500, h: 70 };
    expect(sameReport(base, { ...base, composer: comp })).toBe(false);
    expect(sameReport(EMPTY_RAIL, { ...EMPTY_RAIL, composer: comp })).toBe(false);
    expect(sameReport({ ...base, composer: comp }, { ...base, composer: { ...comp, y: 600 } })).toBe(false);
    expect(sameReport({ ...base, composer: comp }, { ...base, composer: { ...comp, y: 640.3 } })).toBe(true);
  });
});

describe("cuadro de texto del chat en el informe", () => {
  function composer(b: Box | null) {
    const wrap = document.createElement("div");
    wrap.className = "composer";
    const cbox = document.createElement("div");
    cbox.className = "cbox";
    wrap.appendChild(cbox);
    document.body.appendChild(wrap);
    stub(cbox, b ?? { x: 0, y: 0, w: 0, h: 0 });
    return wrap;
  }

  it("va en el informe en px CSS, también con la columna oculta", () => {
    const c = composer({ x: 296, y: 650, w: 600, h: 72 });
    try {
      const r = rail({ x: 0, y: 0, w: 280, h: 700 });
      expect(collectRailReport(r, 1.25).composer).toEqual({ x: 296, y: 650, w: 600, h: 72 });
      const hidden = rail({ x: 0, y: 0, w: 0, h: 700 });
      expect(collectRailReport(hidden, 1).composer).toEqual({ x: 296, y: 650, w: 600, h: 72 });
    } finally {
      c.remove();
    }
  });

  it("sin cuadro o con tamaño 0 no hay composer (negativo)", () => {
    const r = rail({ x: 0, y: 0, w: 280, h: 700 });
    expect(collectRailReport(r, 1).composer).toBeNull();
    const c = composer(null);
    try {
      expect(collectRailReport(r, 1).composer).toBeNull();
    } finally {
      c.remove();
    }
  });
});
