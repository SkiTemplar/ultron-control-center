// Agent Creator v2 — multi-step wizard mirroring CreateSkillModal.
//
// Step 1: Pick a template (Empty / Reviewer / Researcher / Implementer /
//         Debugger / Coordinator). Each template seeds tools, model, body.
// Step 2: Frontmatter form — name, description, model preset, tools multi-select.
// Step 3: Body editor with live markdown preview.
// Step 4: Target scope + final summary.

import { useMemo, useState } from "react";
import type { TargetScope } from "../../types";
import { agentCreate } from "../../lib/library-client";
import {
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Code,
  Eye,
  FileText,
  Plus,
  Sparkles,
  X,
} from "./icons";
import {
  AGENT_TEMPLATES,
  COMMON_TOOLS,
  MAX_DESCRIPTION_CHARS,
  MIN_BODY_CHARS,
  type AgentTemplate,
  type AgentTemplateId,
  applyName,
} from "./creatorTemplates";

type Props = {
  defaultScope?: TargetScope;
  defaultProjectId?: string;
  projects: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (writtenPath: string) => void;
};

type Step = 1 | 2 | 3 | 4;
type ModelChoice = "" | "haiku" | "sonnet" | "opus";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const AGENT_CREATOR_PROMPT = `You are agent-creator. I want to create a new Claude Code subagent named "{NAME}".

Goal: {DESCRIPTION}

Generate the full subagent system prompt body in markdown. Include:
- The role in one sentence
- A numbered Workflow section
- A clear Output format section
- No YAML frontmatter (the Control Center adds that)

Return only the markdown body. No fences. No commentary.`;

export function CreateAgentModal({
  defaultScope = "global",
  defaultProjectId,
  projects,
  onClose,
  onCreated,
}: Props) {
  const [step, setStep] = useState<Step>(1);
  const [templateId, setTemplateId] = useState<AgentTemplateId>("empty");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [toolsSelected, setToolsSelected] = useState<string[]>([
    "Read",
    "Grep",
    "Glob",
  ]);
  const [model, setModel] = useState<ModelChoice>("");
  const [body, setBody] = useState("");
  const [bodyDirty, setBodyDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [scope, setScope] = useState<TargetScope>(defaultScope);
  const [projectId, setProjectId] = useState<string | null>(
    defaultProjectId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [aiCopied, setAiCopied] = useState(false);

  const template: AgentTemplate =
    AGENT_TEMPLATES.find((t) => t.id === templateId) ?? AGENT_TEMPLATES[0];

  const nameValid = KEBAB_RE.test(name);
  const descriptionValid =
    description.trim().length > 0 &&
    description.length <= MAX_DESCRIPTION_CHARS;
  const bodyValid = body.trim().length >= MIN_BODY_CHARS;
  const targetValid = scope === "global" || !!projectId;

  const descriptionTooShort =
    description.trim().length > 0 && description.trim().length < 20;
  const bodyMissingExample =
    bodyValid && !/```/.test(body) && !/output/i.test(body);

  const canAdvance: Record<Step, boolean> = {
    1: true,
    2: nameValid && descriptionValid,
    3: bodyValid,
    4: targetValid,
  };

  function pickTemplate(id: AgentTemplateId) {
    setTemplateId(id);
    const tpl = AGENT_TEMPLATES.find((t) => t.id === id) ?? AGENT_TEMPLATES[0];
    // Apply the template's tools + model as sensible defaults; only seed
    // the body if the user has not touched it yet (avoids losing edits
    // when they flip between templates).
    setToolsSelected(tpl.tools);
    setModel(tpl.model);
    if (!bodyDirty) {
      setBody(applyName(tpl.body, name || "agent"));
    }
  }

  function toggleTool(t: string) {
    setToolsSelected((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    );
  }

  function advance() {
    if (!canAdvance[step]) return;
    if (step === 1 && !bodyDirty) {
      setBody(applyName(template.body, name || "agent"));
    }
    if (step < 4) setStep((step + 1) as Step);
  }

  function back() {
    if (step > 1) setStep((step - 1) as Step);
  }

  async function copyAiPrompt() {
    const prompt = AGENT_CREATOR_PROMPT.replace("{NAME}", name || "<agent-name>")
      .replace("{DESCRIPTION}", description || "<one-line goal>");
    try {
      await navigator.clipboard.writeText(prompt);
      setAiCopied(true);
      setTimeout(() => setAiCopied(false), 2000);
    } catch {
      setErr("Could not copy to clipboard.");
    }
  }

  async function submit() {
    if (!nameValid || !descriptionValid || !bodyValid || !targetValid) return;
    setBusy(true);
    setErr(null);
    try {
      const written = await agentCreate({
        name,
        description: description.trim(),
        tools: toolsSelected,
        model: model || null,
        body,
        target_scope: scope,
        target_project_id: scope === "project" ? projectId : null,
      });
      onCreated(written);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="flex max-h-[90vh] w-[min(900px,96vw)] flex-col rounded-md border shadow-xl"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
      >
        <Header step={step} onClose={onClose} />

        <div className="flex-1 overflow-y-auto p-5 text-sm">
          {step === 1 && (
            <StepTemplates
              templates={AGENT_TEMPLATES}
              selectedId={templateId}
              onPick={pickTemplate}
              aiCopied={aiCopied}
              onCopyAiPrompt={copyAiPrompt}
            />
          )}

          {step === 2 && (
            <StepFrontmatter
              name={name}
              setName={setName}
              nameValid={nameValid}
              description={description}
              setDescription={setDescription}
              descriptionValid={descriptionValid}
              descriptionTooShort={descriptionTooShort}
              model={model}
              setModel={setModel}
              toolsSelected={toolsSelected}
              toggleTool={toggleTool}
            />
          )}

          {step === 3 && (
            <StepBody
              body={body}
              setBody={(v) => {
                setBody(v);
                setBodyDirty(true);
              }}
              bodyValid={bodyValid}
              bodyMissingExample={bodyMissingExample}
              previewOpen={previewOpen}
              togglePreview={() => setPreviewOpen((v) => !v)}
            />
          )}

          {step === 4 && (
            <StepTarget
              scope={scope}
              setScope={setScope}
              projects={projects}
              projectId={projectId}
              setProjectId={setProjectId}
              targetValid={targetValid}
              summary={{
                templateId,
                name,
                description,
                body,
                model,
                toolsSelected,
              }}
            />
          )}

          {err && (
            <div
              className="mt-4 rounded border p-2 text-xs"
              style={{
                borderColor: "var(--color-error)",
                background: "var(--color-surface-1)",
                color: "var(--color-error)",
              }}
            >
              {err}
            </div>
          )}
        </div>

        <Footer
          step={step}
          canAdvance={canAdvance[step]}
          canSubmit={nameValid && descriptionValid && bodyValid && targetValid}
          busy={busy}
          onBack={back}
          onNext={advance}
          onCancel={onClose}
          onSubmit={submit}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers — same shape as CreateSkillModal but with "agent" labels.
// ---------------------------------------------------------------------------

function Header({ step, onClose }: { step: Step; onClose: () => void }) {
  const titles: Record<Step, string> = {
    1: "Pick a template",
    2: "Frontmatter",
    3: "Body editor",
    4: "Target & confirm",
  };
  return (
    <div
      className="flex items-center gap-3 border-b p-3"
      style={{ borderColor: "var(--color-border)" }}
    >
      <Plus size={16} />
      <h2 className="text-sm font-semibold">New agent</h2>
      <StepperDots step={step} />
      <span
        className="ml-auto text-xs"
        style={{ color: "var(--color-text-muted)" }}
      >
        Step {step} / 4 — {titles[step]}
      </span>
      <button
        className="rounded p-1 hover:bg-[var(--color-surface-2)]"
        onClick={onClose}
        aria-label="Close"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function StepperDots({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className="h-1.5 w-6 rounded-full"
          style={{
            background:
              n <= step ? "var(--color-accent)" : "var(--color-surface-3)",
          }}
        />
      ))}
    </div>
  );
}

function Footer(props: {
  step: Step;
  canAdvance: boolean;
  canSubmit: boolean;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { step, canAdvance, canSubmit, busy, onBack, onNext, onCancel, onSubmit } = props;
  return (
    <div
      className="flex items-center justify-between gap-2 border-t p-3"
      style={{ borderColor: "var(--color-border)" }}
    >
      <button
        className="inline-flex items-center gap-1 rounded border px-3 py-1 text-xs disabled:opacity-50"
        style={{ borderColor: "var(--color-border)" }}
        onClick={step === 1 ? onCancel : onBack}
        disabled={busy}
      >
        {step === 1 ? "Cancel" : <><ChevronLeft size={12} /> Back</>}
      </button>
      <div className="flex items-center gap-2">
        {step < 4 ? (
          <button
            className="inline-flex items-center gap-1 rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            onClick={onNext}
            disabled={!canAdvance || busy}
          >
            Next <ChevronRight size={12} />
          </button>
        ) : (
          <button
            className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            onClick={onSubmit}
            disabled={!canSubmit || busy}
          >
            {busy ? "Creating..." : "Create agent"}
          </button>
        )}
      </div>
    </div>
  );
}

function StepTemplates(props: {
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
          <Clipboard size={12} /> {aiCopied ? "Copied" : "Copy AI prompt"}
        </button>
      </div>
    </div>
  );
}

function StepFrontmatter(props: {
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

function StepBody(props: {
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

function StepTarget(props: {
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

// ---------------------------------------------------------------------------
// Shared visual atoms — duplicated here to keep the file self-contained
// (avoids a circular import with CreateSkillModal). Same component
// definitions are used in both files; if they ever drift, lift to a
// shared CreatorAtoms.tsx.
// ---------------------------------------------------------------------------

function FieldLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span
        className="mb-1 block text-xs"
        style={{ color: "var(--color-text-muted)" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function HelperText({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className="mt-1 text-xs"
      style={{
        color: error ? "var(--color-error)" : "var(--color-text-muted)",
      }}
    >
      {children}
    </div>
  );
}

function ScopeRadio(props: {
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  const { label, sub, active, onClick } = props;
  return (
    <button
      onClick={onClick}
      className="flex flex-1 flex-col items-start gap-1 rounded border p-2 text-left"
      style={{
        borderColor: active ? "var(--color-accent)" : "var(--color-border)",
        background: active
          ? "var(--color-surface-2)"
          : "var(--color-surface-1)",
      }}
    >
      <span className="text-sm font-medium">{label}</span>
      <span
        className="font-mono text-[10px]"
        style={{ color: "var(--color-text-muted)" }}
      >
        {sub}
      </span>
    </button>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 py-0.5">
      <span style={{ color: "var(--color-text-muted)" }}>{k}</span>
      <span className="truncate font-mono">{v}</span>
    </div>
  );
}

function MarkdownPreview({ source }: { source: string }) {
  const blocks = useMemo(() => renderBlocks(source), [source]);
  return <div className="space-y-2">{blocks}</div>;
}

function renderBlocks(src: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = src.split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded p-2 font-mono text-[11px]"
          style={{ background: "var(--color-surface-3)" }}
        >
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(
        <h2 key={key++} className="text-sm font-semibold">
          {line.slice(2)}
        </h2>,
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(
        <h3 key={key++} className="text-xs font-semibold uppercase tracking-wide">
          {line.slice(3)}
        </h3>,
      );
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      out.push(
        <h4 key={key++} className="text-xs font-semibold">
          {line.slice(4)}
        </h4>,
      );
      i++;
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s/, ""));
        i++;
      }
      out.push(
        <ul key={key++} className="ml-4 list-disc space-y-0.5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      out.push(
        <ol key={key++} className="ml-4 list-decimal space-y-0.5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !/^[-*]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    out.push(
      <p key={key++} className="text-xs">
        {renderInline(paragraph.join(" "))}
      </p>,
    );
  }
  return out;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, idx) => {
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <code
          key={idx}
          className="rounded px-1 font-mono text-[11px]"
          style={{ background: "var(--color-surface-3)" }}
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={idx}>{p}</span>;
  });
}

export default CreateAgentModal;
