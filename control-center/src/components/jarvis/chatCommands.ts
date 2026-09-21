// mar.ia — comandos de barra del chat.
//
// Parte PURA: catalogo, filtrado del autocompletado y parseo de la linea. Sin
// React ni Tauri, para poder probarla sin montar nada.
//
// Por que existe: el usuario pidio (2026-09-18) que al escribir "/" salgan
// sugerencias "al igual que en este chat", y que existan comandos para
// terminar la conversacion, migrarla a otro proveedor o dejar que mar.ia
// decida a quien asignarla.

/** Proveedores que pueden atender el chat. Mismo catalogo que el relevo. */
export const PROVIDERS = ["claude", "codex", "antigravity", "local"] as const;
export type Provider = (typeof PROVIDERS)[number];

export type SlashCommand = {
  /** Con barra incluida: "/cerrar". */
  name: string;
  /** Sugerencia de argumentos, vacio si no lleva. */
  args: string;
  desc: string;
};

export const COMMANDS: SlashCommand[] = [
  { name: "/nueva", args: "[carpeta]", desc: "empieza una conversación nueva" },
  { name: "/cerrar", args: "", desc: "cierra esta conversación y le pone título" },
  {
    name: "/migrar",
    args: "<claude|codex|antigravity|local>",
    desc: "manda lo que escribas a ese proveedor",
  },
  {
    name: "/delegar",
    args: "<claude|codex|antigravity|local> <encargo>",
    desc: "lanza un encargo en paralelo; el chat sigue libre y el resultado entra en el hilo",
  },
  { name: "/regenerar", args: "", desc: "vuelve a pedir la última respuesta" },
  { name: "/ramas", args: "", desc: "lo que dejaste atrás al editar o regenerar" },
  { name: "/rama", args: "<número>", desc: "vuelve a esa rama; la actual pasa a ser rama" },
  { name: "/proyecto", args: "[ruta]", desc: "trabaja sobre esa carpeta; sin ruta, ninguna" },
  { name: "/exportar", args: "", desc: "guarda la conversación en Markdown" },
  { name: "/cambios", args: "", desc: "abre el panel con el diff del proyecto" },
  { name: "/web", args: "[dirección]", desc: "abre el panel de vista previa web" },
  { name: "/ficheros", args: "", desc: "abre el panel con la carpeta de la conversación" },
  { name: "/analizar", args: "", desc: "vuelve a dejar que mar.ia elija proveedor y modelo" },
  { name: "/modelo", args: "<haiku|sonnet|opus|…>", desc: "fija el modelo concreto" },
  { name: "/esfuerzo", args: "<bajo|medio|alto>", desc: "fija cuanto debe pensar" },
  { name: "/fijar", args: "", desc: "fija o suelta esta conversación" },
  { name: "/titulo", args: "<texto>", desc: "renombra la conversación" },
  { name: "/carpeta", args: "<nombre>", desc: "mueve la conversación a una carpeta" },
  { name: "/proveedores", args: "", desc: "estado y cuota de cada proveedor" },
  { name: "/borrar", args: "", desc: "borra la conversación y sus turnos" },
  { name: "/ayuda", args: "", desc: "lista estos comandos" },
];

/**
 * Sugerencias para lo escrito hasta ahora.
 *
 * Devuelve lista vacia salvo que la linea EMPIECE por barra: un mensaje
 * normal que mencione "/tmp" no debe abrir el menu. Y con el comando ya
 * escrito entero y un espacio detras tampoco: ahi el usuario esta tecleando
 * el argumento, no eligiendo comando.
 */
export function suggestFor(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const [head, ...rest] = input.split(" ");
  if (rest.length > 0) {
    // Ya hay un espacio: solo seguimos mostrando la ficha del comando exacto
    // (como ayuda de argumentos), y nada si no existe.
    const exacto = COMMANDS.find((c) => c.name === head);
    return exacto && exacto.args ? [exacto] : [];
  }
  return COMMANDS.filter((c) => c.name.startsWith(head.toLowerCase()));
}

export type ParsedLine =
  | { kind: "message"; text: string }
  | { kind: "command"; name: string; arg: string }
  | { kind: "unknown"; name: string };

/** Parte la linea en mensaje normal o comando conocido. */
export function parseLine(raw: string): ParsedLine {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "message", text };
  const espacio = text.indexOf(" ");
  const name = (espacio === -1 ? text : text.slice(0, espacio)).toLowerCase();
  const arg = espacio === -1 ? "" : text.slice(espacio + 1).trim();
  if (!COMMANDS.some((c) => c.name === name)) return { kind: "unknown", name };
  return { kind: "command", name, arg };
}

/**
 * Valida el argumento de `/migrar`.
 *
 * Devuelve null si no es un proveedor del catalogo: forzar a un nombre
 * inventado dejaria el chat mandando a un sitio que no existe.
 */
export function parseProvider(arg: string): Provider | null {
  const limpio = arg.trim().toLowerCase();
  return (PROVIDERS as readonly string[]).includes(limpio) ? (limpio as Provider) : null;
}

/** Niveles de esfuerzo. Mismo orden y mismos nombres que en Rust
 *  (`maria_models::ESFUERZOS`): la interfaz no inventa niveles propios. */
export const ESFUERZOS = ["bajo", "medio", "alto"] as const;
export type Esfuerzo = (typeof ESFUERZOS)[number];

/** Valida el argumento de `/esfuerzo`. Devuelve null si no es un nivel. */
export function parseEsfuerzo(arg: string): Esfuerzo | null {
  const limpio = arg.trim().toLowerCase();
  return (ESFUERZOS as readonly string[]).includes(limpio) ? (limpio as Esfuerzo) : null;
}

/** Texto de ayuda, una linea por comando. */
export function helpText(): string {
  return COMMANDS.map((c) => `${c.name}${c.args ? ` ${c.args}` : ""} — ${c.desc}`).join("\n");
}
