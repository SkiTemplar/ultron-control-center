// Historial de lo que has enviado, para recuperarlo con ↑ / ↓.
//
// Lo pidió el usuario el 2026-09-21: "todo lo que tenga texto que lleve un
// registro de lo que he enviado, para poder darle a la flecha arriba y abajo y
// que se pongan esos mensajes". Es el comportamiento de cualquier terminal, y
// aquí faltaba en el chat y en la caja de órdenes.
//
// La parte de navegar es PURA y vive aquí, separada de React: un off-by-one en
// las flechas se nota enseguida (te salta un mensaje) y así se puede probar.
//
// El borrador se guarda al empezar a navegar: si subes, miras y vuelves abajo,
// recuperas lo que estabas escribiendo. Sin eso, asomarse al historial te
// borraría el mensaje a medias.

/** Tope de mensajes guardados. Suficiente para una sesión larga y no crece
 *  sin fin en el almacenamiento del navegador. */
export const MAX_HISTORIAL = 100;

export type Navegacion = {
  /** Índice en el historial; -1 = no estás navegando (estás en tu borrador). */
  indice: number;
  /** Lo que hay que poner en la caja. */
  texto: string;
  /** Borrador guardado mientras navegas. */
  borrador: string;
};

/** Estado de partida: escribiendo, sin navegar. */
export function inicio(borrador = ""): Navegacion {
  return { indice: -1, texto: borrador, borrador };
}

/**
 * Mueve por el historial.
 *
 * `historial` va del MÁS RECIENTE al más antiguo (índice 0 = el último que
 * enviaste), que es como se navega con ↑.
 *
 * `paso` = +1 para ↑ (hacia atrás en el tiempo), -1 para ↓.
 */
export function navegar(
  estado: Navegacion,
  historial: readonly string[],
  paso: 1 | -1,
  borradorActual: string,
): Navegacion {
  if (historial.length === 0) return estado;

  // Al empezar a navegar se guarda lo que estabas escribiendo.
  const borrador = estado.indice === -1 ? borradorActual : estado.borrador;
  const siguiente = estado.indice + paso;

  if (siguiente < 0) {
    // Has bajado por debajo del último: vuelves a tu borrador.
    return { indice: -1, texto: borrador, borrador };
  }
  if (siguiente >= historial.length) {
    // Tope arriba: te quedas en el más antiguo en vez de dar la vuelta.
    // Dar la vuelta sería peor: parecería que se ha borrado el historial.
    return { ...estado, borrador };
  }
  return { indice: siguiente, texto: historial[siguiente], borrador };
}

/**
 * Añade un mensaje enviado al historial. Devuelve el historial nuevo.
 *
 * - Lo vacío no se guarda.
 * - Repetir el mismo mensaje no lo duplica: lo sube al principio. Mandar
 *   "sí" cinco veces no puede dejarte cinco pulsaciones de ↑ para llegar al
 *   mensaje anterior.
 */
export function anadir(historial: readonly string[], mensaje: string): string[] {
  const limpio = mensaje.trim();
  if (!limpio) return [...historial];
  return [limpio, ...historial.filter((h) => h !== limpio)].slice(0, MAX_HISTORIAL);
}

/** Clave de almacenamiento por caja de texto. */
export function claveDe(nombre: string): string {
  return `maria.historial.${nombre}`;
}

/** Lee el historial guardado. Nunca lanza: sin almacenamiento, lista vacía. */
export function cargar(almacen: Storage | null, nombre: string): string[] {
  if (!almacen) return [];
  try {
    const crudo = almacen.getItem(claveDe(nombre));
    if (!crudo) return [];
    const v: unknown = JSON.parse(crudo);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Guarda el historial. Nunca lanza. */
export function guardar(almacen: Storage | null, nombre: string, historial: readonly string[]): void {
  if (!almacen) return;
  try {
    almacen.setItem(claveDe(nombre), JSON.stringify(historial.slice(0, MAX_HISTORIAL)));
  } catch {
    // Sin sitio o en modo privado: el historial es una comodidad, no puede
    // romper el envío de un mensaje.
  }
}
