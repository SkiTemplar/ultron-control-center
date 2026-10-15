// Mascota — estado de ánimo. Modelo puro (sin DOM) con tests.
//
// Cinco ejes continuos que suben con lo que le pasa y vuelven solos a su
// punto de reposo; el ánimo con nombre se deriva de ellos por prioridad.
//
//   happy     -1..1  caricias, clics, que elijas a Claude      ↘ reposo 0.3
//   energy     0..1  baja despierta, se recarga durmiendo
//   jealousy   0..1  sube al elegir GPT o Gemini                ↘ 0
//   anger      0..1  lanzamientos fuertes, clics en ráfaga      ↘ 0
//   boredom    0..1  sube sin que nadie le haga caso            ↘ 0 al interactuar

export type AgentId = "claude" | "codex" | "antigravity";

export type MoodName =
  | "emocionada"
  | "feliz"
  | "contenta"
  | "aburrida"
  | "cansada"
  | "celosa"
  | "triste"
  | "enfadada";

export interface Mood {
  happy: number;
  energy: number;
  jealousy: number;
  anger: number;
  boredom: number;
}

export const BASE_MOOD: Mood = { happy: 0.3, energy: 0.85, jealousy: 0, anger: 0, boredom: 0 };

export const MOOD_EMOJI: Record<MoodName, string> = {
  emocionada: "🤩",
  feliz: "😊",
  contenta: "🙂",
  aburrida: "🥱",
  cansada: "😪",
  celosa: "😤",
  triste: "😢",
  enfadada: "😠",
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function clampMood(m: Mood): Mood {
  return {
    happy: clamp(m.happy, -1, 1),
    energy: clamp(m.energy, 0, 1),
    jealousy: clamp(m.jealousy, 0, 1),
    anger: clamp(m.anger, 0, 1),
    boredom: clamp(m.boredom, 0, 1),
  };
}

export function nudge(m: Mood, d: Partial<Mood>): Mood {
  return clampMood({
    happy: m.happy + (d.happy ?? 0),
    energy: m.energy + (d.energy ?? 0),
    jealousy: m.jealousy + (d.jealousy ?? 0),
    anger: m.anger + (d.anger ?? 0),
    boredom: m.boredom + (d.boredom ?? 0),
  });
}

/** Acercar `v` a `target` a `rate` unidades por segundo. */
function toward(v: number, target: number, rate: number, dt: number): number {
  const step = rate * dt;
  return Math.abs(target - v) <= step ? target : v + Math.sign(target - v) * step;
}

export interface MoodContext {
  sleeping: boolean;
  /** Alguien le hace caso (hover, arrastre, conversación). */
  engaged: boolean;
  /** Hay abierta una conversación con un agente que no es Claude. */
  chattingOther: boolean;
}

export function tickMood(m: Mood, dt: number, ctx: MoodContext): Mood {
  return clampMood({
    happy: toward(m.happy, BASE_MOOD.happy, 0.012, dt),
    // ~20 min despierta de llena a vacía; durmiendo se recarga en ~1 min.
    energy: ctx.sleeping ? m.energy + 0.02 * dt : m.energy - 0.0008 * dt,
    // Los celos no se pasan mientras siga hablando con «el otro».
    jealousy: ctx.chattingOther ? m.jealousy : toward(m.jealousy, 0, 0.02, dt),
    anger: toward(m.anger, 0, 0.03, dt),
    boredom: ctx.engaged || ctx.sleeping ? toward(m.boredom, 0, 0.25, dt) : m.boredom + dt / 180,
  });
}

export function moodName(m: Mood): MoodName {
  if (m.anger > 0.5) return "enfadada";
  if (m.jealousy > 0.45) return "celosa";
  if (m.happy < -0.3) return "triste";
  if (m.energy < 0.2) return "cansada";
  if (m.boredom > 0.75) return "aburrida";
  if (m.happy > 0.7) return m.energy > 0.6 ? "emocionada" : "feliz";
  if (m.happy > 0.45) return "feliz";
  return "contenta";
}

/** Multiplicador de velocidad al andar según el ánimo. */
export function moodSpeed(name: MoodName): number {
  switch (name) {
    case "emocionada":
      return 1.45;
    case "feliz":
      return 1.15;
    case "enfadada":
      return 1.3;
    case "triste":
      return 0.65;
    case "cansada":
      return 0.55;
    case "aburrida":
      return 0.8;
    default:
      return 1;
  }
}

export function parseMood(raw: string | null): Mood | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Mood>;
    const n = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
    return clampMood({
      happy: n(v.happy, BASE_MOOD.happy),
      energy: n(v.energy, BASE_MOOD.energy),
      jealousy: n(v.jealousy, 0),
      anger: n(v.anger, 0),
      boredom: n(v.boredom, 0),
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Colores por agente: la mascota se «disfraza» del agente con el que hablas.
// ---------------------------------------------------------------------------

export type RGB = [number, number, number];

export const AGENT_COLORS: Record<AgentId, RGB> = {
  claude: [0xd9, 0x77, 0x57], // terracota de Claude
  codex: [0x10, 0xa3, 0x7f], // verde de GPT
  antigravity: [0x4c, 0x8d, 0xf6], // azul de Gemini
};

export function rgbToCss([r, g, b]: RGB): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

export function mixRgb(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
