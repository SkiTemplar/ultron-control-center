// Paso 5 del asistente: elegir la plantilla (filtrada por kind en el hook)
// y, si aplica, la fecha de entrega.

import type { CliError, CliTemplate } from "../../../lib/project-create-cli";
import { ErrorBox } from "./ErrorBox";
import { labelStyle, inputStyle } from "./types";

export interface PlantillaStepProps {
  templates: CliTemplate[] | null;
  error: CliError | null;
  templateId: string | null;
  onSelect: (id: string) => void;
  dueDate: string;
  onDueDateChange: (v: string) => void;
  showDueDate: boolean;
}

export function PlantillaStep({
  templates, error, templateId, onSelect, dueDate, onDueDateChange, showDueDate,
}: PlantillaStepProps) {
  if (error) return <ErrorBox message={error.message} />;
  if (!templates) return <p className="text-[12px]" style={labelStyle}>Cargando plantillas…</p>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => t.available && onSelect(t.id)}
            disabled={!t.available}
            className="flex flex-col items-start gap-1 rounded p-2.5 text-left transition-colors disabled:opacity-40"
            style={{
              background: templateId === t.id ? "var(--color-surface-3)" : "var(--color-surface-0)",
              border: `1px solid ${templateId === t.id ? "var(--color-accent)" : "var(--color-border-strong)"}`,
            }}
            title={!t.available && t.requires.length ? `Requiere: ${t.requires.join(", ")}` : t.description}
          >
            <span className="text-[12px] font-medium" style={{ color: "var(--color-text)" }}>{t.label}</span>
            <span className="text-[10.5px] leading-snug" style={labelStyle}>{t.description}</span>
            {!t.available && (
              <span className="text-[10px]" style={{ color: "var(--color-warn)" }}>
                No disponible{t.requires.length ? ` — requiere: ${t.requires.join(", ")}` : ""}
              </span>
            )}
          </button>
        ))}
      </div>
      {showDueDate && (
        <div>
          <label className="text-[10px] uppercase tracking-wide" style={labelStyle}>Fecha de entrega</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => onDueDateChange(e.target.value)}
            className="mt-1 rounded px-2 py-1.5 text-[12.5px]"
            style={inputStyle}
          />
        </div>
      )}
    </div>
  );
}
