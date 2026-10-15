// Mascota — sprite en pixel art dibujado por código.
//
// El cuerpo se compone de rectángulos en «píxeles de sprite» (cada uno se
// pinta como un cuadrado de `scale` píxeles de dispositivo). Dibujarlo por
// piezas en vez de usar hojas de sprites permite combinar poses (brazos,
// piernas, ojos, cejas, aplastamiento) sin dibujar cada fotograma a mano.
//
// Proporciones de Clawd, la mascota de Claude Code, sacadas píxel a píxel
// del logo de bloques que pinta la CLI (`▐▛███▜▌` / `▝▜█████▛▘` / `▘▘ ▝▝`):
// cada cuadrante de bloque es un píxel el doble de alto que ancho, así que
// en píxeles cuadrados queda un cuerpo de 12×8, ojos de 1×2 en las columnas
// 2 y 9 (filas 2-3), brazos de 2×2 a media altura (filas 4-5) y cuatro patas
// de 1×2 en las columnas 1, 3, 8 y 10.
//
// Fluidez: la forma va en píxeles de sprite (es pixel art), pero el
// desplazamiento vertical (`lift` = salto/bote, `breath` = respiración) se
// pinta en píxeles de DISPOSITIVO, así que sube y baja de forma continua.
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
  blush: "rgba(255, 128, 150, 0.85)",
  heartEye: "#E5484D",
  pin: "#E5484D",
  pinShade: "#A2282C",
  line: "#9A9A9A",
  star: "#F5C451",
};

export type Eyes =
  | "open"
  | "blink"
  | "happy"
  | "dizzy"
  | "wide"
  | "closed"
  | "squint"
  | "sleepy"
  | "heart";
export type Brows = "none" | "sad" | "angry" | "up";
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
  | "cross"
  | "none";
export type Legs = "stand" | "walk1" | "walk2" | "dangle" | "tuck" | "spread" | "run1" | "run2" | "none";

export interface Pose {
  /** Aplastamiento horizontal / vertical del cuerpo (1 = normal). */
  sx: number;
  sy: number;
  eyes: Eyes;
  brows: Brows;
  blush: boolean;
  /** Dirección de la mirada, -1..1 en cada eje. */
  lookX: number;
  lookY: number;
  armL: Arm;
  armR: Arm;
  legs: Legs;
  /** Desplazamiento horizontal de las piernas (balanceo al colgar), en px de sprite. */
  legSwing: number;
  /** Desplazamiento del cuerpo entero, en px de sprite (se redondea). */
  dx: number;
  dy: number;
  /** Elevación de TODO el sprite (saltitos), px de sprite, continua. */
  lift: number;
  /** Elevación solo del cuerpo (respiración), px de sprite, continua (≤ 0.9). */
  breath: number;
}

export const BASE_POSE: Pose = {
  sx: 1,
  sy: 1,
  eyes: "open",
  brows: "none",
  blush: false,
  lookX: 0,
  lookY: 0,
  armL: "out",
  armR: "out",
  legs: "stand",
  legSwing: 0,
  dx: 0,
  dy: 0,
  lift: 0,
  breath: 0,
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
  // Brazos cruzados (enfado/celos): pegados al cuerpo, un poco más altos.
  cross: [[-1, 3, 1, 3]],
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

export interface SpriteParts {
  body: R[];
  legs: R[];
  eye: R[];
  blush: R[];
  hearts: R[];
  bbox: Box;
}

/** Rectángulos que forman la mascota, en píxeles de sprite, por capa. */
export function spriteRects(p: Pose): SpriteParts {
  const { w, h } = bodyDims(p);
  const legsL = legLayout(p);
  const dx = Math.round(p.dx);
  const dy = Math.round(p.dy);
  const left = -w / 2 + dx;
  const bottom = -legsL.height + dy;
  const top = bottom - h;

  // Clawd es de un solo color plano: cuerpo, brazos y patas.
  const body: R[] = [[left, top, w, h]];
  // Las patas se meten 1 px dentro del cuerpo: así la respiración (que sube
  // solo el cuerpo) nunca deja un hueco entre cuerpo y patas.
  const legs: R[] = legsL.rects.map(([x, y, lw, lh]) => [x + dx, y + dy - 1, lw, lh + 1] as R);

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
  const blush: R[] = [];
  const hearts: R[] = [];
  const lx = Math.max(-1, Math.min(1, Math.round(p.lookX)));
  const ly = Math.max(-1, Math.min(1, Math.round(p.lookY)));
  const eyeY = top + Math.max(1, Math.min(h - 3, Math.round(2 * Math.min(1, h / BODY_H)) + ly));
  const inset = Math.max(1, Math.min(3, Math.round(w / 6)));
  const centers = [left + inset + lx, left + w - inset - 1 + lx];
  centers.forEach((ex, i) => {
    const outer = i === 0 ? -1 : 1; // hacia el borde del cuerpo
    switch (p.eyes) {
      case "blink":
      case "sleepy":
        eye.push([ex, eyeY + 1, 1, 1]);
        break;
      case "closed":
        eye.push([ex - (i === 0 ? 1 : 0), eyeY + 1, 2, 1]);
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
      case "heart":
        // Corazoncito rojo de 3×3 (enamorada).
        hearts.push([ex - 1, eyeY - 1, 1, 1], [ex + 1, eyeY - 1, 1, 1], [ex - 1, eyeY, 3, 1], [ex, eyeY + 1, 1, 1]);
        break;
      case "open":
      default:
        eye.push([ex, eyeY, 1, 2]);
    }
    // Cejas: 2 píxeles en diagonal sobre cada ojo.
    const by = eyeY - 1;
    if (by > top - 1) {
      if (p.brows === "angry") {
        // Interior abajo: \ /
        eye.push([ex - outer, by - 1, 1, 1], [ex, by, 1, 1]);
      } else if (p.brows === "sad") {
        // Exterior abajo: / \
        eye.push([ex - outer, by, 1, 1], [ex, by - 1, 1, 1]);
      } else if (p.brows === "up") {
        eye.push([ex - 1, by - 1, 3, 1]);
      }
    }
    if (p.blush) blush.push([ex + outer - (outer < 0 ? 1 : 0), eyeY + 2, 2, 1]);
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y, rw, rh] of [...body, ...legs]) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + rw);
    maxY = Math.max(maxY, y + rh);
  }
  return { body, legs, eye, blush, hearts, bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/**
 * Pinta la mascota con los pies en (fx, fy) (px de dispositivo). `facing` =
 * -1 la refleja. Devuelve la caja ocupada (para borrar solo esa zona).
 */
export function drawPet(
  ctx: CanvasRenderingContext2D,
  pose: Pose,
  fx: number,
  fy: number,
  scale: number,
  facing: 1 | -1,
  color: string = COLORS.body,
): Box {
  const { body, legs, eye, blush, hearts, bbox } = spriteRects(pose);
  const liftPx = Math.round(pose.lift * scale);
  const breathPx = Math.round(Math.min(0.9, Math.max(-0.9, pose.breath)) * scale);
  const px = (x: number, w: number) => (facing === 1 ? fx + x * scale : fx - (x + w) * scale);
  const paint = (rects: R[], fill: string, up: number) => {
    ctx.fillStyle = fill;
    for (const [x, y, w, h] of rects) {
      ctx.fillRect(Math.round(px(x, w)), Math.round(fy + y * scale - up), w * scale, h * scale);
    }
  };
  paint(legs, color, liftPx);
  paint(body, color, liftPx + breathPx);
  paint(blush, COLORS.blush, liftPx + breathPx);
  paint(eye, COLORS.eye, liftPx + breathPx);
  paint(hearts, COLORS.heartEye, liftPx + breathPx);
  const bx = facing === 1 ? fx + bbox.x * scale : fx - (bbox.x + bbox.w) * scale;
  const up = liftPx + Math.max(0, breathPx);
  return { x: bx, y: fy + bbox.y * scale - up, w: bbox.w * scale, h: bbox.h * scale + up + Math.abs(breathPx) };
}

/** Estrellita de 3×3 (mareo, chispas). */
export function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color = COLORS.star) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x - s / 2), Math.round(y - 1.5 * s), s, 3 * s);
  ctx.fillRect(Math.round(x - 1.5 * s), Math.round(y - s / 2), 3 * s, s);
}

/** Letra Z en píxeles (dormir), 5×5: con menos, la diagonal se lee como una I. */
export function drawZ(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, alpha: number) {
  ctx.fillStyle = `rgba(230, 230, 240, ${alpha.toFixed(3)})`;
  const r = Math.round;
  ctx.fillRect(r(x), r(y), 5 * s, s);
  for (let i = 1; i <= 3; i++) ctx.fillRect(r(x + (4 - i) * s), r(y + i * s), s, s);
  ctx.fillRect(r(x), r(y + 4 * s), 5 * s, s);
}

// ---------------------------------------------------------------------------
// Iconos de emoción (encima de la cabeza) y partículas con forma.
// ---------------------------------------------------------------------------

export type Glyph = "heart" | "anger" | "exclaim" | "question" | "note" | "cloud" | "puff" | "sweat" | "spark";

const GLYPHS: Record<Glyph, { rows: string[]; color: string }> = {
  heart: { rows: [".X.X.", "XXXXX", "XXXXX", ".XXX.", "..X.."], color: "#FF5A7A" },
  anger: { rows: ["XX.XX", "X...X", ".....", "X...X", "XX.XX"], color: "#E5484D" },
  exclaim: { rows: ["X", "X", "X", ".", "X"], color: "#FFD34D" },
  question: { rows: ["XXX.", "...X", ".XX.", "....", ".X.."], color: "#FFFFFF" },
  note: { rows: ["..XXX", "..X.X", "..X..", "XXX..", "XX..."], color: "#FFE9A8" },
  cloud: { rows: [".XXX.", "XXXXX", "XXXXX", ".X.X.", "X.X.."], color: "#9AA4B5" },
  puff: { rows: [".XX..", "XXXX.", ".XXXX", "..XX."], color: "#E8E8EE" },
  sweat: { rows: [".X.", "XXX", "XXX", ".X."], color: "#7CC8FF" },
  spark: { rows: [".X.", "XXX", ".X."], color: "#FFF3B0" },
};

/** Pinta un icono centrado en (cx, cy). Devuelve su caja. */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: Glyph,
  cx: number,
  cy: number,
  s: number,
  alpha = 1,
  color?: string,
): Box {
  const g = GLYPHS[glyph];
  const h = g.rows.length;
  const w = Math.max(...g.rows.map((r) => r.length));
  const x0 = Math.round(cx - (w * s) / 2);
  const y0 = Math.round(cy - (h * s) / 2);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  // Contorno oscuro de 1 px de dispositivo para que se lea sobre cualquier fondo.
  ctx.fillStyle = "rgba(20, 20, 19, 0.55)";
  g.rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] === "X") ctx.fillRect(x0 + rx * s - 1, y0 + ry * s - 1, s + 2, s + 2);
    }
  });
  ctx.fillStyle = color ?? g.color;
  g.rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] === "X") ctx.fillRect(x0 + rx * s, y0 + ry * s, s, s);
    }
  });
  ctx.globalAlpha = 1;
  return { x: x0 - 2, y: y0 - 2, w: w * s + 4, h: h * s + 4 };
}
