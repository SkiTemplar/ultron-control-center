// Motor de actividades: sorteo según la hora, el ánimo y el disfraz;
// cooldowns, hueco global, ajuste apagado y cortes. Reloj inyectado.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MascotEngine, type MascotSettings } from "../engine";
import type { MoodState } from "../moodState";
import { Vitality } from "../vitality";
import { ACTIVITY_IDS, GLOBAL_GAP_S, OFFER_WEIGHT } from "../activities/catalog";
import type { ActivityId } from "../activities/types";

const W = 1600;
const H = 860;
const NOON = new Date(2026, 9, 16, 12, 0, 0);
const NIGHT = new Date(2026, 9, 16, 3, 0, 0);

function engine(state: MoodState, when = NOON, patch: Partial<MascotSettings> = {}) {
  const e = new MascotEngine(W, H, { ...DEFAULT_SETTINGS, wander: false, ...patch }, () => 0.5);
  e.now = () => when;
  e.life = new Vitality(() => 0.5, () => when.getTime()); // el ánimo también con el reloj del test
  e.life.state = state;
  e.x = 800;
  e.t = 1000; // lejos del arranque: sin hueco global pendiente
  // Pasado el saludo de arranque (modo «wave»), ya en reposo.
  for (let i = 0; i < 90; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
  return e;
}

const ids = (e: MascotEngine): ActivityId[] => e.acts.candidates(e).map(([id]) => id);

/** Corre la actividad en curso hasta que termine (o `max` segundos). */
function finish(e: MascotEngine, max = 60) {
  const dt = 1 / 60;
  for (let t = 0; t < max && e.mode === "act"; t += dt) e.update({ dt, cursor: null, hovered: false, chat: "none" });
}

describe("catálogo", () => {
  it("el castillo de arena ya no existe y la mariposa sigue", () => {
    expect(ACTIVITY_IDS as string[]).not.toContain("castillo");
    expect(ACTIVITY_IDS).toContain("mariposa");
  });
});

describe("sorteo de actividades", () => {
  it("de noche nunca salen malabares, voltereta, pompas ni avión", () => {
    for (const state of ["feliz", "emocionado", "jugueton", "contento"] as MoodState[]) {
      const list = ids(engine(state, NIGHT));
      for (const id of ["malabares", "voltereta", "pompas", "avion", "barrer", "mariposa", "gimnasia"]) {
        expect(list, `${state}: ${id}`).not.toContain(id);
      }
    }
  });

  it("de noche sí puede leer y mirar las estrellas", () => {
    const list = ids(engine("contento", NIGHT));
    expect(list).toContain("leer");
    expect(list).toContain("estrellas");
  });

  it("de día y contento hay jaleo, y las estrellas no salen", () => {
    const list = ids(engine("feliz", NOON));
    expect(list).toContain("malabares");
    expect(list).toContain("voltereta");
    expect(list).not.toContain("estrellas");
  });

  it("concentrado contigo (programando) solo le quedan las quietas", () => {
    const e = engine("contento", NOON);
    e.life.allows = () => false;
    const list = ids(e);
    expect(list).toContain("leer");
    expect(list).not.toContain("malabares");
    expect(list).not.toContain("avion");
  });

  it("la bienvenida y el baile nunca salen por sorteo", () => {
    for (const when of [NOON, NIGHT]) {
      const list = ids(engine("feliz", when));
      expect(list).not.toContain("bienvenida");
      expect(list).not.toContain("bailar");
    }
  });

  it("las actividades de disfraz solo con su disfraz", () => {
    const e = engine("feliz");
    expect(ids(e)).not.toContain("conducir");
    e.acts.outfit = "car";
    expect(ids(e)).toContain("conducir");
    expect(ids(e)).not.toContain("catalejo");
    e.acts.outfit = "eyepatch";
    expect(ids(e)).toContain("catalejo");
  });
});

describe("rareza, cooldowns y ajuste", () => {
  it("tras una actividad, el hueco global anula la oferta y luego su cooldown la excluye", () => {
    const e = engine("contento");
    expect(e.acts.offerWeight(e)).toBe(OFFER_WEIGHT);
    expect(e.doActivity("leer")).toBe(true);
    finish(e);
    expect(e.mode).not.toBe("act");
    expect(e.acts.offerWeight(e)).toBe(0);
    e.t += GLOBAL_GAP_S + 1;
    expect(e.acts.offerWeight(e)).toBe(OFFER_WEIGHT);
    expect(ids(e)).not.toContain("leer");
    e.t += 400;
    expect(ids(e)).toContain("leer");
  });

  it("con «Actividades» apagado no se ofrece ni empieza ninguna", () => {
    const e = engine("feliz", NOON, { activities: false });
    expect(e.acts.offerWeight(e)).toBe(0);
    expect(e.doActivity("malabares")).toBe(false);
    expect(e.mode).not.toBe("act");
  });

  it("cortarla recoge sus accesorios pero deja los objetos del mundo", () => {
    const e = engine("feliz");
    expect(e.doActivity("pompas")).toBe(true);
    for (let i = 0; i < 90; i++) e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "none" });
    expect(e.acts.items.some((i) => i.kind === "bubble")).toBe(true);
    expect(e.acts.props(e).length).toBeGreaterThan(0);
    e.startDrag(e.x, e.y, e.t);
    expect(e.mode).toBe("drag");
    expect(e.acts.current).toBeNull();
    expect(e.acts.props(e)).toEqual([]);
    expect(e.acts.items.some((i) => i.kind === "bubble")).toBe(true);
  });

  it("abrir la conversación termina la actividad", () => {
    const e = engine("contento");
    e.doActivity("leer");
    e.update({ dt: 1 / 60, cursor: null, hovered: false, chat: "listen" });
    expect(e.acts.current).toBeNull();
    expect(e.mode).not.toBe("act");
  });
});
