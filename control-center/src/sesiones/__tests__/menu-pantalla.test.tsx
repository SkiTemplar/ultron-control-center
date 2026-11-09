// Bloque de menú del chat con el xterm real y una captura real de la TUI
// (`fixtures/tui/mcp-resize.ans`: Claude Code 2.1.296 en ConPTY a 160x48,
// `/mcp` abierto y el PTY redimensionado a 100x20). Antes el bloque
// reproducía los bytes de un PTY de 160x48 en un xterm de 100x16: las filas
// se partían y el diálogo quedaba mezclado con restos de pantallas
// anteriores. Ahora el PTY toma el tamaño de la vista mientras el menú está
// abierto, la TUI se repinta entera (`ESC[2J`) y al cerrarlo vuelve al de
// lanzamiento.

import { render, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { StrictMode, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import {
  hostGeometry, linkMenuTerminal, MENU_FALLBACK, hasMenuIntent, MENU_INTENT_MS, markMenuIntent, menuGeometry, menuKeyHandler, shouldFocusMenu,
} from "../components/chat/menu-terminal";
import { SESSIONS } from "../mock/data";
import type { CommandDef, SessionInfo } from "../types";
// La captura es UTF-8 válido: `?raw` la devuelve sin pérdida y los índices
// del `.json` son offsets de bytes.
import capturaAns from "../../../src-tauri/src/sesiones/fixtures/tui/mcp-resize.ans?raw";
import indice from "../../../src-tauri/src/sesiones/fixtures/tui/mcp-resize.json";

const CAPTURA = new TextEncoder().encode(capturaAns);
/** Tamaño al que se redimensionó el PTY en la captura. */
const VISTA = { cols: 100, rows: 20 };

function aBase64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

function escribir(term: Terminal, datos: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => term.write(datos, resolve));
}

function pantalla(term: Terminal): string[] {
  const b = term.buffer.active;
  return Array.from({ length: term.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
}

/** Solo el repintado que sigue al resize, en un terminal limpio de 100x20. */
async function referencia(): Promise<string[]> {
  const { Terminal: Real } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  const ref = new Real(VISTA);
  await escribir(ref, CAPTURA.subarray(indice["mcp-abierto"], indice["resize-100x20"]));
  const filas = pantalla(ref);
  ref.dispose();
  return filas;
}

function fakeApi(overrides: Partial<Record<keyof SesionesApi, unknown>>): SesionesApi {
  return new Proxy({ isMock: true } as unknown as SesionesApi, {
    get(target, key: string) {
      if (key in overrides) return overrides[key as keyof SesionesApi];
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
      return () => Promise.reject(new Error(`${key}: no implementado en el test`));
    },
  });
}

interface PtyOpts {
  /** La emisión en vivo ya estaba encendida al montar (vista anterior sin soltar, página recargada). */
  suscrito?: boolean;
  /** Bloque que sale del PTY entre la escucha y el `attach`. */
  antesDeAdjuntar?: Uint8Array;
  /** Bloque que sale justo después del `attach` y llega antes de su respuesta. */
  trasAdjuntar?: Uint8Array;
}

/**
 * PTY falso fiel al backend (`pty/ops.rs::capture_chunk`, `pty/io.rs`): cada
 * bloque va al búfer y, con la emisión encendida, también en vivo; `attach`
 * enciende la emisión y copia el búfer; `detach` la apaga. Registra el orden.
 */
function ptyFalso(adjunto: Uint8Array, opts: PtyOpts = {}) {
  const orden: string[] = [];
  let buffer = adjunto;
  let subscribed = opts.suscrito ?? false;
  let emitir: ((chunk: string) => void) | null = null;
  const salida = (bytes: Uint8Array) => {
    const junto = new Uint8Array(buffer.length + bytes.length);
    junto.set(buffer);
    junto.set(bytes, buffer.length);
    buffer = junto;
    if (subscribed) emitir?.(aBase64(bytes));
  };
  const api = fakeApi({
    terminalResize: vi.fn(async (a: { cols: number; rows: number }) => void orden.push(`resize ${a.cols}x${a.rows}`)),
    terminalRestoreSize: vi.fn(async () => void orden.push("restore")),
    terminalAttach: vi.fn(async () => {
      orden.push("attach");
      subscribed = true;
      const copia = aBase64(buffer);
      if (opts.trasAdjuntar) salida(opts.trasAdjuntar);
      return copia;
    }),
    terminalDetach: vi.fn(async () => {
      orden.push("detach");
      subscribed = false;
    }),
    terminalInput: vi.fn(async () => undefined),
    recover: vi.fn(async () => ({ ok: true, steps: ["esc"] })),
    onPty: async (_id: string, cb: (chunk: string) => void) => {
      emitir = cb;
      if (opts.antesDeAdjuntar) salida(opts.antesDeAdjuntar);
      return () => void orden.push("unlisten");
    },
  });
  return { api, orden };
}

const MENU_MCP: SessionInfo = { ...SESSIONS[0], id: "s1", status: "waiting", waiting: { kind: "menu", label: "/mcp", since: "" } };

/**
 * Monta el bloque con el xterm real (sin DOM: `open` no hace nada). `focus`
 * imita a xterm: enfoca su textarea auxiliar dentro de `.menu-term`. `antes`
 * corre con los módulos ya recargados (comparten estado con el bloque).
 */
async function montarBloque(api: SesionesApi, info: SessionInfo = MENU_MCP, prepara?: (ui: typeof import("../ui")) => void, antes?: () => Promise<void>) {
  const creadas: Terminal[] = [];
  const focos: Terminal[] = [];
  vi.doMock("@xterm/xterm", async () => {
    const real = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
    class Capturada extends real.Terminal {
      constructor(...args: ConstructorParameters<typeof real.Terminal>) {
        super(...args);
        creadas.push(this);
      }
      override open(): void {}
      override focus(): void {
        focos.push(this);
        const hosts = document.querySelectorAll<HTMLElement>(".menu-term");
        const host = hosts[hosts.length - 1];
        if (!host) return;
        const ayuda = host.querySelector("textarea") ?? host.appendChild(document.createElement("textarea"));
        ayuda.focus();
      }
    }
    return { ...real, Terminal: Capturada };
  });
  vi.resetModules();
  prepara?.(await import("../ui"));
  await antes?.();
  const { MenuBlock } = await import("../components/chat/SessionCards");
  const { ApiContext } = await import("../context");
  const arbol: ReactElement = <ApiContext.Provider value={api}><MenuBlock info={info} /></ApiContext.Provider>;
  // Con una petición del cable antiguo, como en `main.tsx`: doble montaje de StrictMode.
  const vista = render(prepara ? <StrictMode>{arbol}</StrictMode> : arbol);
  await waitFor(() => expect(creadas.length).toBeGreaterThan(0));
  const term = creadas[creadas.length - 1];
  await waitFor(() => expect(pantalla(term).some((l) => l.trim() !== "")).toBe(true));
  await escribir(term, "");
  return { term, unmount: vista.unmount, focos, host: vista.getByTestId("menu-screen") };
}

describe("bloque de menú con la captura real de /mcp", () => {
  afterEach(() => {
    vi.doUnmock("@xterm/xterm");
    vi.resetModules();
  });

  it.each([0, 3333, 8000])("redimensiona el PTY a la vista y pinta /mcp limpio con el búfer cortado en %i", async (corte) => {
    expect(MENU_FALLBACK).toEqual(VISTA);
    const esperado = await referencia();
    expect(esperado).toContain("   Manage MCP servers");
    const { api, orden } = ptyFalso(CAPTURA.subarray(corte, indice["resize-100x20"]));
    const { term } = await montarBloque(api);
    expect(orden.slice(0, 3)).toEqual(["resize 100x20", "detach", "attach"]);
    expect(pantalla(term)).toEqual(esperado);
  });

  it("al cerrar el menú restaura el tamaño del PTY y después suelta la emisión", async () => {
    const { api, orden } = ptyFalso(CAPTURA.subarray(0, indice["resize-100x20"]));
    const { unmount } = await montarBloque(api);
    expect(api.terminalRestoreSize).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(orden).toHaveLength(6));
    // Soltar quita la pausa de la cola: no puede adelantarse al tamaño de lanzamiento.
    expect(orden).toEqual(["resize 100x20", "detach", "attach", "unlisten", "restore", "detach"]);
  });

  it("la salida en vivo que llega antes de la respuesta del attach se escribe detrás del búfer", async () => {
    const { api } = ptyFalso(new TextEncoder().encode("búfer "), { trasAdjuntar: new TextEncoder().encode("vivo") });
    const { term } = await montarBloque(api);
    expect(pantalla(term)[0]).toBe("búfer vivo");
  });

  it("con la emisión ya encendida, un bloque anterior al attach no se escribe dos veces", async () => {
    const { api } = ptyFalso(new TextEncoder().encode("búfer "), { suscrito: true, antesDeAdjuntar: new TextEncoder().encode("vivo") });
    const { term } = await montarBloque(api);
    expect(pantalla(term)[0]).toBe("búfer vivo");
  });
});

describe("vistas sucesivas del menú en la misma sesión", () => {
  const termFalso = () => ({ write: vi.fn(), resize: vi.fn() }) as unknown as Terminal;

  it("desmontar con un resize pendiente y reabrir: el cierre viejo no desconecta ni encoge la vista nueva", async () => {
    const { api, orden } = ptyFalso(new TextEncoder().encode("x"));
    let soltar: () => void = () => undefined;
    const lento = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    const resize = api.terminalResize as ReturnType<typeof vi.fn>;
    const errores: unknown[] = [];
    const vieja = linkMenuTerminal(api, "s-remonta", termFalso(), VISTA, (e) => errores.push(e));
    await vieja.ready;
    resize.mockImplementationOnce(async (a: { cols: number; rows: number }) => {
      orden.push(`resize ${a.cols}x${a.rows} (lento)`);
      await lento;
    });
    vieja.link.resize({ cols: 120, rows: 30 });
    await Promise.resolve();
    vieja.link.close();
    const nueva = linkMenuTerminal(api, "s-remonta", termFalso(), { cols: 90, rows: 18 }, (e) => errores.push(e));
    soltar();
    await nueva.ready;
    await new Promise((r) => setTimeout(r, 0));
    expect(errores).toEqual([]);
    expect(orden[orden.length - 1]).toBe("attach");
    expect(orden.slice(orden.indexOf("resize 120x30 (lento)") + 1)).toEqual(["unlisten", "resize 90x18", "detach", "attach"]);
    nueva.link.close();
    await vi.waitFor(() => expect(orden.slice(-3)).toEqual(["unlisten", "restore", "detach"]));
  });
});

describe("menuGeometry", () => {
  it("sin medida usa el tamaño de reserva", () => {
    expect(menuGeometry(0, 0, null)).toEqual(MENU_FALLBACK);
    expect(menuGeometry(800, 300, { width: 0, height: 15 })).toEqual(MENU_FALLBACK);
  });

  it("cabe en la vista y respeta los límites", () => {
    expect(menuGeometry(721, 300, { width: 7.2, height: 15 })).toEqual({ cols: 100, rows: 20 });
    expect(menuGeometry(100, 50, { width: 7.2, height: 15 })).toEqual({ cols: 20, rows: 8 });
    // Un panel estrecho no recibe más columnas de las que caben (antes, al menos 60).
    expect(menuGeometry(300, 300, { width: 7.2, height: 15 })).toEqual({ cols: 41, rows: 20 });
    expect(menuGeometry(5000, 5000, { width: 7.2, height: 15 })).toEqual({ cols: 240, rows: 48 });
  });

  it("la sonda de la celda no hereda el line-height del body", () => {
    // 12 px de Cascadia Mono: unos 14 px con `line-height: normal` y 18,6 con el 1.55 del body.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { width: 32 * 7.2, height: this.style.lineHeight === "normal" ? 14 : 18.6 } as DOMRect;
    });
    const host = document.createElement("div");
    host.style.padding = "6px";
    Object.defineProperty(host, "clientWidth", { value: 733 });
    Object.defineProperty(host, "clientHeight", { value: 340 });
    document.body.appendChild(host);
    try {
      expect(hostGeometry(host)).toEqual({ cols: 100, rows: 23 });
    } finally {
      host.remove();
      rect.mockRestore();
    }
  });
});

describe("foco y teclado del bloque de menú", () => {
  afterEach(() => {
    vi.doUnmock("@xterm/xterm");
    vi.resetModules();
    document.body.replaceChildren();
  });

  it("un menú que aparece solo no roba el foco del composer", async () => {
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    const { api } = ptyFalso(new TextEncoder().encode("menú"));
    const { focos } = await montarBloque(api);
    expect(focos).toHaveLength(0);
    expect(document.activeElement).toBe(composer);
  });

  it("sin otro campo con el foco, el menú lo toma", async () => {
    const { api } = ptyFalso(new TextEncoder().encode("menú"));
    const { focos } = await montarBloque(api);
    expect(focos).toHaveLength(1);
  });

  it("Ctrl+C sin selección cierra el menú por la recuperación y no llega crudo a la TUI", async () => {
    const { api } = ptyFalso(new TextEncoder().encode("menú"));
    const { host } = await montarBloque(api);
    const ctrlC = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    host.dispatchEvent(ctrlC);
    expect(ctrlC.defaultPrevented).toBe(true);
    expect(api.recover).toHaveBeenCalledWith({ id: "s1", action: "exitMenu" });
    expect(api.terminalInput).not.toHaveBeenCalled();
  });

  it("/config enviado desde el composer: el menú que abre toma el foco del textarea", async () => {
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    const runCommand = vi.fn(async () => ({ disposition: "written" }));
    const envio = fakeApi({ runCommand });
    const enviar = async () => {
      const { renderHook } = await import("@testing-library/react");
      const { store } = await import("../store");
      const { useChatSubmit } = await import("../components/composer/useChatSubmit");
      store.dispatch({ type: "sessions", sessions: [{ ...SESSIONS[0], id: "s-cfg", status: "idle", waiting: null }] });
      const config = { name: "config", description: "", source: "builtin", kind: "menu" } as unknown as CommandDef;
      const { result } = renderHook(() => useChatSubmit(envio, "s-cfg", { commands: [config], live: true }, () => undefined));
      expect(await result.current({ text: "/config", attachments: [], delegate: false, mode: "auto" })).toBe(true);
      expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ id: "s-cfg", command: "config" }));
      expect(document.activeElement).toBe(composer);
    };
    const { api } = ptyFalso(new TextEncoder().encode("menú"));
    const info: SessionInfo = { ...MENU_MCP, id: "s-cfg", waiting: { kind: "menu", label: "/config", since: "" } };
    const { focos } = await montarBloque(api, info, undefined, enviar);
    expect(focos).toHaveLength(1);
    expect(document.activeElement?.closest(".menu-term")).not.toBeNull();
  });

  it("con StrictMode, la petición del cable antiguo teclea el comando una vez", async () => {
    const { api } = ptyFalso(new TextEncoder().encode("prompt"));
    const idle: SessionInfo = { ...SESSIONS[0], id: "s1", status: "idle", waiting: null };
    await montarBloque(api, idle, (ui) => ui.requestMenu("s1", "mcp"));
    await waitFor(() => expect(api.terminalInput).toHaveBeenCalledTimes(1));
    expect(api.terminalInput).toHaveBeenCalledWith({ id: "s1", data: "/mcp\r" });
  });
});

describe("intención de menú, foco y Ctrl+C", () => {
  it("la intención del usuario vale durante MENU_INTENT_MS y después caduca", () => {
    markMenuIntent("s-i", 1000);
    expect(hasMenuIntent("s-i", 1000 + MENU_INTENT_MS)).toBe(true);
    expect(hasMenuIntent("s-i", 1000 + MENU_INTENT_MS), "no se consume (StrictMode)").toBe(true);
    expect(hasMenuIntent("s-i", 1001 + MENU_INTENT_MS)).toBe(false);
    expect(hasMenuIntent("otra", 1000)).toBe(false);
  });

  it("solo se quita el foco a un campo editable si el usuario pidió el menú", () => {
    const campo = document.createElement("input");
    expect(shouldFocusMenu(false, campo)).toBe(false);
    expect(shouldFocusMenu(true, campo)).toBe(true);
    expect(shouldFocusMenu(false, document.body)).toBe(true);
    expect(shouldFocusMenu(false, null)).toBe(true);
  });

  it("Ctrl+C con selección copia una vez; las demás teclas pasan a xterm", () => {
    const copy = vi.fn();
    const closeMenu = vi.fn();
    const handler = menuKeyHandler({ hasSelection: () => true, getSelection: () => "texto" }, { copy, closeMenu });
    expect(handler(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(false);
    expect(copy).toHaveBeenCalledWith("texto");
    expect(handler(new KeyboardEvent("keyup", { key: "c", ctrlKey: true }))).toBe(false);
    expect(handler(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, repeat: true }))).toBe(false);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(handler(new KeyboardEvent("keydown", { key: "c" }))).toBe(true);
    expect(handler(new KeyboardEvent("keydown", { key: "ArrowDown" }))).toBe(true);
    expect(closeMenu).not.toHaveBeenCalled();
  });
});
