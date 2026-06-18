import { Clipboard, Code, Eye, FileText, Sparkles } from "../icons";
import {
  COMMON_TOOLS,
  MAX_DESCRIPTION_CHARS,
  MIN_BODY_CHARS,
  type AgentTemplate,
  type AgentTemplateId,
} from "../creatorTemplates";
import type { ModelChoice } from "./types";
import type { TargetScope } from "../../../types";
import { FieldLabel, HelperText, ScopeRadio, SummaryRow } from "./atoms";
import { MarkdownPreview } from "./MarkdownPreview";

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
        Templates seed the system prompt, tools list, and model preset.
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
                  {tpl.model || "default"}
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
          Draft with AI — copies a prompt you can paste into Claude.
        </span>
        <button
          className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
          style={{ borderColor: "var(--color-border)" }}
          onClick={onCopyAiPrompt}
        >
          <Clipboard size={12} /> {aiCopied ? "Copied + session opened" : "Generate with AI"}
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
  toolsSelected: string[];
  toggleTool: (t: string) => void;
}) {
  const {
    name, setName, nameValid,
    description, setDescription, descriptionValid, descriptionTooShort,
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
          placeholder="my-agent"
        />
        {name && !nameValid && (
          <HelperText error>
            Lowercase letters, digits, single dashes only.
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
          placeholder="One sentence: what this subagent does and when to dispatch it."
        />
        {description && !descriptionValid && (
          <HelperText error>
            Description must be 1 to {MAX_DESCRIPTION_CHARS} characters.
          </HelperText>
        )}
        {descriptionTooShort && (
          <HelperText>Short descriptions are dispatched less often.</HelperText>
        )}
      </FieldLabel>

      <FieldLabel label="Model">
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

      <FieldLabel label="Tools (the subagent will have access to these)">
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
          Pick the smallest set the subagent actually needs.
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
          Subagent system prompt body in markdown.
        </p>
        <button
          onClick={togglePreview}
          className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
          style={{ borderColor: "var(--color-border)" }}
        >
          {previewOpen ? <Code size={12} /> : <Eye size={12} />}
          {previewOpen ? "Hide preview" : "Show preview"}
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
          Body is {body.trim().length} chars; needs at least {MIN_BODY_CHARS}.
        </HelperText>
      )}
      {bodyMissingExample && (
        <HelperText>
          Tip: subagents that declare an explicit Output section perform better.
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
    toolsSelected: string[];
  };
}) {
  const { scope, setScope, projects, projectId, setProjectId, targetValid, summary } = props;
  return (
    <div className="space-y-4">
      <FieldLabel label="Install scope">
        <div className="flex gap-3">
          <ScopeRadio
            label="Global"
            sub="~/.claude/agents/"
            active={scope === "global"}
            onClick={() => setScope("global")}
          />
          <ScopeRadio
            label="Project"
            sub="<project>/.claude/agents/"
            active={scope === "project"}
            onClick={() => setScope("project")}
          />
        </div>
      </FieldLabel>

      {scope === "project" && (
        <FieldLabel label="Project">
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
            <option value="">(pick project)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!projectId && (
            <HelperText error>Project required for project scope.</HelperText>
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
        <div className="mb-2 font-semibold">Summary</div>
        <SummaryRow k="Template" v={summary.templateId} />
        <SummaryRow k="Name" v={summary.name || "(missing)"} />
        <SummaryRow k="Description" v={summary.description || "(missing)"} />
        <SummaryRow k="Model" v={summary.model || "default"} />
        {summary.toolsSelected.length > 0 && (
          <SummaryRow k="Tools" v={summary.toolsSelected.join(", ")} />
        )}
        <SummaryRow k="Body" v={`${summary.body.trim().length} chars`} />
      </div>

      {!targetValid && (
        <HelperText error>Pick a target before creating.</HelperText>
      )}
    </div>
  );
}
