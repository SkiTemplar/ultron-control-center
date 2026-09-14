// Paso 1 del asistente: elegir la raiz (asignatura/personal) donde vivira
// el proyecto.

import type { CliError, CliRoot } from "../../../lib/project-create-cli";
import { ErrorBox } from "./ErrorBox";
import { labelStyle } from "./types";

export interface TipoStepProps {
  loading: boolean;
  roots: CliRoot[] | null;
  error: CliError | null;
  rootId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}

export function TipoStep({ loading, roots, error, rootId, onSelect, onRetry }: TipoStepProps) {
  if (loading) return <p className="text-[12px]" style={labelStyle}>Cargando raíces…</p>;
  if (error) {
    return (
      <div className="space-y-2">
        <ErrorBox message={`${error.code}: ${error.message}`} />
        {error.code === "ROOTS_NOT_CONFIGURED" && (
          <p className="text-[11.5px]" style={labelStyle}>
            Configura las raíces de asignaturas/personal y vuelve a intentarlo.
          </p>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="rounded px-3 py-1.5 text-[12px] transition-colors"
          style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
        >
          Reintentar
        </button>
      </div>
    );
  }
  if (!roots || roots.length === 0) {
    return <p className="text-[12px]" style={labelStyle}>No hay raíces configuradas.</p>;
  }
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wide" style={labelStyle}>¿Dónde va el proyecto?</label>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {roots.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelect(r.id)}
            disabled={!r.exists}
            className="flex flex-col items-start gap-1 rounded p-3 text-left transition-colors disabled:opacity-40"
            style={{
              background: rootId === r.id ? "var(--color-surface-3)" : "var(--color-surface-0)",
              border: `1px solid ${rootId === r.id ? "var(--color-accent)" : "var(--color-border-strong)"}`,
            }}
            title={!r.exists ? "Carpeta no encontrada en disco" : r.path}
          >
            <span className="text-[12.5px] font-medium" style={{ color: "var(--color-text)" }}>{r.label}</span>
            <span className="text-[10.5px]" style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}>{r.path}</span>
            {!r.exists && <span className="text-[10px]" style={{ color: "var(--color-danger)" }}>Carpeta no encontrada</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
