// mar.ia — lo que se puede hacer en el chat sin tocar el ratón.
//
// Parte PURA: el catálogo de acciones, la precedencia de Escape y la regla de
// qué combinación puede dispararse con el foco dentro de una caja de texto.
// Sin React ni Tauri, para poder probarla sin montar nada.
//
// Por qué existe (2026-09-22): había DOS listas que se pisaban. La paleta
// (`CommandPalette.tsx`) no tenía ni una acción de la pantalla que más se usa,
// y `in_app_shortcuts::default_bindings` se quedaba en saltos de pestaña que
// además App.tsx suprime mientras se escribe — o sea, el 100 % del tiempo que
// uno pasa en el chat. Ahora es UNA lista: `MariaChat` la publica cuando está
// montado y App la expone a la vez por la paleta y por los atajos.
//
// Los combos NO viven aquí: los sirve `get_in_app_shortcuts` (Rust), que es
// donde el usuario puede cambiarlos. Tener un segundo juego de valores por
// defecto en TypeScript sería pedir que se separen.

/** Una acción del chat, tal y como la publica `MariaChat`. */
export type AccionChat = {
  /** Clave de atajo, igual que en `in_app_shortcuts::default_bindings`. */
  id: string;
  label: string;
  descripcion?: string;
  run: () => void;
};

/** Ids con combinación por defecto en Rust. Lista de referencia para los tests
 *  y para saber de un vistazo qué acciones son también atajo. */
export const ACCIONES_CON_ATAJO = [
  "chat.nueva",
  "chat.parar",
  "chat.regenerar",
  "chat.exportar",
  "chat.panel.cambios",
  "chat.panel.ficheros",
  "chat.panel.web",
] as const;

/** Lo que hace Escape en el chat, en orden de precedencia. */
export type QueHaceEscape = "cerrar-sugerencias" | "parar" | "nada";

/**
 * Precedencia de Escape, explícita y en un solo sitio.
 *
 * Escape ya hacía algo dentro de la caja (cerrar el menú de comandos), así que
 * darle además «para la respuesta» no puede dejarse al orden de los `if`:
 *
 *   1. hay sugerencias abiertas  -> se cierran (y lo escrito SE CONSERVA; antes
 *      `setPrompt("")` se llevaba por delante el mensaje entero).
 *   2. no las hay y hay un turno en curso -> se para.
 *   3. ninguna de las dos -> nada. Escape no puede hacer daño por si acaso.
 */
export function decidirEscape(estado: {
  sugerenciasAbiertas: boolean;
  turnoEnCurso: boolean;
}): QueHaceEscape {
  if (estado.sugerenciasAbiertas) return "cerrar-sugerencias";
  if (estado.turnoEnCurso) return "parar";
  return "nada";
}

/**
 * ¿Puede dispararse esta combinación con el foco dentro de una caja de texto?
 *
 * Solo con modificador (Alt/Ctrl/Meta) o si es una tecla que no escribe nada
 * (Escape, F1…F12). El chat se usa escribiendo: un atajo de una sola letra se
 * comería el teclado. Si el usuario configura uno así, se respeta el fichero
 * pero no se le roba la tecla mientras teclea.
 */
export function seDisparaEscribiendo(combo: string): boolean {
  const partes = combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (partes.length === 0) return false;
  const conModificador = partes.some((p) =>
    ["ctrl", "control", "alt", "option", "meta", "super", "win", "cmd"].includes(p),
  );
  if (conModificador) return true;
  const tecla = partes[partes.length - 1];
  return tecla === "escape" || /^f([1-9]|1[0-2])$/.test(tecla);
}
