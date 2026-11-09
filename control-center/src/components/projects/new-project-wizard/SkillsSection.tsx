// Sección "Skills de la pool" del paso Opciones: una casilla por entrada
// kind "skill" de la pool de terceros, con licencia y una línea de
// condiciones sacada de su revisión de seguridad. Con la pool vacía o
// inexistente no se pinta; si no se puede leer, lo dice y ofrece reintentar.

import { ErrorBox } from "./ErrorBox";
import type { SkillPickerState } from "./useSkillPicker";

export interface SkillsSectionProps {
  picker: SkillPickerState;
}

const mutedStyle = { color: "var(--color-text-tertiary)" } as const;

export function SkillsSection({ picker }: SkillsSectionProps) {
  const { skills, error, loading, selected, toggle, reload } = picker;

  if (loading) {
    return (
      <p className="text-[11.5px]" style={mutedStyle} aria-live="polite">
        Cargando la pool de skills…
      </p>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <ErrorBox message={`No se pudo leer la pool de skills (${error.code}): ${error.message}`} />
        <p className="text-[11.5px]" style={mutedStyle}>
          Si creas el proyecto ahora, se creará sin skills de la pool.
        </p>
        <button
          type="button"
          onClick={reload}
          className="rounded px-3 py-1 text-[12px]"
          style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
        >
          Reintentar
        </button>
      </div>
    );
  }

  if (!skills || skills.length === 0) return null;

  return (
    <fieldset className="space-y-2">
      <legend className="text-[10px] uppercase tracking-wide" style={mutedStyle}>
        Skills de la pool
      </legend>
      <p className="text-[11px]" style={mutedStyle}>
        Se enlazan en .claude/skills del proyecto. Vienen marcadas las que sugiere la plantilla.
      </p>
      <ul className="space-y-1.5">
        {skills.map((s) => (
          <li key={s.name}>
            <label
              className="flex items-start gap-2 text-[12.5px]"
              style={{ color: s.reviewed ? "var(--color-text)" : "var(--color-text-faint)" }}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selected.includes(s.name)}
                disabled={!s.reviewed}
                onChange={() => toggle(s.name)}
              />
              <span className="min-w-0">
                <span className="font-medium">{s.name}</span>
                <span className="ml-2 text-[11px]" style={mutedStyle}>{s.license ?? "licencia desconocida"}</span>
                {s.suggested && (
                  <span className="ml-2 text-[11px]" style={{ color: "var(--color-accent)" }}>sugerida</span>
                )}
                <span className="block text-[11px]" style={mutedStyle}>
                  {s.reviewed
                    ? s.conditions || "Sin notas de revisión."
                    : "Sin revisión de seguridad: no se puede enlazar al crear."}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
