// Paso 6 del asistente: opciones finales antes de crear (git, CLAUDE.md,
// IDE a abrir al terminar).

import { IDE_OPTIONS, inputStyle, labelStyle } from "./types";

export interface OpcionesStepProps {
  gitInit: boolean;
  onGitInitChange: (v: boolean) => void;
  claudeMd: boolean;
  onClaudeMdChange: (v: boolean) => void;
  openIde: string;
  onOpenIdeChange: (v: string) => void;
}

export function OpcionesStep({
  gitInit, onGitInitChange, claudeMd, onClaudeMdChange, openIde, onOpenIdeChange,
}: OpcionesStepProps) {
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--color-text)" }}>
        <input type="checkbox" checked={gitInit} onChange={(e) => onGitInitChange(e.target.checked)} />
        Inicializar repositorio git
      </label>
      <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--color-text)" }}>
        <input type="checkbox" checked={claudeMd} onChange={(e) => onClaudeMdChange(e.target.checked)} />
        Crear CLAUDE.md
      </label>
      <div>
        <label className="text-[10px] uppercase tracking-wide" style={labelStyle}>Abrir en IDE al terminar</label>
        <select
          value={openIde}
          onChange={(e) => onOpenIdeChange(e.target.value)}
          className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
          style={inputStyle}
        >
          {IDE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
