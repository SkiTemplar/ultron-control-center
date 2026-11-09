// Mascota — actividades de Pupus (leer, pescar, malabares…): tipos comunes.
//
// Una actividad es un guion con fases que el motor ejecuta en el modo «act»:
// fija la pose de cada instante, puede mover a Pupus por su superficie,
// soltar partículas y dejar objetos en el mundo (avión, pompas, mariposa)
// que siguen vivos aunque la actividad termine. Nada gasta tokens: todo es
// local (reloj, cursor, ventanas y, para bailar, el estado de la música).
//
// Unidades: el mundo (Actor, WorldItem) va en px CSS como el motor; los
// accesorios (Px) en píxeles de sprite, mirando a +x, como los gorros.

import type { Effect, EffectKind } from "../engine";
import type { Emote } from "../emotes";
import type { Mood } from "../mood";
import type { MoodState } from "../moodState";
import type { Body } from "../outfits";
import type { Eyes, Glyph, Pose } from "../sprite";
import type { Platform } from "../world";

/** Rectángulo de pixel art: x, y, ancho, alto (px de sprite) y color. */
export type Px = [number, number, number, number, string];

export type ActivityId =
  | "leer"
  | "estrellas"
  | "bienvenida"
  | "malabares"
  | "pompas"
  | "voltereta"
  | "gimnasia"
  | "barrer"
  | "avion"
  | "pescar"
  | "mariposa"
  | "bailar"
  | "catalejo"
  | "arrastrarse"
  | "conducir";

/**
 * Accesorios de un instante. `head` = origen en el centro de la coronilla
 * real (headAnchor.ts: sigue el bote, la respiración y el aplastamiento);
 * `feet` = origen en el centro de los pies.
 */
export interface PropSet {
  anchor: "head" | "feet";
  px: Px[];
}

/** Sedal de pesca: cuelga de la punta de la caña `depth` px CSS por debajo de los pies. */
export interface FishLine {
  /** Punta de la caña respecto a los pies, en px de sprite (mirando a +x). */
  tip: [number, number];
  depth: number;
  /** El corcho se hunde (está picando). */
  dip: boolean;
}

/** Lo que el motor ofrece a las actividades (MascotEngine lo cumple). */
export interface Actor {
  x: number;
  y: number;
  t: number;
  facing: 1 | -1;
  mood: Mood;
  happyUntil: number;
  effects: Effect[];
  readonly S: number;
  readonly halfW: number;
  readonly height: number;
  readonly W: number;
  readonly H: number;
  plats: Platform[];
  ground: { kind: "floor" | "win" } | null;
  kick(dx: number, dy: number): void;
  burst(kind: EffectKind, n: number, color?: string, spread?: number): void;
  floatUp(kind: "heart" | "note", n?: number): void;
  showIcon(glyph: Glyph, life?: number): void;
  surfaceBounds(): [number, number];
}

/** Lo que pesa al elegir actividad. */
export interface ActivityCtx {
  state: MoodState;
  /** De 01:00 a 06:59 (outfits.ts). */
  night: boolean;
  hour: number;
  /** 1-12. */
  month: number;
  /** Concentrado contigo (programando o en una llamada): solo actividades quietas. */
  calmOnly: boolean;
  onWindow: boolean;
  /** Espacio libre (px CSS) hacia donde mira y a su espalda, hasta el borde de su superficie. */
  ahead: number;
  behind: number;
  /** Borde de la ventana sobre la que está más cercano y la caída libre debajo (px CSS). */
  edge: { x: number; dir: 1 | -1; drop: number } | null;
  /** Disfraz de juego puesto (gameOutfits.ts). */
  outfit: Body | null;
  music: boolean;
}

export interface ActivityRun {
  id: ActivityId;
  t0: number;
  dur: number;
  /** Marcas de efectos ya disparados (once). */
  marks: Set<string>;
  /** Números propios de cada actividad (fase, ids de objetos, destinos…). */
  data: Record<string, number>;
  hovered: boolean;
  /** La empezó recién despertado (de noche bosteza antes). */
  woke: boolean;
  night: boolean;
}

/** "go" = sigue; "idle"/"sleep" = termina así; un Emote = termina y lo encadena. */
export type StepResult = "go" | "idle" | "sleep" | Emote;

export interface StepIn {
  tt: number;
  dt: number;
  cursor: { x: number; y: number } | null;
  hovered: boolean;
  music: boolean;
}

export type CatchKind = "sardina" | "payaso" | "bota" | "tmp";

export type WorldItemKind = "plane" | "bubble" | "ball" | "butterfly" | "star";

/** Objeto suelto por el mundo, en px CSS. */
export interface WorldItem {
  id: number;
  kind: WorldItemKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  /** Fase propia: mariposa 0 libre / 1 posada / 2 se va, avión 1 = ya hizo el rizo. */
  stage: number;
  /** 0..1, para variar el vuelo y el vaivén. */
  seed: number;
  /** Radio en px CSS (pompas). */
  r: number;
  /** x de salida (avión: distancia recorrida). */
  x0: number;
  landed: boolean;
}

export type NewItem = Omit<WorldItem, "id" | "age" | "landed" | "x0"> & { landed?: boolean };

export type ItemEvent =
  | { kind: "bubblePop"; x: number; y: number }
  | { kind: "planeLanded"; x: number; y: number; dist: number };

/** Servicios del motor de actividades a cada guion. */
export interface Kit {
  rand(): number;
  spawn(item: NewItem): number;
  item(id: number): WorldItem | undefined;
  patch(id: number, p: Partial<WorldItem>): void;
  /** Mueve a Pupus `dx` px CSS dentro de su superficie; false si topa con el borde. */
  moveX(a: Actor, dx: number): boolean;
  /** Apunta una captura de pesca; true si es la primera de su tipo. */
  recordCatch(kind: CatchKind): boolean;
}

export interface ActivityDef {
  id: ActivityId;
  /** Duración mínima y máxima, en segundos. */
  dur: readonly [number, number];
  cooldownS: number;
  /** Peso en el sorteo (0 = no elegible ahora). */
  weight(ctx: ActivityCtx): number;
  /** Puede empezar despertándolo (bienvenida). */
  fromSleep?: boolean;
  begin?(run: ActivityRun, a: Actor, kit: Kit, ctx: ActivityCtx): void;
  step(run: ActivityRun, a: Actor, kit: Kit, inp: StepIn): StepResult;
  pose(run: ActivityRun, tt: number, p: Pose): Eyes | null;
  props?(run: ActivityRun, tt: number): PropSet[];
  line?(run: ActivityRun, tt: number): FishLine | null;
  /** Clic durante la actividad: true si lo consume (no salta). */
  poke?(run: ActivityRun, a: Actor, kit: Kit): boolean;
}
