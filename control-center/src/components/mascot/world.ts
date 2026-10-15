// Mascota — geometría del escritorio: ventanas → plataformas y paredes.
// Funciones puras (px CSS relativos a la ventana de la mascota), con tests.

export interface WinRect {
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Trozo VISIBLE del borde superior de una ventana: suelo donde posarse. */
export interface Platform {
  id: number;
  left: number;
  right: number;
  top: number;
  /** left de la ventana entera (para saber cuánto se ha movido). */
  winLeft: number;
}

/** Restar el intervalo [a, b] de una lista de intervalos. */
export function subtractInterval(segs: [number, number][], a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [l, r] of segs) {
    if (b <= l || a >= r) {
      out.push([l, r]);
      continue;
    }
    if (a > l) out.push([l, a]);
    if (b < r) out.push([b, r]);
  }
  return out;
}

/**
 * Bordes superiores visibles. `wins` va en orden Z, de la más alta a la más
 * baja (como lo da EnumWindows). Una ventana tapa el borde de otra más baja
 * si lo cubre a esa altura. Se ignoran las ventanas pegadas al techo del
 * área de trabajo (maximizadas): su borde no se ve.
 */
export function visiblePlatforms(
  wins: WinRect[],
  areaWidth: number,
  minTop = 4,
  minWidth = 30,
): Platform[] {
  const out: Platform[] = [];
  wins.forEach((w, i) => {
    if (w.top <= minTop) return;
    let segs: [number, number][] = [[Math.max(0, w.left), Math.min(areaWidth, w.right)]];
    for (let j = 0; j < i && segs.length; j++) {
      const o = wins[j];
      if (o.top <= w.top && w.top < o.bottom) segs = subtractInterval(segs, o.left, o.right);
    }
    for (const [l, r] of segs) {
      if (r - l >= minWidth) out.push({ id: w.id, left: l, right: r, top: w.top, winLeft: w.left });
    }
  });
  return out;
}

/** ¿El punto (x, y) queda tapado por alguna ventana más alta que la `i`? */
export function coveredAbove(wins: WinRect[], i: number, x: number, y: number): boolean {
  for (let j = 0; j < i; j++) {
    const o = wins[j];
    if (x >= o.left && x < o.right && y >= o.top && y < o.bottom) return true;
  }
  return false;
}

/** Plataforma bajo los pies (x, y) con tolerancia vertical `tol`. */
export function platformUnder(
  plats: Platform[],
  x: number,
  y: number,
  tol: number,
): Platform | null {
  let best: Platform | null = null;
  for (const p of plats) {
    if (x < p.left || x > p.right) continue;
    if (Math.abs(p.top - y) > tol) continue;
    if (!best || Math.abs(p.top - y) < Math.abs(best.top - y)) best = p;
  }
  return best;
}
