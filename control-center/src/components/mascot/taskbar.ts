// Mascota — la barra de tareas vista desde la webview (instantánea de
// `mascot_taskbar` / `mascot:taskbar`, px físicos). Funciones puras (con tests).
//
// La ventana de Pupus cubre el área de trabajo, no la barra: no puede
// pisarla. Señala desde el suelo, con una flecha en el borde inferior del
// lienzo justo encima del botón. Con la barra arriba o a un lado va al punto
// de suelo más cercano sin flecha; con la barra autoocultable no hay botón
// visible y se devuelve el motivo.
//
// Con el ajuste `taskbar_islands` (barra transparente) la ventana baja hasta
// el borde de la pantalla y las islas son plataformas (islandRects): señala
// de pie sobre la isla, justo encima del botón y sin flecha.

type Rect = [number, number, number, number];

export interface TaskbarBar {
  hwnd: number;
  primary: boolean;
  rect: Rect;
  monitor: Rect;
  edge: "bottom" | "top" | "left" | "right";
  auto_hidden: boolean;
}

export interface TaskbarButton {
  app_id: string;
  label: string;
  windows: number;
  pinned: boolean;
  rect: Rect;
  bar: number;
}

/** Zona visible de una barra transparente (taskbar_islands.rs), px físicos. */
export interface TaskbarIsland {
  bar: number;
  rect: Rect;
}

export interface TaskbarSnapshot {
  version: number;
  taken_ms: number;
  bars: TaskbarBar[];
  buttons: TaskbarButton[];
  /** Ausente en un backend anterior al 2026-10-27. */
  islands?: TaskbarIsland[];
}

/** Rectángulos físicos de las islas de las barras de abajo (sin autoocultar). */
export function islandRects(snap: TaskbarSnapshot | null): Rect[] {
  if (!snap?.islands) return [];
  return snap.islands
    .filter((i) => snap.bars.some((b) => b.hwnd === i.bar && b.edge === "bottom" && !b.auto_hidden))
    .map((i) => i.rect);
}

/** Isla de la barra del botón que lo contiene (por su centro). */
export function islandOf(snap: TaskbarSnapshot | null, button: TaskbarButton): Rect | null {
  const cx = (button.rect[0] + button.rect[2]) / 2;
  const hit = snap?.islands?.find((i) => i.bar === button.bar && cx >= i.rect[0] && cx < i.rect[2]);
  return hit ? hit.rect : null;
}

export interface ButtonQuery {
  appId?: string;
  label?: string;
}

export type PointResult = "ok" | "sin-boton" | "barra-oculta" | "silencio" | "desactivado";

/** Sin mayúsculas ni tildes: «Configuración» = «configuracion». */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

const byAppId = (b: TaskbarButton, q: ButtonQuery) => !!q.appId && fold(b.app_id) === fold(q.appId);
const byLabel = (b: TaskbarButton, q: ButtonQuery) => !!q.label && fold(b.label) === fold(q.label);

const contains = (r: Rect, x: number, y: number) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

/**
 * Botón que busca la consulta: por AppId y, solo si ninguno coincide, por
 * etiqueta (Sessions y el Control Center son el mismo exe y sus botones se
 * llaman igual). Si se repite en varias barras, el de la barra del monitor
 * de Pupus (`here`, punto físico); si no, el de la principal; si no, el
 * primero.
 */
export function findButton(
  snap: TaskbarSnapshot | null,
  q: ButtonQuery,
  here: { x: number; y: number } | null,
): { button: TaskbarButton; bar: TaskbarBar } | null {
  if (!snap) return null;
  const match = snap.buttons.some((b) => byAppId(b, q)) ? byAppId : byLabel;
  const found = snap.buttons
    .filter((b) => match(b, q))
    .map((button) => ({ button, bar: snap.bars.find((r) => r.hwnd === button.bar) }))
    .filter((c): c is { button: TaskbarButton; bar: TaskbarBar } => !!c.bar);
  if (!found.length) return null;
  const mine = here ? found.find((c) => contains(c.bar.monitor, here.x, here.y)) : undefined;
  return mine ?? found.find((c) => c.bar.primary) ?? found[0];
}

export type FloorTarget =
  | { ok: true; x: number; y: number; arrowX: number | null }
  | { ok: false; reason: "barra-oculta" };

/**
 * Punto físico del suelo desde el que señalar el botón. `arrowX` = x física
 * de la flecha (solo con la barra abajo, la única que queda bajo el lienzo).
 * Con `island` (modo islas) se pone de pie sobre ella, encima del botón.
 */
export function floorTarget(button: TaskbarButton, bar: TaskbarBar, island: Rect | null = null): FloorTarget {
  if (bar.auto_hidden) return { ok: false, reason: "barra-oculta" };
  const cx = Math.round((button.rect[0] + button.rect[2]) / 2);
  if (island && bar.edge === "bottom") return { ok: true, x: cx, y: island[1] - 1, arrowX: null };
  const floorY = bar.monitor[3] - 1;
  switch (bar.edge) {
    case "bottom":
      return { ok: true, x: cx, y: bar.rect[1] - 1, arrowX: cx };
    case "top":
      return { ok: true, x: cx, y: floorY, arrowX: null };
    case "left":
      return { ok: true, x: bar.rect[2] + 1, y: floorY, arrowX: null };
    case "right":
      return { ok: true, x: bar.rect[0] - 2, y: floorY, arrowX: null };
  }
}
