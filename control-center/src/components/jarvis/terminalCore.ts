// mar.ia — nucleo compartido de las terminales embebidas.
//
// Lo usan DOS vistas: la pestana "Terminales" (varias sesiones con pestanas) y
// cada panel de terminal del mosaico. Vive aparte para que el montaje del
// xterm, la suscripcion al PTY y el volcado de lo ya capturado esten escritos
// una sola vez: con dos copias, un arreglo en una se olvidaba en la otra.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** Lo que se puede abrir. Tiene que coincidir con la lista blanca de Rust
 *  (`maria_term::PERMITIDOS`): si no, el boton pide algo que el backend
 *  rechaza y el usuario ve un error sin saber por que. */
export const PROVEEDORES = [
  { id: "claude", label: "claude" },
  { id: "codex", label: "codex" },
  { id: "antigravity", label: "antigravity (agy)" },
  { id: "powershell", label: "powershell" },
] as const;

/** Catalogo de modelos (`maria_models_catalog`). Se pide al backend en vez de
 *  clavar la lista aqui: si el catalogo de Rust cambia, esto no se queda
 *  ofreciendo un modelo que la CLI ya no acepta.
 *
 *  Este es el UNICO sitio donde vive el tipo. Hasta el 2026-09-22 habia tres
 *  copias escritas a mano (aqui, en MariaChat.tsx y en CriterioPanel.tsx) y ya
 *  discrepaban entre si: la de CriterioPanel no tenia `default_model` ni
 *  `nota`, asi que una regla del Router no podia ni explicar por que la lista
 *  era la que era.
 *
 *  Lo que anadio la deteccion de suscripcion (2026-09-22) va todo OPCIONAL a
 *  proposito: un backend anterior no manda esos campos y la interfaz tiene que
 *  seguir pintando la lista exactamente igual que hoy. */

/** Que sabemos de si la cuenta admite ese modelo.
 *
 *  "desconocido" NO es "no": el modelo se sigue ofreciendo. Esconder por falta
 *  de pruebas seria peor que el problema que arregla esto, porque taparia
 *  modelos que la suscripcion si permite. */
export type Permitido = "si" | "no" | "desconocido";

/** De donde salio el id: del catalogo de casa o de lo que publica la cuenta. */
export type OrigenModelo = "casa" | "suscripcion";

export type ModeloInfo = {
  id: string;
  label: string;
  /** Para que sirve, en una linea. Se pinta como pista bajo la etiqueta. */
  para: string;
  permitido?: Permitido;
  /** Una frase para el tooltip ("rechazado por la cuenta el 22/09: ..."),
   *  recortada en Rust. Jamas puede llevar un token. */
  motivo?: string;
  /** RFC 3339 de cuando se supo. Vacio = nunca se ha probado. */
  visto?: string;
  origen?: OrigenModelo;
};

export type CatalogoProveedor = {
  provider: string;
  models: ModeloInfo[];
  default_model: string;
  /** Como se controla el esfuerzo en esa CLI ("Bandera", "EnElPrompt"...). */
  effort_mode?: string;
  /** Por que la lista es la que es. Vacio = no hay nada que explicar. */
  nota?: string;
  /** Plan detectado ("Claude Pro", "ChatGPT Free"...). Vacio = no se sabe, y
   *  entonces no se pinta nada: un plan inventado es peor que ninguno. */
  plan?: string;
  /** De donde salio el plan (nombre de fichero/campo o comando). Nunca un
   *  valor sensible: solo el sitio, para poder comprobarlo. */
  plan_origen?: string;
  /** RFC 3339 del ultimo sondeo. Vacio = solo hay catalogo de casa. */
  refrescado?: string;
};

export type Catalogo = { providers: CatalogoProveedor[]; efforts?: string[] };

export type TermInfo = { id: string; provider: string; running: boolean; model: string };

/** Secuencias de control, construidas con fromCharCode: escribirlas como
 *  bytes crudos deja caracteres invisibles en el fuente. */
const ESC = String.fromCharCode(0x1b);
const CRLF = String.fromCharCode(13, 10);

/** Paleta del terminal, a juego con el HUD. */
export const TEMA = {
  background: "#040d16",
  foreground: "#cfe9f7",
  cursor: "#35d6ff",
  selectionBackground: "rgba(53,214,255,0.25)",
  black: "#0a1520",
  brightBlack: "#41566b",
  blue: "#35d6ff",
  brightBlue: "#7fe6ff",
  cyan: "#35d6ff",
  green: "#49e6a0",
  red: "#ff4d5e",
  yellow: "#ffc24b",
  white: "#cfe9f7",
};

/** base64 -> bytes. xterm acepta Uint8Array y asi no se rompe el UTF-8 que
 *  llega partido entre dos lecturas del PTY. */
export function bytesDesdeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** bytes de texto -> base64, respetando acentos y teclas con escape. */
export function base64DesdeTexto(texto: string): string {
  return btoa(unescape(encodeURIComponent(texto)));
}

export type TerminalMontado = {
  term: Terminal;
  fit: FitAddon;
  /** Suelta listeners y destruye el xterm. NO mata el PTY. */
  soltar: () => void;
};

/**
 * Monta un xterm sobre `caja` y lo engancha a la sesion `id`.
 *
 * Al final pide `maria_term_subscribe`, que enciende la emision en vivo y
 * devuelve lo capturado mientras nadie miraba: sin eso, abrir un panel sobre
 * una sesion que ya existia lo enseñaba en blanco.
 */
export async function montarTerminal(
  id: string,
  caja: HTMLElement,
  onError: (msg: string) => void,
): Promise<TerminalMontado> {
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, monospace',
    fontSize: 12.5,
    theme: TEMA,
    cursorBlink: true,
    // El PTY ya guarda 256 KiB; aqui basta con un scrollback generoso.
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(caja);

  term.onData((d) => {
    void invoke("maria_term_write", { id, data: base64DesdeTexto(d) }).catch((e) =>
      onError(String(e)),
    );
  });
  term.onResize(({ rows, cols }) => {
    void invoke("maria_term_resize", { id, rows, cols }).catch(() => undefined);
  });

  const fuera: UnlistenFn[] = [];
  fuera.push(
    await listen<{ data?: string }>(`pty:data:${id}`, (e) => {
      const b64 = e.payload?.data;
      if (typeof b64 === "string") term.write(bytesDesdeBase64(b64));
    }),
  );
  fuera.push(
    await listen<{ exit_code?: number }>(`pty:exit:${id}`, (e) => {
      const codigo = e.payload?.exit_code ?? "?";
      term.write(
        CRLF + ESC + "[33m- sesion terminada (codigo " + codigo + ") -" + ESC + "[0m" + CRLF,
      );
    }),
  );

  const previo = await invoke<string>("maria_term_subscribe", { id }).catch(() => "");
  if (previo) term.write(bytesDesdeBase64(previo));

  return {
    term,
    fit,
    soltar: () => {
      for (const f of fuera) f();
      term.dispose();
    },
  };
}

/** Ultimo tamano enviado al PTY, por sesion. */
const ULTIMO_TAMANO = new Map<string, string>();

/** Ajusta el xterm al tamano del contenedor y se lo dice al PTY.
 *
 *  Solo avisa al PTY si el tamano ha CAMBIADO de verdad. Importa: cada aviso
 *  es un SIGWINCH para la CLI de dentro, y las que pintan interfaz de texto
 *  (codex, con su cuadro de entrada) se redibujan enteras con cada uno. El
 *  observador de tamano del navegador dispara en rafagas durante una
 *  animacion o al abrir un panel, y esas rafagas dejaban el cuadro de texto
 *  partido a la mitad. Reportado el 2026-09-20: "en la zona de terminales, al
 *  menos con codex se bugea un poco... el cuadro de texto se bugea".
 */
export function ajustar(m: TerminalMontado, id: string) {
  try {
    m.fit.fit();
  } catch {
    // fit() falla si el contenedor mide 0 (panel oculto): no es un error.
    return;
  }
  const { rows, cols } = m.term;
  // Un tamano absurdo es el sintoma de medir un contenedor a medio montar:
  // mandarselo al PTY le deja la pantalla rota hasta el siguiente ajuste.
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 2 || cols < 10) {
    return;
  }
  const clave = `${rows}x${cols}`;
  if (ULTIMO_TAMANO.get(id) === clave) return;
  ULTIMO_TAMANO.set(id, clave);
  void invoke("maria_term_resize", { id, rows, cols }).catch(() => undefined);
}

/** Se olvida del tamano de una sesion (al cerrarla o desmontarla). */
export function olvidarTamano(id: string) {
  ULTIMO_TAMANO.delete(id);
}

/** Ajusta cuando el navegador ya ha hecho el hueco y tiene las fuentes.
 *
 *  Un `fit()` justo despues de `term.open()` mide con la fuente aun sin
 *  cargar: sale un numero de columnas que no es el real y la CLI pinta a ese
 *  ancho equivocado. Se repite en el siguiente fotograma y una vez mas cuando
 *  las fuentes estan listas.
 */
export function ajustarCuandoEsteListo(m: TerminalMontado, id: string) {
  ajustar(m, id);
  requestAnimationFrame(() => ajustar(m, id));
  const fuentes = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
  if (fuentes?.ready) {
    void fuentes.ready.then(() => ajustar(m, id));
  } else {
    window.setTimeout(() => ajustar(m, id), 150);
  }
}
