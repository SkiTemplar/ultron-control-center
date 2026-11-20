import { Clipboard, Code, Eye, FileText, Sparkles } from "../icons";
import {
  AGENT_MODELS,
  COMMON_TOOLS,
  MAX_MAX_TURNS,
  MIN_MAX_TURNS,
  MAX_DESCRIPTION_CHARS,
  MIN_BODY_CHARS,
  type AgentTemplate,
  type AgentTemplateId,
} from "../creatorTemplates";
import type { ModelChoice } from "./types";
import type { TargetScope } from "../../../types";
import { FieldLabel, HelperText, ScopeRadio, SummaryRow } from "../wizard-ui";
import { MarkdownPreview } from "../MarkdownPreview";

export function StepTemplates(props: {
  templates: AgentTemplate[];
  selectedId: AgentTemplateId;
  onPick: (id: AgentTemplateId) => void;
  aiCopied: boolean;
  onCopyAiPrompt: () => void;
}) {
  const { templates, selectedId, onPick, aiCopied, onCopyAiPrompt } = props;
  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
        Las plantillas rellenan el system prompt, la lista de herramientas y el modelo.
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {templates.map((tpl) => {
          const active = tpl.id === selectedId;
          return (
            <button
              key={tpl.id}
              onClick={() => onPick(tpl.id)}
              className="flex flex-col items-start gap-1 rounded border p-3 text-left transition-colors"
              style={{
                borderColor: active
                  ? "var(--color-accent)"
                  : "var(--color-border)",
                background: active
                  ? "var(--color-surface-2)"
                  : "var(--color-surface-1)",
              }}
            >
              <div className="flex w-full items-center gap-2">
                <FileText size={14} />
                <span className="text-sm font-medium">{tpl.label}</span>
                <span
                  className="ml-auto font-mono text-[10px]"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {tpl.model} · {tpl.maxTurns} turnos
                </span>
              </div>
              <span
                className="text-xs"
                style={{ color: "var(--color-text-muted)" }}
              >
                {tpl.hint}
              </span>
              <div className="mt-1 flex flex-wrap gap-1">
                {tpl.tools.map((t) => (
                  <span
                    key={t}
                    className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                    style={{ background: "var(--color-surface-3)" }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
      <div
        className="flex items-center gap-2 rounded border p-3"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
        }}
      >
        <Sparkles size={14} />
        <span className="flex-1 text-xs">
          Borrador con IA: abre en Sessions un prompt para que Claude lo redacte.
        </span>
        <button
          className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
          style={{ borderColor: "var(--color-border)" }}
          onClick={onCopyAiPrompt}
        >
          <Clipboard size={12} /> {aiCopied ? "Enviado a Sessions" : "Generar con IA"}
        </button>
      </div>
    </div>
  );
}

export function StepFrontmatter(props: {
  name: string;
  setName: (v: string) => void;
  nameValid: boolean;
  description: string;
  setDescription: (v: string) => void;
  descriptionValid: boolean;
  descriptionTooShort: boolean;
  model: ModelChoice;
  setModel: (v: ModelChoice) => void;
  maxTurns: number;
  setMaxTurns: (v: number) => void;
  maxTurnsValid: boolean;
  toolsSelected: string[];
  toggleTool: (t: string) => void;
}) {
  const {
    name, setName, nameValid,
    description, setDescription, descriptionValid, descriptionTooShort,
    model, setModel,
    maxTurns, setMaxTurns, maxTurnsValid,
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
          placeholder="mi-agente"
        />
        {name && !nameValid && (
          <HelperText error>
            Solo minúsculas, dígitos y guiones sueltos.
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
          placeholder="Una frase: qué hace este subagente y cuándo delegarle."
        />
        {description && !descriptionValid && (
          <HelperText error>
            La descripción debe tener entre 1 y {MAX_DESCRIPTION_CHARS} caracteres.
          </HelperText>
        )}
        {descriptionTooShort && (
          <HelperText>Con una descripción corta se delega menos en él.</HelperText>
        )}
      </FieldLabel>

      <FieldLabel label="Modelo">
        <div className="flex gap-2">
          {AGENT_MODELS.map((m) => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              className="rounded border px-2 py-1 text-xs"
              style={{
                borderColor:
                  model === m.id
                    ? "var(--color-accent)"
                    : "var(--color-border)",
                background:
                  model === m.id
                    ? "var(--color-surface-2)"
                    : "var(--color-surface-1)",
              }}
            >
              <span className="font-mono">{m.id}</span>
            </button>
          ))}
        </div>
      </FieldLabel>

      <FieldLabel label={`Tope de turnos (maxTurns, ${MIN_MAX_TURNS}-${MAX_MAX_TURNS})`}>
        <input
          type="number"
          min={MIN_MAX_TURNS}
          max={MAX_MAX_TURNS}
          step={1}
          className="w-32 rounded border bg-[var(--color-surface-2)] px-2 py-1 font-mono outline-none"
          style={{
            borderColor: maxTurnsValid
              ? "var(--color-border)"
              : "var(--color-error)",
          }}
          value={Number.isNaN(maxTurns) ? "" : maxTurns}
          onChange={(e) => setMaxTurns(e.target.valueAsNumber)}
        />
        {maxTurnsValid ? (
          <HelperText>
            Referencia: 200 implementación, 120 depuración/tests, 100 revisión, 80 diseño, 60 investigación/resumen.
          </HelperText>
        ) : (
          <HelperText error>
            Debe ser un entero entre {MIN_MAX_TURNS} y {MAX_MAX_TURNS}.
          </HelperText>
        )}
      </FieldLabel>

      <FieldLabel label="Herramientas (el subagente tendrá acceso a ellas)">
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
        <HelperText>
          Elige el conjunto mínimo que el subagente necesita de verdad.
        </HelperText>
      </FieldLabel>
    </div>
  );
}

export function StepBody(props: {
  body: string;
  setBody: (v: string) => void;
  bodyValid: boolean;
  bodyMissingExample: boolean;
  previewOpen: boolean;
  togglePreview: () => void;
}) {
  const { body, setBody, bodyValid, bodyMissingExample, previewOpen, togglePreview } = props;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          Cuerpo del system prompt del subagente, en markdown.
        </p>
        <button
          onClick={togglePreview}
          className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
          style={{ borderColor: "var(--color-border)" }}
        >
          {previewOpen ? <Code size={12} /> : <Eye size={12} />}
          {previewOpen ? "Ocultar vista previa" : "Mostrar vista previa"}
        </button>
      </div>
      <div className={previewOpen ? "grid grid-cols-2 gap-3" : ""}>
        <textarea
          className="h-[420px] w-full rounded border bg-[var(--color-surface-2)] p-2 font-mono text-xs outline-none"
          style={{
            borderColor:
              body && !bodyValid
                ? "var(--color-error)"
                : "var(--color-border)",
          }}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
        />
        {previewOpen && (
          <div
            className="h-[420px] overflow-auto rounded border p-3 text-xs"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-2)",
            }}
          >
            <MarkdownPreview source={body} />
          </div>
        )}
      </div>
      {body && !bodyValid && (
        <HelperText error>
          El cuerpo tiene {body.trim().length} caracteres; necesita al menos {MIN_BODY_CHARS}.
        </HelperText>
      )}
      {bodyMissingExample && (
        <HelperText>
          Consejo: los subagentes que declaran una sección de salida explícita rinden mejor.
        </HelperText>
      )}
    </div>
  );
}

export function StepTarget(props: {
  scope: TargetScope;
  setScope: (s: TargetScope) => void;
  projects: { id: string; name: string }[];
  projectId: string | null;
  setProjectId: (v: string | null) => void;
  targetValid: boolean;
  summary: {
    templateId: AgentTemplateId;
    name: string;
    description: string;
    body: string;
    model: string;
    maxTurns: number;
    toolsSelected: string[];
  };
}) {
  const { scope, setScope, projects, projectId, setProjectId, targetValid, summary } = props;
  return (
    <div className="space-y-4">
      <FieldLabel label="Ámbito de instalación">
        <div className="flex gap-3">
          <ScopeRadio
            label="Global"
            sub="~/.claude/agents/"
            active={scope === "global"}
            onClick={() => setScope("global")}
          />
          <ScopeRadio
            label="Proyecto"
            sub="<proyecto>/.claude/agents/"
            active={scope === "project"}
            onClick={() => setScope("project")}
          />
        </div>
      </FieldLabel>

      {scope === "project" && (
        <FieldLabel label="Proyecto">
          <select
            className="w-full rounded border bg-[var(--color-surface-2)] px-2 py-1 text-sm"
            style={{
              borderColor: !projectId
                ? "var(--color-error)"
                : "var(--color-border)",
            }}
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value || null)}
          >
            <option value="">(elige proyecto)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!projectId && (
            <HelperText error>El ámbito de proyecto necesita un proyecto.</HelperText>
          )}
        </FieldLabel>
      )}

      <div
        className="rounded border p-3 text-xs"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
        }}
      >
        <div className="mb-2 font-semibold">Resumen</div>
        <SummaryRow k="Plantilla" v={summary.templateId} />
        <SummaryRow k="Nombre" v={summary.name || "(falta)"} />
        <SummaryRow k="Descripción" v={summary.description || "(falta)"} />
        <SummaryRow k="Modelo" v={summary.model} />
        <SummaryRow k="maxTurns" v={String(summary.maxTurns)} />
        {summary.toolsSelected.length > 0 && (
          <SummaryRow k="Herramientas" v={summary.toolsSelected.join(", ")} />
        )}
        <SummaryRow k="Cuerpo" v={`${summary.body.trim().length} caracteres`} />
      </div>

      {!targetValid && (
        <HelperText error>Elige un destino antes de crear.</HelperText>
      )}
    </div>
  );
}
