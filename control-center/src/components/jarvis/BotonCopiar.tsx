// Botón de copiar de un mensaje, al estilo del de Claude Desktop.
//
// Lo pidió el usuario el 2026-09-21: "un botón pequeño al final, igual que los
// que tiene claude desktop para poder copiar el mensaje de respuesta, como los
// míos, en general todo lo que se mande".
//
// Discreto: se ve al pasar por encima del mensaje y confirma con un "copiado"
// que se va solo. Un botón que no confirma deja con la duda de si copió.

import { useEffect, useState } from "react";

export function BotonCopiar({ texto, etiqueta = "copiar" }: { texto: string; etiqueta?: string }) {
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!copiado && !error) return;
    const t = window.setTimeout(() => {
      setCopiado(false);
      setError(false);
    }, 1800);
    return () => window.clearTimeout(t);
  }, [copiado, error]);

  if (!texto.trim()) return null;

  return (
    <button
      type="button"
      title={error ? "no pude copiar" : "copiar este mensaje"}
      aria-label="copiar este mensaje"
      onClick={() => {
        void navigator.clipboard
          .writeText(texto)
          .then(() => setCopiado(true))
          // Si el portapapeles falla se DICE, no se finge que copió.
          .catch(() => setError(true));
      }}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] transition-opacity"
      style={{
        background: "transparent",
        border: "1px solid var(--color-border)",
        color: error
          ? "var(--color-danger)"
          : copiado
            ? "var(--color-success)"
            : "var(--color-text-tertiary)",
        cursor: "pointer",
      }}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {copiado ? (
          <path
            d="M3 8.5 6.2 12 13 4.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <>
            <rect
              x="5.5"
              y="5.5"
              width="8"
              height="9"
              rx="1.3"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M10.5 3.5H3.8c-.7 0-1.3.6-1.3 1.3V11"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
      {error ? "no pude" : copiado ? "copiado" : etiqueta}
    </button>
  );
}
