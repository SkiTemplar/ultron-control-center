// Step 2 — Frontmatter form (name, description, tags, model, tools).

import { COMMON_TOOLS, MAX_DESCRIPTION_CHARS } from "../creatorTemplates";
import { Chip, FieldLabel, HelperText } from "../wizard-ui";

type StepFrontmatterProps = {
  name: string;
  setName: (v: string) => void;
  nameValid: boolean;
  description: string;
  setDescription: (v: string) => void;
  descriptionValid: boolean;
  descriptionTooShort: boolean;
  tagsRaw: string;
  setTagsRaw: (v: string) => void;
  tags: string[];
  model: "" | "haiku" | "sonnet" | "opus";
  setModel: (v: "" | "haiku" | "sonnet" | "opus") => void;
  toolsSelected: string[];
  toggleTool: (t: string) => void;
};

export function StepFrontmatter(props: StepFrontmatterProps) {
  const {
    name, setName, nameValid,
    description, setDescription, descriptionValid, descriptionTooShort,
    tagsRaw, setTagsRaw, tags,
    model, setModel,
    toolsSelected, toggleTool,
  } = props;
  return (
    <div className="space-y-4">
      <FieldLabel label="Nombre (kebab-case, obligatorio)">
        <input
          className="w-full rounded border bg-[var(--color-surface-2)] px-2 py-1 font-mono outline-none"
          style={{
            borderColor:
              name && !nameValid
                ? "var(--color-error)"
                : "var(--color-border)",
          }}
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="mi-skill"
        />
        {name && !nameValid && (
          <HelperText error>
            Solo minúsculas, dígitos y guiones sueltos. Sin guion al principio ni al final.
          </HelperText>
        )}
      </FieldLabel>

      <FieldLabel
        label={`Descripción (obligatoria, ${description.length}/${MAX_DESCRIPTION_CHARS})`}
      >
        <textarea
          className="h-16 w-full rounded border bg-[var(--color-surface-2)] px-2 py-1 outline-none"
          style={{
            borderColor:
              description && !descriptionValid
                ? "var(--color-error)"
                : "var(--color-border)",
          }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Una frase: cuándo activar esta skill y qué produce."
        />
        {description && !descriptionValid && (
          <HelperText error>
            La descripción debe tener entre 1 y {MAX_DESCRIPTION_CHARS} caracteres.
          </HelperText>
        )}
        {descriptionTooShort && (
          <HelperText>Con una descripción corta se activa con menos fiabilidad.</HelperText>
        )}
      </FieldLabel>

      <FieldLabel label="Tags (separadas por comas, opcional)">
        <input
          className="w-full rounded border bg-[var(--color-surface-2)] px-2 py-1 outline-none"
          style={{ borderColor: "var(--color-border)" }}
          value={tagsRaw}
          onChange={(e) => setTagsRaw(e.target.value)}
          placeholder="workflow, review, internal"
        />
        {tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((t) => (
              <Chip key={t}>{t}</Chip>
            ))}
          </div>
        )}
      </FieldLabel>

      <FieldLabel label="Modelo (opcional)">
        <div className="flex gap-2">
          {(["", "haiku", "sonnet", "opus"] as const).map((m) => (
            <button
              key={m || "por defecto"}
              onClick={() => setModel(m)}
              className="rounded border px-2 py-1 text-xs"
              style={{
                borderColor:
                  model === m
                    ? "var(--color-accent)"
                    : "var(--color-border)",
                background:
                  model === m
                    ? "var(--color-surface-2)"
                    : "var(--color-surface-1)",
              }}
            >
              {m || "default"}
            </button>
          ))}
        </div>
      </FieldLabel>

      <FieldLabel label="Herramientas (opcional)">
        <div className="flex flex-wrap gap-1">
          {COMMON_TOOLS.map((t) => {
            const active = toolsSelected.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleTool(t)}
                className="rounded border px-2 py-0.5 text-xs"
                style={{
                  borderColor: active
                    ? "var(--color-accent)"
                    : "var(--color-border)",
                  background: active
                    ? "var(--color-surface-2)"
                    : "var(--color-surface-1)",
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
      </FieldLabel>
    </div>
  );
}
