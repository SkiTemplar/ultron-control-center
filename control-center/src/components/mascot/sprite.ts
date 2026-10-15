// Mascota — sprite en pixel art dibujado por código.
//
// El cuerpo se compone de rectángulos en «píxeles de sprite» (cada uno se
// pinta como un cuadrado de `scale` píxeles CSS). Dibujarlo por piezas en
// vez de usar hojas de sprites permite combinar poses (brazos, piernas,
// ojos, aplastamiento) sin dibujar cada fotograma a mano.
//
// Proporciones de Clawd, la mascota de Claude Code, sacadas píxel a píxel
// del logo de bloques que pinta la CLI (`▐▛███▜▌` / `▝▜█████▛▘` / `▘▘ ▝▝`):
// cada cuadrante de bloque es un píxel el doble de alto que ancho, así que
// en píxeles cuadrados queda un cuerpo de 12×8, ojos de 1×2 en las columnas
// 2 y 9 (filas 2-3), brazos de 2×2 a media altura (filas 4-5) y cuatro patas
// de 1×2 en las columnas 1, 3, 8 y 10.
//
// Origen: centro de los pies (abajo en el centro). El sprite en reposo
// ocupa x∈[-8,8) (cuerpo + brazos) e y∈[-10,0).

export const BODY_W = 12;
export const BODY_H = 8;
export const LEG_H = 2;
export const SPRITE_H = BODY_H + LEG_H;

export const COLORS = {
  body: "#D97757",
  eye: "#141413",
  pin: "#E5484D",
  pinShade: "#A2282C",
  line: "#9A9A9A",
  star: "#F5C451",
  dust: "rgba(200, 190, 180, 0.8)",
};

export type Eyes = "open" | "blink" | "happy" | "dizzy" | "wide" | "closed" | "squint";
export type Arm =
  | "out"
  | "down"
  | "up"
  | "wave1"
  | "wave2"
  | "flail1"
  | "flail2"
  | "type1"
  | "type2"
  | "flat"
  | "none";
export type Legs = "stand" | "walk1" | "walk2" | "dangle" | "tuck" | "spread" | "run1" | "run2" | "none";

export interface Pose {
  /** Aplastamiento horizontal / vertical del cuerpo (1 = normal). */
  sx: number;
  sy: number;
  eyes: Eyes;
  /** Dirección de la mirada, -1..1 en cada eje. */
  lookX: number;
  lookY: number;
  armL: Arm;
  armR: Arm;
  legs: Legs;
  /** Desplazamiento horizontal de las piernas (balanceo al colgar), en px de sprite. */
  legSwing: number;
  /** Desplazamiento del cuerpo entero, en px de sprite. */
  dx: number;
  dy: number;
}

export const BASE_POSE: Pose = {
  sx: 1,
  sy: 1,
  eyes: "open",
  lookX: 0,
  lookY: 0,
  armL: "out",
  armR: "out",
  legs: "stand",
  legSwing: 0,
  dx: 0,
  dy: 0,
};

type R = [number, number, number, number]; // x, y, w, h

/**
 * Piezas del brazo IZQUIERDO, relativas al borde izquierdo del cuerpo
 * (x negativa = hacia fuera) y a su borde superior. El derecho es el espejo.
 */
const ARM_SHAPES: Record<Arm, R[]> = {
  out: [[-2, 4, 2, 2]],
  down: [[-1, 4, 1, 4]],
  up: [
    [-2, -3, 2, 2],
    [-1, -1, 1, 6],
  ],
  wave1: [
    [-3, -1, 2, 2],
    [-2, 1, 1, 3],
    [-1, 4, 1, 2],
  ],
  wave2: [
    [-1, -3, 2, 2],
    [-1, -1, 1, 6],
  ],
  flail1: [
    [-3, 1, 2, 2],
    [-1, 3, 1, 2],
  ],
  flail2: [
    [-3, 6, 2, 2],
    [-1, 5, 1, 2],
  ],
  type1: [[-2, 6, 2, 1]],
  type2: [[-2, 5, 2, 1]],
  flat: [[-3, 4, 3, 1]],
  none: [],
};

/** Columnas de las 4 patas respecto al centro (pares izquierdo y derecho). */
const LEG_X = [-5, -3, 2, 4];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Dimensiones del cuerpo con aplastamiento (siempre enteros y anchura par). */
export function bodyDims(p: Pose): { w: number; h: number } {
  let w = Math.max(4, Math.round(BODY_W * p.sx));
  if (w % 2) w += 1;
  const h = Math.max(2, Math.round(BODY_H * p.sy));
  return { w, h };
}

function legLayout(p: Pose): { rects: R[]; height: number } {
  const swing = Math.round(p.legSwing);
  switch (p.legs) {
    case "none":
      return { rects: [], height: 0 };
    case "tuck":
      return { rects: LEG_X.map((x) => [x, -1, 1, 1] as R), height: 1 };
    case "walk1":
    case "walk2": {
      // La pata levantada se queda a medio paso (1 px por encima del suelo).
      const lifted = p.legs === "walk1" ? [0, 2] : [1, 3];
      return {
        rects: LEG_X.map((x, i) =>
          lifted.includes(i) ? ([x, -2, 1, 1] as R) : ([x, -2, 1, 2] as R),
        ),
        height: 2,
      };
    }
    case "run1":
    case "run2": {
      const a = p.legs === "run1";
      return {
        rects: LEG_X.map((x, i) => {
          const fwd = (i % 2 === 0) === a;
          return [x + (fwd ? 1 : -1) + swing, -2, 1, fwd ? 1 : 2] as R;
        }),
        height: 2,
      };
    }
    case "spread":
      return {
        rects: [
          [-6 + swing, -2, 1, 2],
          [-3 + swing, -2, 1, 2],
          [2 + swing, -2, 1, 2],
          [5 + swing, -2, 1, 2],
        ],
        height: 2,
      };
    case "dangle":
      return {
        rects: LEG_X.map((x) => [x + swing, -2, 1, 3] as R),
        height: 2,
      };
    case "stand":
    default:
      return { rects: LEG_X.map((x) => [x, -2, 1, 2] as R), height: 2 };
  }
}

/** Rectángulos que forman la mascota, en píxeles de sprite, por color. */
export function spriteRects(p: Pose): { body: R[]; eye: R[]; bbox: Box } {
  const { w, h } = bodyDims(p);
  const legs = legLayout(p);
  const dx = Math.round(p.dx);
  const dy = Math.round(p.dy);
  const left = -w / 2 + dx;
  const bottom = -legs.height + dy;
  const top = bottom - h;

  // Clawd es de un solo color plano: cuerpo, brazos y patas.
  const body: R[] = [[left, top, w, h]];

  for (const [x, y, lw, lh] of legs.rects) {
    // Las piernas cuelgan del cuerpo: se desplazan con él en vertical.
    body.push([x + dx, y + dy, lw, lh]);
  }

  const armScale = Math.min(1, h / BODY_H);
  const pushArm = (arm: Arm, side: -1 | 1) => {
    for (const [ax, ay, aw, ah] of ARM_SHAPES[arm]) {
      const y = top + Math.round(ay * (arm === "flat" ? armScale : 1));
      const x = side === -1 ? left + ax : left + w - ax - aw;
      body.push([x, y, aw, ah]);
    }
  };
  pushArm(p.armL, -1);
  pushArm(p.armR, 1);

  // Ojos: 1×2 en las columnas 2 y w-3 (las de Clawd con w=12), movidos por
  // la mirada sin salirse del cuerpo.
  const eye: R[] = [];
  const lx = Math.max(-1, Math.min(1, Math.round(p.lookX)));
  const ly = Math.max(-1, Math.min(1, Math.round(p.lookY)));
  const eyeY = top + Math.max(1, Math.min(h - 3, Math.round(2 * Math.min(1, h / BODY_H)) + ly));
  const inset = Math.max(1, Math.min(3, Math.round(w / 6)));
  const centers = [left + inset + lx, left + w - inset - 1 + lx];
  centers.forEach((ex, i) => {
    switch (p.eyes) {
      case "blink":
      case "closed":
        eye.push([ex - (p.eyes === "closed" ? 1 : 0), eyeY + 1, p.eyes === "closed" ? 2 : 1, 1]);
        break;
      case "happy":
        eye.push([ex - 1, eyeY + 1, 1, 1], [ex, eyeY, 1, 1], [ex + 1, eyeY + 1, 1, 1]);
        break;
      case "wide":
        eye.push([ex - (i === 0 ? 1 : 0), eyeY, 2, 2]);
        break;
      case "squint":
        // > <
        if (i === 0) eye.push([ex - 1, eyeY - 1, 1, 1], [ex, eyeY, 1, 1], [ex - 1, eyeY + 1, 1, 1]);
        else eye.push([ex + 1, eyeY - 1, 1, 1], [ex, eyeY, 1, 1], [ex + 1, eyeY + 1, 1, 1]);
        break;
      case "dizzy":
        eye.push(
          [ex - 1, eyeY - 1, 1, 1],
          [ex + 1, eyeY - 1, 1, 1],
          [ex, eyeY, 1, 1],
          [ex - 1, eyeY + 1, 1, 1],
          [ex + 1, eyeY + 1, 1, 1],
        );
        break;
      case "open":
      default:
        eye.push([ex, eyeY, 1, 2]);
    }
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y, rw, rh] of body) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + rw);
    maxY = Math.max(maxY, y + rh);
  }
  return { body, eye, bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/**
 * Pinta la mascota con los pies en (fx, fy) (px CSS). `facing` = -1 la
 * refleja. Devuelve la caja ocupada en px CSS (para borrar solo esa zona).
 */
export function drawPet(
  ctx: CanvasRenderingContext2D,
  pose: Pose,
  fx: number,
  fy: number,
  scale: number,
  facing: 1 | -1,
): Box {
  const { body, eye, bbox } = spriteRects(pose);
  const px = (x: number, w: number) =>
    facing === 1 ? fx + x * scale : fx - (x + w) * scale;
  const paint = (rects: R[], color: string) => {
    ctx.fillStyle = color;
    for (const [x, y, w, h] of rects) {
      ctx.fillRect(Math.round(px(x, w)), Math.round(fy + y * scale), w * scale, h * scale);
    }
  };
  paint(body, COLORS.body);
  paint(eye, COLORS.eye);
  const bx = facing === 1 ? fx + bbox.x * scale : fx - (bbox.x + bbox.w) * scale;
  return { x: bx, y: fy + bbox.y * scale, w: bbox.w * scale, h: bbox.h * scale };
}

/** Estrellita de 3×3 (mareo). */
export function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.fillStyle = COLORS.star;
  ctx.fillRect(Math.round(x - s / 2), Math.round(y - 1.5 * s), s, 3 * s);
  ctx.fillRect(Math.round(x - 1.5 * s), Math.round(y - s / 2), 3 * s, s);
}

/** Letra Z en píxeles (dormir), 3×3. */
export function drawZ(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, alpha: number) {
  ctx.fillStyle = `rgba(230, 230, 240, ${alpha.toFixed(3)})`;
  const r = Math.round;
  ctx.fillRect(r(x), r(y), 3 * s, s);
  ctx.fillRect(r(x + s), r(y + s), s, s);
  ctx.fillRect(r(x), r(y + 2 * s), 3 * s, s);
}
