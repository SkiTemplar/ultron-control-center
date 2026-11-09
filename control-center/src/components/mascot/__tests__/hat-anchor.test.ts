// El gorro va pegado a la cabeza en todos los modos, gestos, estados,
// escalas y orientaciones (headAnchor.ts). Se pinta con renderFrame de
// verdad sobre un contexto 2D falso y se miran los rectángulos.
//
// Con MASCOT_HAT_SHEET=<ruta.svg> vuelca además una lámina con todos los
// modos × gorros para revisarla a ojo.

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, EMOTE_DURATION, MascotEngine, type ChatState, type Emote, type Mode, type Surface } from "../engine";
import { renderFrame } from "../render";
import { BASE_POSE, COLORS, drawPet, type Pose } from "../sprite";
import { hatRects } from "../accessories";
import { headAnchor, hatPolicy, type HeadAnchor } from "../headAnchor";
import { MOOD_STATES, type MoodState } from "../moodState";
import type { Hat } from "../outfits";

const layer = vi.hoisted(() => ({ name: "" }));

vi.mock("../accessories", async (orig) => {
  const m = await orig<typeof import("../accessories")>();
  return {
    ...m,
    drawHat: (...args: Parameters<typeof m.drawHat>) => {
      layer.name = "hat";
      try {
        return m.drawHat(...args);
      } finally {
        layer.name = "";
      }
    },
  };
});

vi.mock("../sprite", async (orig) => {
  const m = await orig<typeof import("../sprite")>();
  return {
    ...m,
    drawPet: (...args: Parameters<typeof m.drawPet>) => {
      layer.name = "pet";
      try {
        return m.drawPet(...args);
      } finally {
        layer.name = "";
      }
    },
  };
});

interface Painted {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  layer: string;
}

function fakeCtx() {
  const painted: Painted[] = [];
  const ctx = {
    canvas: { width: 4000, height: 3000 },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      painted.push({ x, y, w, h, fill: String(this.fillStyle), layer: layer.name });
    },
    clearRect: () => {},
    beginPath: () => {},
    ellipse: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, painted };
}

/** Todos los modos: si aparece uno nuevo, tsc obliga a añadirlo aquí. */
const ALL_MODES: Record<Mode, true> = {
  idle: true,
  walk: true,
  sit: true,
  sleep: true,
  crouch: true,
  air: true,
  land: true,
  drag: true,
  hang: true,
  splat: true,
  dizzy: true,
  wave: true,
  emote: true,
  drive: true,
  fly: true,
  climb: true,
  act: true,
};
const HATS: Hat[] = ["grad", "hardhat", "cap", "beret", "santa", "witch", "nightcap", "pirate", "helmet"];
const SIDES: Surface[] = ["floor", "left", "right", "ceil"];
const CHATS: ChatState[] = ["none", "listen", "think", "talk"];
const EMOTES = Object.keys(EMOTE_DURATION) as Emote[];

interface Variant {
  mode: Mode;
  side?: Surface;
  emote?: Emote;
  state?: MoodState;
}

function variants(): Variant[] {
  const out: Variant[] = [];
  for (const mode of Object.keys(ALL_MODES) as Mode[]) {
    if (mode === "splat") SIDES.forEach((side) => out.push({ mode, side }));
    else if (mode === "emote") EMOTES.forEach((emote) => out.push({ mode, emote }));
    else out.push({ mode });
  }
  for (const state of MOOD_STATES) for (const mode of ["idle", "walk", "sit"] as Mode[]) out.push({ mode, state });
  return out;
}

const label = (v: Variant) => [v.mode, v.side, v.emote, v.state].filter(Boolean).join("/");

/** Coloca el motor en el modo y el instante pedidos sin pasar por update(). */
function pose(e: MascotEngine, v: Variant, tt: number) {
  const priv = e as unknown as { splatSide: Surface; hangAnchor: { x: number; y: number } | null };
  e.mode = v.mode;
  e.emote = v.emote ?? null;
  e.t = tt;
  e.modeT = tt;
  priv.splatSide = v.side ?? "floor";
  priv.hangAnchor = v.mode === "hang" ? { x: e.x, y: e.y - 200 } : null;
  e.vy = -2600 + ((tt * 30) % 90) * (5200 / 89);
  if (v.state) e.life.state = v.state;
}

interface Check {
  ok: boolean;
  why: string;
}

/**
 * Centro y base nominales del gorro respecto al centro y la coronilla del
 * cuerpo. Salen de la tabla de gorros con un ancla en el origen, no del
 * ancla que se está probando (la borla del birrete cuelga 1 px por debajo).
 */
function nominal(hat: Hat, S: number, facing: 1 | -1): { center: number; bottom: number } {
  const rs = hatRects(hat, { cx: 0, top: 0, w: 0, facing }, S);
  const x0 = Math.min(...rs.map((r) => r.x));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  return { center: (x0 + x1) / 2, bottom: Math.max(...rs.map((r) => r.y + r.h)) };
}

/** ¿Los rectángulos del gorro apoyan en la coronilla del cuerpo pintado y no tapan los ojos? */
function judge(painted: Painted[], body: Painted, hat: Hat, S: number, facing: 1 | -1): Check {
  const hatR = painted.filter((r) => r.layer === "hat");
  if (!hatR.length) return { ok: false, why: "sin gorro" };
  const nom = nominal(hat, S, facing);
  const bottom = Math.max(...hatR.map((r) => r.y + r.h)) - nom.bottom;
  if (Math.abs(bottom - body.y) > 1) return { ok: false, why: `base ${bottom} vs coronilla ${body.y}` };
  const cx = (Math.min(...hatR.map((r) => r.x)) + Math.max(...hatR.map((r) => r.x + r.w))) / 2;
  const bodyCx = body.x + body.w / 2;
  if (cx < body.x || cx > body.x + body.w) return { ok: false, why: `centro ${cx} fuera de [${body.x}, ${body.x + body.w}]` };
  if (Math.abs(cx - bodyCx - nom.center) > 1) return { ok: false, why: `centro ${cx} desplazado de ${bodyCx}` };
  // Los ojos empiezan como pronto en la fila 1 del cuerpo; en la fila 0 solo
  // hay cejas, y que la borla del birrete tape una es lo natural.
  const eyes = painted.filter((r) => r.layer === "pet" && r.fill === COLORS.eye && r.y >= body.y + S);
  const hit = eyes.find((e) => hatR.some((h) => h.x < e.x + e.w && e.x < h.x + h.w && h.y < e.y + e.h && e.y < h.y + h.h));
  return hit ? { ok: false, why: "el gorro tapa un ojo" } : { ok: true, why: "" };
}

function bodyOf(painted: Painted[], color: string): Painted {
  const own = painted.filter((r) => r.layer === "pet" && r.fill === color);
  return own.reduce((a, b) => (b.w > a.w ? b : a));
}

/** Pinta cuerpo y gorro con un ancla dada y juzga (para los casos negativos). */
function hatSitsOnHead(p: Pose, a: HeadAnchor, hat: Hat, S: number): boolean {
  const { ctx, painted } = fakeCtx();
  layer.name = "pet";
  drawPet(ctx, p, 500, 800, S, a.facing, COLORS.body);
  layer.name = "hat";
  for (const r of hatRects(hat, a, S)) painted.push({ ...r, fill: r.color, layer: "hat" });
  layer.name = "";
  return judge(painted, bodyOf(painted, COLORS.body), hat, S, a.facing).ok;
}

describe("el gorro sigue a la cabeza", () => {
  for (const v of variants()) {
    it(label(v), () => {
      const failures: string[] = [];
      for (const facing of [1, -1] as const) {
        for (const dpr of [1, 1.25, 1.5]) {
          for (const scale of [3, 4, 6]) {
            const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false, scale }, () => 0.37);
            e.x = 800;
            e.y = 700;
            e.facing = facing;
            for (let i = 0; i < 90; i++) {
              const hat = HATS[i % HATS.length];
              e.hat = hat;
              pose(e, v, i / 30);
              const chat = CHATS[i % CHATS.length];
              const { ctx, painted } = fakeCtx();
              renderFrame(ctx, e, chat, dpr, null);
              const f = e.frame(chat);
              const expectHat = hatPolicy(v.mode, v.side ?? "floor") === "on";
              const hatR = painted.filter((r) => r.layer === "hat");
              if (!expectHat) {
                if (hatR.length) failures.push(`${facing}/${dpr}/${scale}/${i}: lleva gorro y no debería`);
                continue;
              }
              const S = Math.max(1, Math.round(scale * dpr));
              const c = judge(painted, bodyOf(painted, f.color), hat, S, f.facing);
              if (!c.ok) failures.push(`${hat} facing=${facing} dpr=${dpr} scale=${scale} i=${i}: ${c.why}`);
            }
          }
        }
      }
      expect(failures.slice(0, 5)).toEqual([]);
    });
  }
});

describe("casos negativos del juez", () => {
  const S = 4;
  const p: Pose = { ...BASE_POSE, dx: 2, sy: 0.9, breath: 0.6, lift: 0.4 };
  const good = headAnchor(p, 500, 800, S, 1);

  it("el ancla correcta pasa", () => {
    for (const hat of HATS) expect(hatSitsOnHead(p, good, hat, S)).toBe(true);
  });

  it("un ancla 1 px de sprite más arriba no pasa", () => {
    expect(hatSitsOnHead(p, { ...good, top: good.top - S }, "santa", S)).toBe(false);
  });

  it("un ancla que ignora el desplazamiento dx no pasa", () => {
    expect(hatSitsOnHead(p, { ...good, cx: 500 }, "santa", S)).toBe(false);
  });

  // La fórmula antigua (coronilla fija a 10 px de sprite de los pies, sin
  // patas, aplastamiento ni respiración) dejaba el gorro flotando aquí.
  const oldAnchor = (q: Pose, fy: number): HeadAnchor => ({ cx: 500, top: fy - 10 * S - Math.round(q.lift * S), w: 0, facing: 1 });
  const frameOf = (mode: Mode, side: Surface = "floor") => {
    const e = new MascotEngine(1600, 860, { ...DEFAULT_SETTINGS, wander: false, scale: S }, () => 0.37);
    pose(e, { mode, side }, 0);
    for (let i = 1; i < 60; i++) {
      e.t = i / 30;
      e.modeT = i / 30;
      e.frame("none");
    }
    return e.frame("none").pose;
  };

  for (const [mode, gapPx] of [
    ["sleep", 2],
    ["crouch", 3],
    ["splat", 7],
  ] as const) {
    it(`regresión: en ${mode} la fórmula antigua deja el gorro ~${gapPx} px de sprite por encima`, () => {
      const q = frameOf(mode);
      expect(hatSitsOnHead(q, oldAnchor(q, 800), "santa", S)).toBe(false);
      expect(hatSitsOnHead(q, headAnchor(q, 500, 800, S, 1), "santa", S)).toBe(true);
      const gap = headAnchor(q, 500, 800, S, 1).top - oldAnchor(q, 800).top;
      expect(Math.round(gap / S)).toBeGreaterThanOrEqual(gapPx - 1);
    });
  }
});

/** Variables de entorno y fs de Node sin tipos de Node (el tsconfig de src no los carga). */
interface NodeFs {
  mkdirSync(p: string, o: { recursive: boolean }): void;
  writeFileSync(p: string, s: string): void;
  existsSync(p: string): boolean;
}
const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

describe("lámina para revisar a ojo", () => {
  const out = env.MASCOT_HAT_SHEET;
  it.skipIf(!out)("vuelca un SVG con todos los modos × gorros", async () => {
    const fs = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as NodeFs;
    const cell = 110;
    const rows = variants().filter((v) => !v.state || v.mode === "idle");
    const rects: string[] = [];
    rows.forEach((v, row) => {
      HATS.forEach((hat, col) => {
        const e = new MascotEngine(4000, 3000, { ...DEFAULT_SETTINGS, wander: false, scale: 4 }, () => 0.37);
        e.x = col * cell + cell / 2 + 140;
        e.y = row * cell + cell - 18;
        e.hat = hat;
        pose(e, v, 0.8);
        const { ctx, painted } = fakeCtx();
        renderFrame(ctx, e, "none", 1, null);
        for (const r of painted) rects.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"/>`);
      });
      rects.push(`<text x="4" y="${row * cell + cell / 2}" font-size="12" fill="#ddd">${label(v)}</text>`);
    });
    const w = 140 + HATS.length * cell;
    const h = rows.length * cell;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#2b2b33"/>${rects.join("")}</svg>`;
    fs.mkdirSync((out as string).replace(/[\\/][^\\/]*$/, ""), { recursive: true });
    fs.writeFileSync(out as string, svg);
    expect(fs.existsSync(out as string)).toBe(true);
  });
});
