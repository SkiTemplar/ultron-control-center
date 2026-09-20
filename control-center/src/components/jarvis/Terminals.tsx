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
import { HudSelect } from "./HudSelect";
import {
  ajustar,
  ajustarCuandoEsteListo,
  montarTerminal,
  PROVEEDORES,
  type Catalogo,
  type ModeloInfo,
  type TerminalMontado,
  type TermInfo,
} from "./terminalCore";

type Pestana = { id: string; provider: string; model: string };

export function Terminals() {
  const [pestanas, setPestanas] = useState<Pestana[]>([]);
  const [activa, setActiva] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [proveedor, setProveedor] = useState<string>("claude");
  /** "" = el modelo que traiga la CLI por defecto. */
  const [modelo, setModelo] = useState<string>("");
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Un xterm por sesion, cada uno en SU PROPIO div, todos colgados del
   *  contenedor a la vez. Cambiar de pestana solo enseña uno y esconde los
   *  demas.
   *
   *  La primera version sacaba el div del DOM y volvia a llamar a `open()` al
   *  cambiar de pestana: xterm no repinta en ese camino y la pestana volvia
   *  EN BLANCO (reportado por el usuario el 2026-09-18). Con un div fijo por
   *  sesion, `open()` se llama una sola vez y no hay nada que repintar. */
  const terminales = useRef(new Map<string, TerminalMontado & { caja: HTMLDivElement }>());

  // Sesiones que sobrevivieron a una recarga de la interfaz (el PTY vive en
  // Rust, no en la ventana).
  useEffect(() => {
    void invoke<TermInfo[]>("maria_term_list")
      .then((lista) => {
        const vivas = (lista ?? []).filter((t) => t.running);
        if (vivas.length === 0) return;
        setPestanas(
          vivas.map((t) => ({ id: t.id, provider: t.provider, model: t.model ?? "" })),
        );
        setActiva((a) => a || vivas[0].id);
      })
      .catch(() => undefined);
    void invoke<Catalogo>("maria_models_catalog")
      .then(setCatalogo)
      .catch(() => setCatalogo(null));
  }, []);

  /** Modelos elegibles del proveedor seleccionado. PowerShell no tiene. */
  const modelosDisponibles: ModeloInfo[] =
    catalogo?.providers.find((c) => c.provider === proveedor)?.models ?? [];

  /** Monta (o recupera) el xterm de una sesion y lo deja a la vista. */
  const montar = useCallback(async (id: string) => {
    const host = hostRef.current;
    if (!host) return;

    let entrada = terminales.current.get(id);
    if (!entrada) {
      const caja = document.createElement("div");
      caja.style.width = "100%";
      caja.style.height = "100%";
      host.appendChild(caja);
      const m = await montarTerminal(id, caja, setError).catch((e) => {
        setError(String(e));
        caja.remove();
        return null;
      });
      if (!m) return;
      entrada = { ...m, caja };
      terminales.current.set(id, entrada);
    }

    // Enseña la activa y esconde el resto. `visibility`+`position` en vez de
    // `display:none`: con display en none el contenedor mide 0 y `fit()`
    // calcularia una rejilla absurda.
    for (const [otro, { caja }] of terminales.current) {
      const visible = otro === id;
      caja.style.position = visible ? "relative" : "absolute";
      caja.style.visibility = visible ? "visible" : "hidden";
      caja.style.pointerEvents = visible ? "auto" : "none";
      caja.style.zIndex = visible ? "1" : "0";
    }

    ajustarCuandoEsteListo(entrada, id);
    entrada.term.focus();
  }, []);

  useEffect(() => {
    if (!activa) return;
    void montar(activa);
  }, [activa, montar]);

  // Reajuste al cambiar el tamano de la ventana.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Amortiguado igual que en el mosaico: una rafaga de avisos deja la
    // interfaz de texto de codex partida.
    let pendiente = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(pendiente);
      pendiente = window.setTimeout(() => {
        const entrada = terminales.current.get(activa);
        if (entrada) ajustar(entrada, activa);
      }, 120);
    });
    ro.observe(host);
    return () => {
      window.clearTimeout(pendiente);
      ro.disconnect();
    };
  }, [activa]);

  // Al desmontar la pestana se sueltan los listeners, NO los PTY: el usuario
  // espera volver y encontrarse su sesion donde la dejo.
  useEffect(
    () => () => {
      for (const { soltar, caja } of terminales.current.values()) {
        soltar();
        caja.remove();
      }
      terminales.current.clear();
    },
    [],
  );

  async function abrir(provider: string, model: string) {
    setError(null);
    const id = await invoke<string>("maria_term_open", {
      provider,
      cwd: null,
      model: model || null,
    }).catch((e) => {
      setError(String(e));
      return null;
    });
    if (!id) return;
    setPestanas((prev) => [...prev, { id, provider, model }]);
    setActiva(id);
  }

  async function cerrar(id: string) {
    await invoke("maria_term_kill", { id }).catch(() => undefined);
    const entrada = terminales.current.get(id);
    entrada?.soltar();
    entrada?.caja.remove();
    terminales.current.delete(id);
    setPestanas((prev) => {
      const resto = prev.filter((p) => p.id !== id);
      setActiva((a) => (a === id ? (resto[0]?.id ?? "") : a));
      return resto;
    });
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
        {/* Se elige proveedor Y modelo antes de abrir: una sesion interactiva
            no se puede cambiar de modelo por fuera despues. */}
        <HudSelect
          etiqueta="cli"
          valor={proveedor}
          ancho={150}
          titulo="qué CLI abre esta terminal"
          opciones={PROVEEDORES.map((p) => ({ id: p.id, label: p.label }))}
          onChange={(v) => {
            setProveedor(v);
            // El modelo pertenece a un proveedor: arrastrarlo al siguiente
            // seria pedir un modelo que esa CLI no tiene.
            setModelo("");
          }}
        />
        <HudSelect
          etiqueta="modelo"
          valor={modelo}
          vacio="por defecto de la CLI"
          ancho={176}
          titulo="con qué modelo arranca la sesión"
          opciones={modelosDisponibles.map((m) => ({
            id: m.id,
            label: m.label,
            hint: m.para,
          }))}
          onChange={setModelo}
        />
        <button
          type="button"
          onClick={() => void abrir(proveedor, modelo)}
          className="hud-panel mt-4 px-4 text-[13px]"
          style={{
            minHeight: 38,
            color: "var(--color-accent)",
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
          }}
        >
          + abrir
        </button>
        <span className="flex-1" />
        {pestanas.map((t) => (
          <span
            key={t.id}
            className="hud-panel flex items-center gap-2 px-3"
            style={{
              minHeight: 38,
              background: t.id === activa ? "var(--color-surface-3)" : undefined,
              border:
                t.id === activa
                  ? "1px solid var(--color-accent)"
                  : "1px solid var(--color-border)",
            }}
          >
            <button
              type="button"
              onClick={() => setActiva(t.id)}
              className="text-[13px]"
              title={t.model ? `${t.provider} con ${t.model}` : `${t.provider} (modelo por defecto)`}
              style={{
                color: t.id === activa ? "var(--color-accent)" : "var(--color-text-secondary)",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              {t.provider}
              {t.model ? ` · ${t.model}` : ""}
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
            ninguna terminal abierta. elige cli y modelo arriba y pulsa «+ abrir».
          </p>
        ) : (
          <div ref={hostRef} className="relative h-full w-full" />
        )}
      </div>
    </div>
  );
}
