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

/** Una acción del catálogo, sin la mano que la ejecuta. */
export type FichaAccionChat = Omit<AccionChat, "run">;

/**
 * EL catálogo. Id, etiqueta y para qué sirve, sin nada que ejecutar.
 *
 * Vive aquí y no dentro de `MariaChat` (2026-09-22) porque desde que hay
 * editor de atajos hay un segundo lector: la pestaña «Atajos» de Ajustes tiene
 * que poner nombre en castellano a `chat.nueva` SIN que el chat esté montado —
 * y si esas etiquetas se copiaran allí, al cambiar una quedaría la vieja en la
 * otra pantalla. `MariaChat` le pega el `run` a cada ficha y publica la lista;
 * Ajustes solo lee.
 *
 * Los combos NO están aquí: los sirve `get_in_app_shortcuts` (Rust), que es
 * donde el usuario puede cambiarlos.
 */
export const ACCIONES_CHAT: readonly FichaAccionChat[] = [
  { id: "chat.nueva", label: "Chat · conversación nueva" },
  {
    id: "chat.parar",
    label: "Chat · parar la respuesta",
    descripcion: "Se conserva lo que el proveedor ya hubiera escrito.",
  },
  { id: "chat.regenerar", label: "Chat · pedir otra vez la última respuesta" },
  { id: "chat.exportar", label: "Chat · exportar la conversación a Markdown" },
  {
    id: "chat.deshacer",
    label: "Chat · volver al último punto de control (código)",
    descripcion:
      "Devuelve la carpeta del proyecto a como estaba antes de la última respuesta. Pide confirmación.",
  },
  {
    id: "chat.panel.cambios",
    label: "Chat · abrir el panel de cambios",
    descripcion: "El git diff del proyecto de esta conversación.",
  },
  { id: "chat.panel.ficheros", label: "Chat · abrir el panel de ficheros" },
  { id: "chat.panel.web", label: "Chat · abrir la vista previa web" },
  {
    id: "chat.ramas",
    label: "Chat · ver las ramas de la conversación",
    descripcion: "Lo que quedó atrás al editar un mensaje o regenerar.",
  },
  {
    id: "chat.auto",
    label: "Chat · que vuelva a decidir mar.ia",
    descripcion: "Suelta el proveedor, el modelo y el esfuerzo fijados a mano.",
  },
  {
    id: "chat.delegar",
    label: "Chat · delegar en un proveedor…",
    descripcion: "Deja «/delegar » escrito para elegir a quién y qué.",
  },
];

/** Etiqueta de una acción del chat por su id, o null si no es del chat. Lo usa
 *  el editor de atajos, que recibe ids sueltos de Rust. */
export function etiquetaAccionChat(id: string): string | null {
  return ACCIONES_CHAT.find((a) => a.id === id)?.label ?? null;
}

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
