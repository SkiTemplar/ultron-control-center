// Revisión de un script antes de ejecutarlo: el texto íntegro a la vista y un
// botón de confirmar que solo se habilita cuando ese texto se ha podido leer.

import type { BatchRunReview } from "./types";
import { REASON_LABEL, formatBytes } from "./utils";

type RunReviewProps = {
  review: BatchRunReview;
  onConfirm: () => void;
  onCancel: () => void;
};

const NOTICE_STYLE = { color: "var(--color-text-secondary)" };

function ScriptBody({ review }: { review: BatchRunReview }) {
  if (review.status === "loading") {
    return (
      <p className="mt-1.5 text-[11px]" style={NOTICE_STYLE}>
        Leyendo el script…
      </p>
    );
  }
  if (review.status === "error") {
    return (
      <p className="mt-1.5 text-[11px]" role="alert" style={{ color: "var(--color-danger)" }}>
        No se puede enseñar el script, así que no se puede ejecutar: {review.message}
      </p>
    );
  }
  if (review.script.too_large) {
    return (
      <p className="mt-1.5 text-[11px]" role="alert" style={{ color: "var(--color-danger)" }}>
        El script pesa {formatBytes(review.script.size_bytes)} y no cabe en esta revisión, así que
        no se puede ejecutar desde aquí. Ábrelo a mano en {review.script.path}.
      </p>
    );
  }
  return (
    <pre
      aria-label={`Contenido de ${review.name}`}
      className="mt-1.5 max-h-[220px] overflow-y-auto rounded p-2 text-[10.5px] leading-snug"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
        color: "var(--color-text)",
        fontFamily: "var(--font-mono)",
        // Nada se queda fuera de la vista por la derecha: se revisa todo.
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {review.script.content || "(script vacío)"}
    </pre>
  );
}

export function RunReview({ review, onConfirm, onCancel }: RunReviewProps) {
  const canRun = review.status === "ready" && !review.script.too_large;
  const reason = review.queueEntry?.reason;
  return (
    <section
      aria-label={`Revisar ${review.name}`}
      className="px-3 py-2"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <div
        className="truncate text-[12px] font-medium"
        style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
        title={review.name}
      >
        ¿Ejecutar {review.name}?
      </div>
      {reason && (
        <p className="mt-1 text-[10.5px] leading-snug" style={{ color: "var(--color-warning, #d29922)" }}>
          En cola por: {REASON_LABEL[reason]}. Viene de una sesión de IA: léelo antes de lanzarlo.
        </p>
      )}
      <ScriptBody review={review} />
      <p className="mt-1.5 text-[10px] leading-snug" style={NOTICE_STYLE}>
        Corre con tu usuario, sin consola y con un tope de 5 minutos.
      </p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!canRun}
          onClick={onConfirm}
          className="rounded px-2 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "rgba(248,81,73,0.15)",
            color: "var(--color-danger)",
            border: "1px solid rgba(248,81,73,0.40)",
          }}
        >
          Ejecutar
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-0.5 text-[10.5px] transition-colors"
          style={{
            background: "transparent",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
        >
          Cancelar
        </button>
      </div>
    </section>
  );
}
