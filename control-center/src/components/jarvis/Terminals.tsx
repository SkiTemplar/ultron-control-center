// mar.ia — terminales embebidas.
//
// Las CLIs de Claude, Codex y Gemini corriendo DENTRO de la aplicacion, con
// pestanas, en vez de en consolas sueltas por el escritorio (peticion del
// usuario, 2026-09-18).
//
// Como funciona: el backend abre un PTY de verdad (`maria_term_open`), el hilo
// lector emite `pty:data:<id>` en base64 y aqui se vuelca en un xterm. Lo que
// se teclea viaja de vuelta por `maria_term_write`. Al cambiar de pestana el
// PTY sigue vivo: `maria_term_subscribe` devuelve lo capturado mientras no
// mirabas, asi que el terminal no reaparece en blanco.
//
// Limite declarado: es un terminal real, no una imitacion — lo que se escribe
// ahi corre en el PC con los permisos del usuario, igual que en una consola.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** Lo que se puede abrir. Tiene que coincidir con la lista blanca de Rust
 *  (`maria_term::PERMITIDOS`): si no, el boton pide algo que el backend
 *  rechaza y el usuario ve un error sin saber por que. */
const PROVEEDORES = [
  { id: "claude", label: "claude" },
  { id: "codex", label: "codex" },
  { id: "gemini", label: "gemini" },
  { id: "powershell", label: "powershell" },
] as const;

type Pestana = { id: string; provider: string };

/** Paleta del terminal, a juego con el HUD. */
const TEMA = {
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

export function Terminals() {
  const [pestanas, setPestanas] = useState<Pestana[]>([]);
  const [activa, setActiva] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Un xterm por sesion: cambiar de pestana no puede perder el scrollback. */
  const terminales = useRef(new Map<string, { term: Terminal; fit: FitAddon }>());
  const suscripciones = useRef(new Map<string, UnlistenFn[]>());

  // Sesiones que sobrevivieron a una recarga de la interfaz (el PTY vive en
  // Rust, no en la ventana).
  useEffect(() => {
    void invoke<Array<{ id: string; provider: string; running: boolean }>>("maria_term_list")
      .then((lista) => {
        const vivas = (lista ?? []).filter((t) => t.running);
        if (vivas.length === 0) return;
        setPestanas(vivas.map((t) => ({ id: t.id, provider: t.provider })));
        setActiva((a) => a || vivas[0].id);
      })
      .catch(() => undefined);
  }, []);

  /** Monta (o recupera) el xterm de una sesion dentro del contenedor. */
  const montar = useCallback(async (id: string) => {
    const host = hostRef.current;
    if (!host) return;
    let entrada = terminales.current.get(id);
    if (!entrada) {
      const term = new Terminal({
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, monospace',
        fontSize: 12.5,
        theme: TEMA,
        cursorBlink: true,
        // El PTY ya guarda 256 KiB; aqui basta con un scrollback generoso.
        scrollback: 5000,
        convertEol: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      entrada = { term, fit };
      terminales.current.set(id, entrada);

      term.onData((d) => {
        void invoke("maria_term_write", { id, data: btoa(unescape(encodeURIComponent(d))) }).catch(
          (e) => setError(String(e)),
        );
      });
      term.onResize(({ rows, cols }) => {
        void invoke("maria_term_resize", { id, rows, cols }).catch(() => undefined);
      });

      const unData = await listen<{ data?: string }>(`pty:data:${id}`, (e) => {
        const b64 = e.payload?.data;
        if (typeof b64 === "string") term.write(bytesDesdeBase64(b64));
      });
      const unExit = await listen<{ exit_code?: number }>(`pty:exit:${id}`, (e) => {
        term.write(`\r\n\x1b[33m— sesión terminada (código ${e.payload?.exit_code ?? "?"}) —\x1b[0m\r\n`);
      });
      suscripciones.current.set(id, [unData, unExit]);
    }

    host.replaceChildren();
    entrada.term.open(host);
    entrada.fit.fit();
    entrada.term.focus();

    // Vuelca lo capturado mientras esta pestana no estaba montada. Se pide
    // DESPUES de abrir para que el texto caiga sobre una rejilla ya medida.
    const previo = await invoke<string>("maria_term_subscribe", { id }).catch(() => "");
    if (previo) {
      entrada.term.clear();
      entrada.term.write(bytesDesdeBase64(previo));
    }
    void invoke("maria_term_resize", {
      id,
      rows: entrada.term.rows,
      cols: entrada.term.cols,
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!activa) return;
    void montar(activa);
  }, [activa, montar]);

  // Reajuste al cambiar el tamano de la ventana.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const entrada = terminales.current.get(activa);
      try {
        entrada?.fit.fit();
      } catch {
        // fit() falla si el contenedor mide 0 (pestana oculta): no es un error.
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [activa]);

  // Al desmontar la pestana se sueltan los listeners, NO los PTY: el usuario
  // espera volver y encontrarse su sesion donde la dejo.
  useEffect(
    () => () => {
      for (const fns of suscripciones.current.values()) {
        for (const f of fns) f();
      }
      suscripciones.current.clear();
      for (const { term } of terminales.current.values()) term.dispose();
      terminales.current.clear();
    },
    [],
  );

  async function abrir(provider: string) {
    setError(null);
    const id = await invoke<string>("maria_term_open", { provider, cwd: null }).catch((e) => {
      setError(String(e));
      return null;
    });
    if (!id) return;
    setPestanas((prev) => [...prev, { id, provider }]);
    setActiva(id);
  }

  async function cerrar(id: string) {
    await invoke("maria_term_kill", { id }).catch(() => undefined);
    for (const f of suscripciones.current.get(id) ?? []) f();
    suscripciones.current.delete(id);
    terminales.current.get(id)?.term.dispose();
    terminales.current.delete(id);
    setPestanas((prev) => {
      const resto = prev.filter((p) => p.id !== id);
      setActiva((a) => (a === id ? (resto[0]?.id ?? "") : a));
      return resto;
    });
    hostRef.current?.replaceChildren();
  }

  return (
    <div className="flex h-full min-w-0 flex-col px-6 py-4">
      <header className="mb-3">
        <h1 className="hud-label" style={{ fontSize: 12 }}>
          terminales · las CLIs dentro de mar.ia
        </h1>
        <p className="mt-1 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          sesiones reales con tus permisos; siguen vivas al cambiar de pestaña
        </p>
      </header>

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {PROVEEDORES.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => void abrir(p.id)}
            className="hud-panel hud-label px-2 py-1"
            style={{ color: "var(--color-accent)", cursor: "pointer" }}
          >
            + {p.label}
          </button>
        ))}
        <span className="flex-1" />
        {pestanas.map((t) => (
          <span
            key={t.id}
            className="hud-panel flex items-center gap-1 px-2 py-1"
            style={{
              background: t.id === activa ? "var(--color-surface-3)" : undefined,
            }}
          >
            <button
              type="button"
              onClick={() => setActiva(t.id)}
              className="hud-label"
              style={{
                color: t.id === activa ? "var(--color-accent)" : "var(--color-text-secondary)",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              {t.provider}
            </button>
            <button
              type="button"
              onClick={() => void cerrar(t.id)}
              aria-label={`cerrar terminal ${t.provider}`}
              className="text-[11px]"
              style={{
                color: "var(--color-text-tertiary)",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {error && (
        <p
          className="mb-2 px-3 py-2 text-[11px]"
          style={{
            border: "1px solid var(--color-danger)",
            color: "var(--color-danger)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {error}
        </p>
      )}

      <div className="hud-panel hud-brackets min-h-0 flex-1 overflow-hidden p-2">
        {pestanas.length === 0 ? (
          <p className="hud-label p-2">
            ninguna terminal abierta. pulsa «+ claude», «+ codex», «+ gemini» o «+ powershell».
          </p>
        ) : (
          <div ref={hostRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
}

/** base64 → bytes. xterm acepta Uint8Array y asi no se rompe el UTF-8 que
 *  llega partido entre dos lecturas del PTY. */
function bytesDesdeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
