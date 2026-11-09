// Mascota — lámina de revisión visual: un lienzo falso que apunta lo que se
// pinta y lo convierte en SVG. Lo usa un test (PUPUS_LAMINA=1) para volcar
// todas las actividades a un fichero que se abre en el navegador; así se
// revisa el pixel art sin abrir la app.

export interface Shape {
  kind: "rect" | "circle";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  alpha: number;
}

/** Lienzo 2D mínimo que apunta rectángulos y círculos. */
export class RecordingCtx {
  shapes: Shape[] = [];
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  globalAlpha = 1;
  readonly canvas = { width: 4000, height: 3000 };
  private pending: { x: number; y: number; r: number } | null = null;

  fillRect(x: number, y: number, w: number, h: number) {
    this.shapes.push({ kind: "rect", x, y, w, h, fill: this.fillStyle, alpha: this.globalAlpha });
  }
  arc(x: number, y: number, r: number) {
    this.pending = { x, y, r };
  }
  stroke() {
    const p = this.pending;
    if (p) this.shapes.push({ kind: "circle", x: p.x, y: p.y, w: p.r, h: p.r, fill: this.strokeStyle, alpha: this.globalAlpha });
    this.pending = null;
  }
  ellipse(x: number, y: number, rx: number, ry: number) {
    this.shapes.push({ kind: "rect", x: x - rx, y: y - ry / 2, w: 2 * rx, h: ry, fill: this.fillStyle, alpha: this.globalAlpha });
  }
  clearRect() {}
  beginPath() {}
  fill() {}
  moveTo() {}
  lineTo() {}
}

export interface Cell {
  title: string;
  shapes: Shape[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function shapeSvg(s: Shape, dx: number, dy: number): string {
  const o = s.alpha < 1 ? ` opacity="${s.alpha.toFixed(2)}"` : "";
  if (s.kind === "circle") {
    return `<circle cx="${s.x + dx}" cy="${s.y + dy}" r="${s.w}" fill="none" stroke="${esc(s.fill)}" stroke-width="2"${o}/>`;
  }
  return `<rect x="${s.x + dx}" y="${s.y + dy}" width="${s.w}" height="${s.h}" fill="${esc(s.fill)}"${o}/>`;
}

/** Rejilla de celdas sobre fondo oscuro; cada celda centra lo que se pintó en ella. */
export function sheetSvg(cells: Cell[], cellW = 260, cellH = 200, cols = 5): string {
  const rows = Math.ceil(cells.length / cols);
  const parts: string[] = [];
  cells.forEach((c, i) => {
    const cx = (i % cols) * cellW;
    const cy = Math.floor(i / cols) * cellH;
    const xs = c.shapes.map((s) => (s.kind === "circle" ? s.x - s.w : s.x));
    const ys = c.shapes.map((s) => (s.kind === "circle" ? s.y - s.w : s.y));
    const x1 = Math.max(...c.shapes.map((s) => (s.kind === "circle" ? s.x + s.w : s.x + s.w)));
    const y1 = Math.max(...c.shapes.map((s) => (s.kind === "circle" ? s.y + s.w : s.y + s.h)));
    const dx = cx + (cellW - (x1 - Math.min(...xs))) / 2 - Math.min(...xs);
    const dy = cy + 24 + (cellH - 24 - (y1 - Math.min(...ys))) / 2 - Math.min(...ys);
    parts.push(`<rect x="${cx + 2}" y="${cy + 2}" width="${cellW - 4}" height="${cellH - 4}" fill="#262624" stroke="#3a3835"/>`);
    parts.push(`<text x="${cx + 10}" y="${cy + 18}" fill="#cfcac0" font-family="sans-serif" font-size="13">${esc(c.title)}</text>`);
    if (c.shapes.length) parts.push(...c.shapes.map((s) => shapeSvg(s, Math.round(dx), Math.round(dy))));
  });
  const w = cols * cellW;
  const h = rows * cellH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="#1a1a19"/>${parts.join("")}</svg>`;
}
