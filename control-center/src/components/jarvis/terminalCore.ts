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
  { id: "gemini", label: "gemini" },
  { id: "powershell", label: "powershell" },
] as const;

/** Catalogo de modelos (`maria_models_catalog`). Se pide al backend en vez de
 *  clavar la lista aqui: si el catalogo de Rust cambia, esto no se queda
 *  ofreciendo un modelo que la CLI ya no acepta. */
export type ModeloInfo = { id: string; label: string; para: string };
export type Catalogo = {
  providers: Array<{ provider: string; models: ModeloInfo[]; default_model: string }>;
};

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

/** Ajusta el xterm al tamano del contenedor y se lo dice al PTY. */
export function ajustar(m: TerminalMontado, id: string) {
  try {
    m.fit.fit();
  } catch {
    // fit() falla si el contenedor mide 0 (panel oculto): no es un error.
    return;
  }
  void invoke("maria_term_resize", { id, rows: m.term.rows, cols: m.term.cols }).catch(
    () => undefined,
  );
}
