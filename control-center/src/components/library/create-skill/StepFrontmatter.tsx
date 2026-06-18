// Step 2 — Frontmatter form (name, description, tags, model, tools).

import { COMMON_TOOLS, MAX_DESCRIPTION_CHARS } from "../creatorTemplates";
import { Chip, FieldLabel, HelperText } from "./ui-primitives";

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
      <FieldLabel label="Name (kebab-case, required)">
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
          placeholder="my-skill"
        />
        {name && !nameValid && (
          <HelperText error>
            Lowercase letters, digits, and single dashes only. No leading or
            trailing dash.
          </HelperText>
        )}
      </FieldLabel>

      <FieldLabel
        label={`Description (required, ${description.length}/${MAX_DESCRIPTION_CHARS})`}
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
          placeholder="One sentence: when to activate this skill and what it produces."
        />
        {description && !descriptionValid && (
          <HelperText error>
            Description must be 1 to {MAX_DESCRIPTION_CHARS} characters.
          </HelperText>
        )}
        {descriptionTooShort && (
          <HelperText>Short descriptions trigger less reliably.</HelperText>
        )}
      </FieldLabel>

      <FieldLabel label="Tags (comma-separated, optional)">
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

      <FieldLabel label="Model (optional)">
        <div className="flex gap-2">
          {(["", "haiku", "sonnet", "opus"] as const).map((m) => (
            <button
              key={m || "default"}
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

      <FieldLabel label="Tools (optional)">
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
