// mar.ia — estado del mosaico (parte pura).
//
// Colocacion de paneles, reordenado por arrastre y persistencia. Sin React ni
// Tauri para poder probarlo: el arrastre es justo donde un off-by-one se nota
// (el panel aterriza una casilla antes) y eso hay que poder testearlo.

/** Lo que puede haber dentro de un panel. */
export type TipoPanel = "chat" | "terminal" | "conversaciones";

export type Panel = {
  /** Identidad estable del panel: sobrevive al reordenado para que React no
   *  remonte el xterm cada vez que se arrastra algo. */
  key: string;
  tipo: TipoPanel;
  /** Conversacion (chat) o sesion de PTY (terminal). Vacio = sin elegir. */
  ref: string;
};

export type Disposicion = {
  columnas: number;
  paneles: Panel[];
};

export const MAX_PANELES = 6;
export const MIN_COLUMNAS = 1;
export const MAX_COLUMNAS = 3;

export const ETIQUETA: Record<TipoPanel, string> = {
  chat: "chat",
  terminal: "terminal",
  conversaciones: "conversaciones",
};

/** Disposicion inicial: un chat y una terminal, en dos columnas. */
export function disposicionPorDefecto(): Disposicion {
  return {
    columnas: 2,
    paneles: [
      { key: "p1", tipo: "chat", ref: "" },
      { key: "p2", tipo: "terminal", ref: "" },
    ],
  };
}

let contador = 0;

/** Clave nueva, unica dentro de la sesion. */
export function nuevaClave(existentes: Panel[]): string {
  contador += 1;
  let k = `p${contador}`;
  while (existentes.some((p) => p.key === k)) {
    contador += 1;
    k = `p${contador}`;
  }
  return k;
}

/** Anade un panel al final. Devuelve la misma disposicion si ya esta llena:
 *  mas de seis paneles en una pantalla no se leen, se adivinan. */
export function anadir(d: Disposicion, tipo: TipoPanel): Disposicion {
  if (d.paneles.length >= MAX_PANELES) return d;
  return {
    ...d,
    paneles: [...d.paneles, { key: nuevaClave(d.paneles), tipo, ref: "" }],
  };
}

/** Quita un panel por clave. */
export function quitar(d: Disposicion, key: string): Disposicion {
  return { ...d, paneles: d.paneles.filter((p) => p.key !== key) };
}

/** Guarda la referencia (conversacion o sesion) de un panel. */
export function fijarRef(d: Disposicion, key: string, ref: string): Disposicion {
  return {
    ...d,
    paneles: d.paneles.map((p) => (p.key === key ? { ...p, ref } : p)),
  };
}

/**
 * Mueve el panel `desde` a la posicion de `hasta` (arrastrar y soltar).
 *
 * Es un MOVIMIENTO, no un intercambio: al soltar entre dos paneles, el resto
 * se desplaza, que es lo que espera cualquiera que haya arrastrado una pestana
 * antes. Con un intercambio, arrastrar el primero al final mandaba el ultimo
 * al principio sin que nadie lo pidiera.
 */
export function mover(d: Disposicion, desde: string, hasta: string): Disposicion {
  if (desde === hasta) return d;
  const i = d.paneles.findIndex((p) => p.key === desde);
  const j = d.paneles.findIndex((p) => p.key === hasta);
  if (i === -1 || j === -1) return d;
  const paneles = [...d.paneles];
  const [movido] = paneles.splice(i, 1);
  paneles.splice(j, 0, movido);
  return { ...d, paneles };
}

/** Cambia el numero de columnas, dentro de los limites. */
export function fijarColumnas(d: Disposicion, n: number): Disposicion {
  const columnas = Math.min(MAX_COLUMNAS, Math.max(MIN_COLUMNAS, Math.round(n)));
  return { ...d, columnas };
}

const CLAVE = "maria.mosaico.v1";

/** Lee la disposicion guardada. Cualquier cosa rara -> la de por defecto:
 *  un localStorage corrupto no puede dejar la pestana en blanco. */
export function cargar(almacen: Pick<Storage, "getItem"> | null): Disposicion {
  try {
    const raw = almacen?.getItem(CLAVE);
    if (!raw) return disposicionPorDefecto();
    const d = JSON.parse(raw) as Disposicion;
    if (!d || !Array.isArray(d.paneles) || d.paneles.length === 0) {
      return disposicionPorDefecto();
    }
    const paneles = d.paneles
      .filter((p) => p && typeof p.key === "string" && p.tipo in ETIQUETA)
      .slice(0, MAX_PANELES)
      .map((p) => ({ key: p.key, tipo: p.tipo, ref: typeof p.ref === "string" ? p.ref : "" }));
    if (paneles.length === 0) return disposicionPorDefecto();
    return fijarColumnas({ columnas: d.columnas ?? 2, paneles }, d.columnas ?? 2);
  } catch {
    return disposicionPorDefecto();
  }
}

export function guardar(almacen: Pick<Storage, "setItem"> | null, d: Disposicion): void {
  try {
    almacen?.setItem(CLAVE, JSON.stringify(d));
  } catch {
    // Sin almacenamiento (modo privado) el mosaico funciona igual, solo que
    // no se recuerda entre arranques.
  }
}
