// Paso 4 del asistente: nombre del proyecto, con autofocus gestionado por
// el hook orquestador (useNewProjectWizard).

import type { RefObject } from "react";
import { labelStyle, inputStyle } from "./types";

export interface NombreStepProps {
  inputRef: RefObject<HTMLInputElement | null>;
  name: string;
  onChange: (v: string) => void;
  error: string | null;
}

export function NombreStep({ inputRef, name, onChange, error }: NombreStepProps) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wide" style={labelStyle}>Nombre del proyecto</label>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded px-2 py-1.5 text-[13px]"
        style={inputStyle}
      />
      {error && <p className="mt-1 text-[11px]" style={{ color: "var(--color-danger)" }}>{error}</p>}
    </div>
  );
}
