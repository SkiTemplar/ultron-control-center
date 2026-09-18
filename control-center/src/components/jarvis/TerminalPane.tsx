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
import {
  ajustar,
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
      ajustar(m, sessionId);
      m.term.focus();
    })();
    return () => {
      cancelado = true;
      montado.current?.soltar();
      montado.current = null;
      caja.replaceChildren();
    };
  }, [sessionId]);

  // Reajuste al redimensionar el panel (mover una division del mosaico).
  useEffect(() => {
    const caja = cajaRef.current;
    if (!caja || !sessionId) return;
    const ro = new ResizeObserver(() => {
      if (montado.current) ajustar(montado.current, sessionId);
    });
    ro.observe(caja);
    return () => ro.disconnect();
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
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={proveedor}
            onChange={(e) => {
              setProveedor(e.target.value);
              setModelo("");
            }}
            aria-label="cli"
            className="hud-panel px-1 py-1 text-[11px]"
            style={{ color: "var(--color-accent)", fontFamily: "var(--font-mono)" }}
          >
            {PROVEEDORES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
            aria-label="modelo"
            disabled={modelos.length === 0}
            className="hud-panel px-1 py-1 text-[11px]"
            style={{
              color: modelo ? "var(--color-accent)" : "var(--color-text-secondary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            <option value="">por defecto</option>
            {modelos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void abrir()}
            className="hud-panel hud-label px-2 py-1"
            style={{ color: "var(--color-accent)", cursor: "pointer" }}
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
