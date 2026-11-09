// Terminal del bloque de menú (decisión del 2026-10-13, opción 2): el PTY se
// redimensiona al tamaño de la vista mientras el menú está abierto y vuelve
// al de lanzamiento al cerrarlo. La TUI responde a cada cambio de tamaño con
// un repintado completo (`ESC[2J` + pantalla entera, captura
// `fixtures/tui/mcp-resize.ans`), así que la vista no depende de la parte del
// búfer de 256 KB que se haya perdido.

import type { Terminal } from "@xterm/xterm";
import type { SesionesApi } from "../../api";

export const MENU_FONT = "\"Cascadia Mono\", Consolas, monospace";
export const MENU_FONT_SIZE = 12;
/** Tamaño de la vista cuando no se puede medir (sin maquetación: tests, vista oculta). */
export const MENU_FALLBACK = { cols: 100, rows: 20 } as const;
// Mínimos de seguridad, no de legibilidad: con un mínimo mayor que el ancho
// del panel, la TUI pintaba columnas que `overflow: hidden` recortaba.
const MIN_COLS = 20;
const MAX_COLS = 240;
const MIN_ROWS = 8;
const MAX_ROWS = 48;

export interface Geometry {
  cols: number;
  rows: number;
}

export interface CellSize {
  width: number;
  height: number;
}

/** Columnas y filas que caben en `width` x `height` px; sin medida, `MENU_FALLBACK`. */
export function menuGeometry(width: number, height: number, cell: CellSize | null): Geometry {
  if (!cell || cell.width <= 0 || cell.height <= 0 || width <= 0 || height <= 0) return { ...MENU_FALLBACK };
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)));
  return { cols: clamp(width / cell.width, MIN_COLS, MAX_COLS), rows: clamp(height / cell.height, MIN_ROWS, MAX_ROWS) };
}

/**
 * Celda de la fuente del menú medida en `host`; `null` sin maquetación. El
 * `line-height: normal` es el de la medida del propio xterm: sin él, la
 * sonda heredaba el `1.55` del body, la celda salía un 30 % más alta que la
 * real y sobraba una franja negra bajo la TUI.
 */
function measureCell(host: HTMLElement): CellSize | null {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;line-height:normal;font-family:${MENU_FONT};font-size:${MENU_FONT_SIZE}px`;
  probe.textContent = "W".repeat(32);
  host.appendChild(probe);
  const box = probe.getBoundingClientRect();
  probe.remove();
  return box.width > 0 && box.height > 0 ? { width: box.width / 32, height: box.height } : null;
}

/** Geometría del área útil de `host` (sin su relleno). */
export function hostGeometry(host: HTMLElement): Geometry {
  const css = getComputedStyle(host);
  const padX = (parseFloat(css.paddingLeft) || 0) + (parseFloat(css.paddingRight) || 0);
  const padY = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0);
  return menuGeometry(host.clientWidth - padX, host.clientHeight - padY, measureCell(host));
}

/** Filas de la vista hasta la última con texto (0 si la pantalla está vacía). */
export function usedRows(term: Pick<Terminal, "rows" | "buffer">): number {
  const buf = term.buffer.active;
  for (let y = term.rows - 1; y >= 0; y -= 1) {
    if (buf.getLine(buf.viewportY + y)?.translateToString(true).trim()) return y + 1;
  }
  return 0;
}

/**
 * Alto visible de la vista: lo pintado más dos filas de aire, con un mínimo de
 * `MIN_ROWS` y sin pasar de las filas reales. El PTY conserva su tamaño: solo
 * se recorta la franja vacía de debajo (menús de 3 o 4 opciones).
 */
export function menuClipHeight(used: number, rows: number, cellHeight: number, padY: number): number {
  const visible = Math.min(rows, Math.max(MIN_ROWS, used + 2));
  return Math.ceil(visible * cellHeight + padY);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export interface MenuLink {
  /** Cambia la vista y el PTY de tamaño (sin efecto si no cambia o ya se cerró). */
  resize(next: Geometry): void;
  /** Devuelve el PTY a su tamaño de lanzamiento y suelta la emisión. */
  close(): void;
}

type MenuApi = Pick<SesionesApi, "terminalResize" | "terminalRestoreSize" | "terminalAttach" | "terminalDetach" | "onPty">;

/**
 * Cola y propietario por sesión, compartidos entre montajes: `terminalDetach`
 * y el tamaño del PTY son de toda la sesión, no de una vista. Sin esto, el
 * cierre de una vista desmontada con un resize en vuelo llegaba después del
 * `attach` de la vista nueva y la desconectaba y encogía.
 */
interface SessionLane {
  chain: Promise<unknown>;
  owner: symbol | null;
}

const lanes = new Map<string, SessionLane>();

function laneOf(id: string): SessionLane {
  const found = lanes.get(id);
  if (found) return found;
  const lane: SessionLane = { chain: Promise.resolve(), owner: null };
  lanes.set(id, lane);
  return lane;
}

/**
 * Restaura el tamaño y después suelta la emisión: soltarla quita la pausa de
 * la cola, y el primer envío no debe llegar con el PTY aún al tamaño del
 * menú. La emisión se suelta aunque la restauración falle (la cola quedaría
 * en pausa); los dos errores se notifican.
 */
export async function restoreAndDetach(api: MenuApi, id: string, onError: (e: unknown) => void): Promise<void> {
  await api.terminalRestoreSize(id).catch(onError);
  await api.terminalDetach(id);
}

/**
 * Engancha `term` al PTY de `id` con el tamaño `geom`. Las llamadas al PTY de
 * todas las vistas de la sesión van en serie: la restauración del cierre nunca
 * adelanta a un resize en vuelo. Solo la última vista montada es propietaria:
 * las operaciones pendientes de una vista anterior (resize, detach y
 * restauración) se descartan.
 *
 * Antes de escuchar se suelta la emisión: si seguía enganchada (cierre de una
 * vista anterior descartado, página recargada), los bloques que llegaban entre
 * la escucha y el `attach` iban en el búfer y también en vivo, y se escribían
 * dos veces. Sin emisión, el `attach` copia el búfer y la enciende bajo el
 * mismo lock: lo que llega en vivo antes de su respuesta es posterior al
 * búfer y se escribe detrás de él, en orden.
 */
export function linkMenuTerminal(api: MenuApi, id: string, term: Terminal, geom: Geometry, onError: (e: unknown) => void): { link: MenuLink; ready: Promise<void> } {
  const lane = laneOf(id);
  const token = Symbol(id);
  lane.owner = token;
  const isOwner = () => lane.owner === token;
  const inOrder = (fn: () => Promise<unknown>) => (lane.chain = lane.chain.then(() => (isOwner() ? fn() : undefined)).catch(onError));
  let current = geom;
  let closed = false;
  let unlisten: (() => void) | null = null;
  const pending: Uint8Array[] = [];
  let live = false;
  // Recarga o cierre de la página: el cleanup de React no corre (el backend
  // también lo cubre al cargar la página y al cerrar la última ventana).
  const onPageHide = () => {
    if (!closed && isOwner()) void restoreAndDetach(api, id, onError).catch(onError);
  };
  window.addEventListener("pagehide", onPageHide);
  inOrder(() => api.terminalResize({ id, ...geom }));
  inOrder(() => api.terminalDetach(id));
  const ready = inOrder(async () => {
    const off = await api.onPty(id, (chunk) => {
      if (closed) return;
      if (live) term.write(base64ToBytes(chunk));
      else pending.push(base64ToBytes(chunk));
    });
    if (closed) return off();
    unlisten = off;
    const buffer = await api.terminalAttach(id);
    if (closed) return;
    if (buffer) term.write(base64ToBytes(buffer));
    pending.splice(0).forEach((c) => term.write(c));
    live = true;
  }).then(() => undefined);
  const link: MenuLink = {
    resize(next) {
      if (closed || (next.cols === current.cols && next.rows === current.rows)) return;
      current = next;
      term.resize(next.cols, next.rows);
      inOrder(() => api.terminalResize({ id, ...next }));
    },
    close() {
      closed = true;
      window.removeEventListener("pagehide", onPageHide);
      unlisten?.();
      unlisten = null;
      inOrder(async () => {
        lane.owner = null;
        try {
          await restoreAndDetach(api, id, onError);
        } finally {
          // Sin vista nueva entretanto, la cola de la sesión se olvida.
          if (lane.owner === null && lanes.get(id) === lane) lanes.delete(id);
        }
      });
    },
  };
  return { link, ready };
}

// ---------------------------------------------------------------------------
// Foco y teclado
// ---------------------------------------------------------------------------

/** Ventana en la que un menú que aparece cuenta como abierto por el usuario. */
export const MENU_INTENT_MS = 5000;
const intents = new Map<string, number>();

/** El usuario acaba de pedir un menú en `id` (p. ej. al enviar `/config`). */
export function markMenuIntent(id: string, now: number = Date.now()): void {
  intents.set(id, now);
}

/**
 * true si el usuario pidió un menú en `id` hace menos de `MENU_INTENT_MS`. No
 * la consume: el doble montaje de StrictMode la vería gastada en el segundo.
 */
export function hasMenuIntent(id: string, now: number = Date.now()): boolean {
  const at = intents.get(id);
  if (at === undefined) return false;
  if (now - at <= MENU_INTENT_MS) return true;
  intents.delete(id);
  return false;
}

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement) || el.closest(".menu-term")) return false;
  return el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT";
}

/**
 * El bloque de menú solo toma el foco si el usuario abrió el menú o si no
 * está escribiendo en otro campo: un diálogo que aparece solo no puede
 * llevarse las teclas del composer (un Enter elegiría la opción resaltada).
 */
export function shouldFocusMenu(requested: boolean, active: Element | null): boolean {
  return requested || !isEditable(active);
}

export interface MenuKeyActions {
  copy(text: string): void;
  closeMenu(): void;
}

/**
 * Ctrl+C del xterm: con selección copia y sin ella cierra el menú por la
 * recuperación (con sus guardas). Nunca llega crudo a la TUI, donde un
 * segundo ^C acaba en «Press Ctrl-C again to exit». Devuelve `false` si xterm
 * no debe procesar la tecla.
 */
export function menuKeyHandler(term: Pick<Terminal, "hasSelection" | "getSelection">, actions: MenuKeyActions): (ev: KeyboardEvent) => boolean {
  return (ev) => {
    const isCtrlC = ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === "c";
    if (!isCtrlC) return true;
    if (ev.type !== "keydown" || ev.repeat) return false;
    if (term.hasSelection()) actions.copy(term.getSelection());
    else actions.closeMenu();
    return false;
  };
}

/**
 * Engancha `menuKeyHandler` a `host` en fase de captura, antes que el
 * textarea de xterm: lo que rechaza no llega a xterm ni a la TUI. Devuelve la
 * función que lo suelta.
 */
export function bindMenuKeys(host: HTMLElement, term: Pick<Terminal, "hasSelection" | "getSelection">, actions: MenuKeyActions): () => void {
  const keys = menuKeyHandler(term, actions);
  const onKey = (ev: KeyboardEvent) => {
    if (keys(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
  };
  host.addEventListener("keydown", onKey, true);
  host.addEventListener("keyup", onKey, true);
  return () => {
    host.removeEventListener("keydown", onKey, true);
    host.removeEventListener("keyup", onKey, true);
  };
}
