// Paso 3 del asistente: navegador de subcarpetas con breadcrumb, para que
// el usuario nunca tenga que abrir el Explorador de Windows.

import type { CliEntry, CliError } from "../../../lib/project-create-cli";
import { ErrorBox } from "./ErrorBox";
import { labelStyle, inputStyle } from "./types";

export interface CarpetaStepProps {
  rootLabel: string;
  baseSub: string;
  crumbs: string[];
  onCrumb: (depth: number) => void;
  entries: CliEntry[] | null;
  loading: boolean;
  error: CliError | null;
  onEnter: (entry: CliEntry) => void;
  showNew: boolean;
  onToggleNew: () => void;
  newName: string;
  onNewNameChange: (v: string) => void;
  busy: boolean;
  onCreateFolder: () => void;
}

export function CarpetaStep({
  rootLabel, baseSub, crumbs, onCrumb, entries, loading, error, onEnter,
  showNew, onToggleNew, newName, onNewNameChange, busy, onCreateFolder,
}: CarpetaStepProps) {
  return (
    <div className="space-y-3">
      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 text-[11.5px]">
        <button type="button" onClick={() => onCrumb(0)} style={{ color: "var(--color-accent)" }}>
          {baseSub ? baseSub.split("/").pop() : rootLabel}
        </button>
        {crumbs.map((c, i) => (
          <span key={`${c}-${i}`} className="flex items-center gap-1">
            <span style={{ color: "var(--color-text-faint)" }}>/</span>
            <button type="button" onClick={() => onCrumb(i + 1)} style={{ color: "var(--color-accent)" }}>{c}</button>
          </span>
        ))}
      </div>

      {error && <ErrorBox message={error.message} />}
      {loading && <p className="text-[12px]" style={labelStyle}>Cargando carpetas…</p>}
      {!loading && entries && (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded p-2" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}>
          {entries.filter((e) => e.isDir).length === 0 && (
            <p className="px-1 py-2 text-[11.5px]" style={labelStyle}>Sin subcarpetas. El proyecto se creará aquí.</p>
          )}
          {entries.filter((e) => e.isDir).map((e) => (
            <button
              key={e.relPath}
              type="button"
              onClick={() => onEnter(e)}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] transition-colors"
              style={{ color: "var(--color-text)" }}
              onMouseDown={(ev) => ev.preventDefault()}
            >
              <span>📁 {e.name}</span>
              {e.isProject && (
                <span className="text-[10px]" style={{ color: "var(--color-warn)" }}>proyecto</span>
              )}
            </button>
          ))}
        </div>
      )}

      <button type="button" onClick={onToggleNew} className="text-[11.5px]" style={{ color: "var(--color-accent)" }}>
        {showNew ? "Cancelar" : "+ Nueva subcarpeta"}
      </button>
      {showNew && (
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => onNewNameChange(e.target.value)}
            placeholder="Nombre de la subcarpeta"
            className="flex-1 rounded px-2 py-1.5 text-[12px]"
            style={inputStyle}
            disabled={busy}
          />
          <button
            type="button"
            onClick={onCreateFolder}
            disabled={busy || !newName.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
          >
            Crear
          </button>
        </div>
      )}
    </div>
  );
}
