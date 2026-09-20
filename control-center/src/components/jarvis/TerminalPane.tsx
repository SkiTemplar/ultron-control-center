// mar.ia — un terminal, una sesion, un panel.
//
// Es la pieza que usa el mosaico: la pestana "Terminales" gestiona varias
// sesiones con pestanas, y aqui cada panel enseña UNA. Si no le dan sesion,
// ofrece abrirla eligiendo cli y modelo.
//
// El PTY vive en Rust: cerrar el panel NO mata la sesion (se suelta el xterm y
// nada mas), asi que se puede mover de sitio sin perder lo que estaba
// corriendo.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HudSelect } from "./HudSelect";
import {
  ajustar,
  ajustarCuandoEsteListo,
  olvidarTamano,
  montarTerminal,
  PROVEEDORES,
  type Catalogo,
  type ModeloInfo,
  type TermInfo,
  type TerminalMontado,
} from "./terminalCore";

type Props = {
  /** Sesion a enseñar. Vacio = el panel deja abrir una. */
  sessionId: string;
  onSession: (id: string) => void;
};

export function TerminalPane({ sessionId, onSession }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [vivas, setVivas] = useState<TermInfo[]>([]);
  const [proveedor, setProveedor] = useState<string>("claude");
  const [modelo, setModelo] = useState<string>("");
  const cajaRef = useRef<HTMLDivElement | null>(null);
  const montado = useRef<TerminalMontado | null>(null);

  useEffect(() => {
    void invoke<Catalogo>("maria_models_catalog")
      .then(setCatalogo)
      .catch(() => setCatalogo(null));
    void invoke<TermInfo[]>("maria_term_list")
      .then((l) => setVivas((l ?? []).filter((t) => t.running)))
      .catch(() => setVivas([]));
  }, [sessionId]);

  // Monta el xterm de esta sesion. Al cambiar de sesion se suelta el anterior
  // (el PTY sigue vivo: solo se deja de mirar).
  useEffect(() => {
    let cancelado = false;
    const caja = cajaRef.current;
    if (!sessionId || !caja) return;
    void (async () => {
      const m = await montarTerminal(sessionId, caja, setError).catch((e) => {
        setError(String(e));
        return null;
      });
      if (!m) return;
      if (cancelado) {
        m.soltar();
        return;
      }
      montado.current = m;
      ajustarCuandoEsteListo(m, sessionId);
      m.term.focus();
    })();
    return () => {
      cancelado = true;
      montado.current?.soltar();
      montado.current = null;
      olvidarTamano(sessionId);
      caja.replaceChildren();
    };
  }, [sessionId]);

  // Reajuste al redimensionar el panel (mover una division del mosaico).
  useEffect(() => {
    const caja = cajaRef.current;
    if (!caja || !sessionId) return;
    // Amortiguado: el observador dispara en rafaga mientras se anima un
    // panel. Sin esto, cada fotograma era un SIGWINCH para la CLI de dentro.
    let pendiente = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(pendiente);
      pendiente = window.setTimeout(() => {
        if (montado.current) ajustar(montado.current, sessionId);
      }, 120);
    });
    ro.observe(caja);
    return () => {
      window.clearTimeout(pendiente);
      ro.disconnect();
    };
  }, [sessionId]);

  const modelos: ModeloInfo[] =
    catalogo?.providers.find((c) => c.provider === proveedor)?.models ?? [];

  async function abrir() {
    setError(null);
    const id = await invoke<string>("maria_term_open", {
      provider: proveedor,
      cwd: null,
      model: modelo || null,
    }).catch((e) => {
      setError(String(e));
      return null;
    });
    if (id) onSession(id);
  }

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <p className="hud-label">este panel no tiene sesión</p>
        <div className="flex flex-wrap items-end gap-2">
          <HudSelect
            etiqueta="cli"
            valor={proveedor}
            ancho={140}
            opciones={PROVEEDORES.map((p) => ({ id: p.id, label: p.label }))}
            onChange={(v) => {
              setProveedor(v);
              setModelo("");
            }}
          />
          <HudSelect
            etiqueta="modelo"
            valor={modelo}
            vacio="por defecto de la CLI"
            ancho={170}
            opciones={modelos.map((m) => ({ id: m.id, label: m.label, hint: m.para }))}
            onChange={setModelo}
          />
          <button
            type="button"
            onClick={() => void abrir()}
            className="hud-panel px-3 text-[13px]"
            style={{
              minHeight: 38,
              color: "var(--color-accent)",
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            + abrir
          </button>
        </div>

        {vivas.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="hud-label">…o engancha una ya abierta:</span>
            {vivas.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onSession(t.id)}
                className="hud-panel px-2 py-1 text-left text-[11px]"
                style={{ color: "var(--color-text-secondary)", cursor: "pointer" }}
              >
                {t.provider}
                {t.model ? ` · ${t.model}` : ""}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p
            className="px-2 py-1 text-[11px]"
            style={{ border: "1px solid var(--color-danger)", color: "var(--color-danger)" }}
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {error && (
        <p
          className="mx-2 mt-2 px-2 py-1 text-[11px]"
          style={{ border: "1px solid var(--color-danger)", color: "var(--color-danger)" }}
        >
          {error}
        </p>
      )}
      <div ref={cajaRef} className="min-h-0 flex-1 p-1" />
    </div>
  );
}
