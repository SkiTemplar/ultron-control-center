import { describe, expect, it } from "vitest";
import { floorSurface, nextHop, sameSurface, surfaceAt, type Surface } from "../travel";

const lim = { hw: 24, maxRise: 300, maxReach: 260 };
const floor = floorSurface(2000, 1000);
const low: Surface = { id: 1, left: 100, right: 500, top: 800 };
const mid: Surface = { id: 2, left: 600, right: 1000, top: 560 };
const high: Surface = { id: 3, left: 1100, right: 1500, top: 320 };
const all = [floor, low, mid, high];

describe("surfaceAt", () => {
  it("un clic en la barra de título apunta al borde de esa ventana", () => {
    expect(surfaceAt(all, 800, 575, lim.hw)?.id).toBe(2);
  });
  it("un clic cerca de la barra de tareas apunta al suelo", () => {
    expect(surfaceAt(all, 1800, 980, lim.hw)?.id).toBe("floor");
  });
  it("un clic en mitad de la nada no apunta a ninguna superficie", () => {
    expect(surfaceAt(all, 1800, 200, lim.hw)).toBeNull();
  });
});

describe("nextHop", () => {
  it("encadena saltos: suelo → baja → media → alta", () => {
    let cur = floor;
    const visited: (number | "floor")[] = [];
    for (let i = 0; i < 5 && !sameSurface(cur, high); i++) {
      const hop = nextHop(cur, high, all, lim);
      expect(hop).not.toBeNull();
      cur = hop!.to;
      visited.push(cur.id);
    }
    expect(visited).toEqual([1, 2, 3]);
  });

  it("el punto de caída queda dentro de la ventana de destino", () => {
    const hop = nextHop(low, mid, all, lim)!;
    expect(hop.landX).toBeGreaterThanOrEqual(mid.left + lim.hw);
    expect(hop.landX).toBeLessThanOrEqual(mid.right - lim.hw);
    expect(hop.takeoffX).toBe(low.right - lim.hw);
  });

  it("bajar siempre se puede si el hueco es alcanzable", () => {
    expect(nextHop(high, floor, all, lim)?.to.id).toBe("floor");
  });

  it("sin escalones intermedios no hay camino (toca volar)", () => {
    const lonely: Surface = { id: 9, left: 1700, right: 1900, top: 100 };
    expect(nextHop(floor, lonely, [floor, lonely], lim)).toBeNull();
  });

  it("ya está en la superficie de destino: no hay salto", () => {
    expect(nextHop(mid, mid, all, lim)).toBeNull();
  });
});
