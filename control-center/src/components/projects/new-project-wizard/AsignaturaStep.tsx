// Paso 2 del asistente (solo root.kind === "asignatura"): elegir o crear
// la asignatura donde vivira el proyecto.

import type { CliEntry, CliError } from "../../../lib/project-create-cli";
import { ErrorBox } from "./ErrorBox";
import { labelStyle, inputStyle } from "./types";

export interface AsignaturaStepProps {
  subjects: CliEntry[] | null;
  error: CliError | null;
  selectedRelPath: string | null;
  onSelect: (relPath: string) => void;
  showNew: boolean;
  onToggleNew: () => void;
  code: string;
  onCodeChange: (v: string) => void;
  name: string;
  onNameChange: (v: string) => void;
  busy: boolean;
  createError: string | null;
  onCreate: () => void;
}

export function AsignaturaStep({
  subjects, error, selectedRelPath, onSelect,
  showNew, onToggleNew, code, onCodeChange, name, onNameChange,
  busy, createError, onCreate,
}: AsignaturaStepProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className="text-[10px] uppercase tracking-wide" style={labelStyle}>Asignatura</label>
        {error && <ErrorBox message={error.message} />}
        {!error && (
          <select
            value={selectedRelPath ?? ""}
            onChange={(e) => onSelect(e.target.value)}
            className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
            style={inputStyle}
          >
            <option value="" disabled>
              {subjects === null ? "Cargando…" : "Elige una asignatura"}
            </option>
            {subjects?.map((s) => (
              <option key={s.relPath} value={s.relPath}>{s.name}</option>
            ))}
          </select>
        )}
      </div>
      <button
        type="button"
        onClick={onToggleNew}
        className="text-[11.5px]"
        style={{ color: "var(--color-accent)" }}
      >
        {showNew ? "Cancelar" : "+ Nueva asignatura"}
      </button>
      {showNew && (
        <div className="space-y-2 rounded p-3" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}>
          <div>
            <label className="text-[10px] uppercase tracking-wide" style={labelStyle}>Código (p.ej. ASIG)</label>
            <input
              type="text"
              value={code}
              onChange={(e) => onCodeChange(e.target.value)}
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
              style={inputStyle}
              disabled={busy}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide" style={labelStyle}>Nombre</label>
            <input
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
              style={inputStyle}
              disabled={busy}
            />
          </div>
          {createError && <ErrorBox message={createError} />}
          <button
            type="button"
            onClick={onCreate}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {busy ? "Creando…" : "Crear asignatura"}
          </button>
        </div>
      )}
    </div>
  );
}
