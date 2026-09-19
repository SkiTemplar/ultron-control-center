// Diálogo de confirmación para lo que no tiene vuelta atrás.
//
// El usuario lo pidió explícitamente (2026-09-19): «un botón de eliminar […] y
// otro de confirmación para no darle por si acaso». No se usa `window.confirm`
// porque dentro de la webview de Tauri sale con la pinta del navegador, no con
// la de mar.ia, y encima bloquea el hilo.
//
// Tres decisiones a propósito:
//   * El botón peligroso NO es el que tiene el foco: si abres el diálogo y das
//     a Intro sin leer, cancelas.
//   * Escape cancela; no hay atajo para confirmar.
//   * Para lo irreversible de verdad se puede exigir escribir una palabra
//     (`palabraClave`), que es lo que impide el clic automático.

import { useEffect, useRef, useState } from "react";

type Props = {
  titulo: string;
  /** Qué va a pasar exactamente. Sin eufemismos. */
  detalle: string;
  /** Texto del botón peligroso. */
  accion?: string;
  /** Si se indica, hay que teclearlo para que el botón se active. */
  palabraClave?: string;
  onConfirmar: () => void;
  onCancelar: () => void;
};

export function Confirmar({
  titulo,
  detalle,
  accion = "Eliminar",
  palabraClave,
  onConfirmar,
  onCancelar,
}: Props) {
  const [escrito, setEscrito] = useState("");
  const cancelar = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // El foco arranca en Cancelar: un Intro despistado no borra nada.
    cancelar.current?.focus();
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelar();
    };
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, [onCancelar]);

  const listo = !palabraClave || escrito.trim() === palabraClave;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: "rgba(3,7,15,0.72)" }}
      onMouseDown={(e) => {
        // Pulsar fuera cancela; nunca confirma.
        if (e.target === e.currentTarget) onCancelar();
      }}
    >
      <div
        className="hud-panel flex w-full flex-col gap-3 p-4"
        style={{ maxWidth: 480, background: "var(--color-surface-1)" }}
      >
        <h2 className="text-[14px] font-semibold" style={{ color: "var(--color-danger)" }}>
          {titulo}
        </h2>
        <p className="text-[12.5px]" style={{ color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
          {detalle}
        </p>

        {palabraClave && (
          <label className="flex flex-col gap-1 text-[12px]">
            <span style={{ color: "var(--color-text-tertiary)" }}>
              Escribe <strong style={{ color: "var(--color-text)" }}>{palabraClave}</strong> para
              confirmar:
            </span>
            <input
              value={escrito}
              onChange={(e) => setEscrito(e.target.value)}
              autoComplete="off"
              className="px-2 text-[13px]"
              style={{
                minHeight: 38,
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
                outline: "none",
              }}
            />
          </label>
        )}

        <div className="flex justify-end gap-2">
          <button
            ref={cancelar}
            type="button"
            onClick={onCancelar}
            className="px-4 text-[13px]"
            style={{
              minHeight: 38,
              background: "var(--color-surface-3)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text)",
              cursor: "pointer",
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!listo}
            onClick={() => listo && onConfirmar()}
            className="px-4 text-[13px]"
            style={{
              minHeight: 38,
              background: listo ? "rgba(255,77,94,0.12)" : "transparent",
              border: `1px solid ${listo ? "var(--color-danger)" : "var(--color-border)"}`,
              color: listo ? "var(--color-danger)" : "var(--color-text-tertiary)",
              cursor: listo ? "pointer" : "not-allowed",
            }}
          >
            {accion}
          </button>
        </div>
      </div>
    </div>
  );
}
