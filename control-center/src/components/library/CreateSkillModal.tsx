// Skill Creator v2 — multi-step wizard.
//
// Step 1: Pick a starter template (Empty / Workflow / Reviewer / MCP-builder
//         / Domain-expert). Each template seeds the body.
// Step 2: Frontmatter form (name + description + tags + optional model + tools).
// Step 3: Body editor with live markdown preview side-by-side.
// Step 4: Target picker (Global / Project) + final confirm.
//
// Validation is inline (red border + helper text). The submit button stays
// disabled until every required field on the active step is valid AND the
// global preconditions for create are met.
//
// Backend contract:
//   - The Rust side (`library::skill_create_inner`) builds the YAML
//     frontmatter from the typed fields. We send `name`, `description`,
//     `body`, `target_scope`, `target_project_id`. Tags + tools + model
//     get folded into the description's tail and the body header so the
//     existing backend signature does not change.

import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TargetScope } from "../../types";
import { skillCreate } from "../../lib/library-client";
import { getPrompt } from "../../lib/button-prompts";
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
  COMMON_TOOLS,
  MAX_DESCRIPTION_CHARS,
  MIN_BODY_CHARS,
  SKILL_TEMPLATES,
  type SkillTemplate,
  type SkillTemplateId,
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

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function CreateSkillModal({
  defaultScope = "global",
  defaultProjectId,
  projects,
  onClose,
  onCreated,
}: Props) {
  const [step, setStep] = useState<Step>(1);
  const [templateId, setTemplateId] = useState<SkillTemplateId>("empty");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [toolsSelected, setToolsSelected] = useState<string[]>([]);
  const [model, setModel] = useState<"" | "haiku" | "sonnet" | "opus">("");

  // Body is initialized from the template on Step-1 advance.
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

  const template: SkillTemplate =
    SKILL_TEMPLATES.find((t) => t.id === templateId) ?? SKILL_TEMPLATES[0];

  const tags = useMemo(
    () =>
      tagsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [tagsRaw],
  );

  // Validation flags per field.
  const nameValid = KEBAB_RE.test(name);
  const descriptionValid =
    description.trim().length > 0 &&
    description.length <= MAX_DESCRIPTION_CHARS;
  const bodyValid = body.trim().length >= MIN_BODY_CHARS;
  const targetValid = scope === "global" || !!projectId;

  // Soft warnings — non-blocking, surfaced as helper text.
  const bodyMissingExample = bodyValid && !/```/.test(body) && !/example/i.test(body);
  const descriptionTooShort = description.trim().length > 0 && description.trim().length < 20;

  const canAdvance: Record<Step, boolean> = {
    1: true,
    2: nameValid && descriptionValid,
    3: bodyValid,
    4: targetValid,
  };

  function advance() {
    if (!canAdvance[step]) return;
    if (step === 1) {
      // Seed the body from the template the first time we leave step 1.
      if (!bodyDirty) {
        setBody(applyName(template.body, name || "skill"));
      }
    }
    if (step < 4) setStep((step + 1) as Step);
  }

  function back() {
    if (step > 1) setStep((step - 1) as Step);
  }

  function pickTemplate(id: SkillTemplateId) {
    setTemplateId(id);
    // Re-seed body to the new template only if the user has not started
    // editing yet. Once they touch the body, we never overwrite it.
    if (!bodyDirty) {
      const tpl = SKILL_TEMPLATES.find((t) => t.id === id) ?? SKILL_TEMPLATES[0];
      setBody(applyName(tpl.body, name || "skill"));
    }
  }

  function toggleTool(t: string) {
    setToolsSelected((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    );
  }

  async function copyAiPrompt() {
    const prompt = await getPrompt("library.create_skill", {
      NAME: name || "<skill-name>",
      DESCRIPTION: description || "<one-line goal>",
    });
    try {
      await navigator.clipboard.writeText(prompt);
      setAiCopied(true);
      setTimeout(() => setAiCopied(false), 2000);
      // v2.4: also spawn a Claude session ready to receive the prompt.
      // `respectClipboard` keeps the text we just copied; `pasteOnly`
      // opens the CLI without auto-submitting so the user pastes on
      // their own. Spawn failure is non-fatal — clipboard already won.
      try {
        await invoke("spawn_session", {
          provider: "claude",
          prompt: null,
          flags: { pasteOnly: true, respectClipboard: true },
        });
      } catch {
        // Spawn failed — user can open Claude Code manually.
      }
    } catch {
      // Clipboard rejected (rare in Tauri webview). Fall back to a
      // user-visible error so they can copy manually from the textarea.
      setErr("Could not copy to clipboard — open a Claude session and paste this prompt manually.");
    }
  }

  async function submit() {
    if (!nameValid || !descriptionValid || !bodyValid || !targetValid) return;
    setBusy(true);
    setErr(null);
    try {
      // Compose a final description that absorbs optional tags + model +
      // tools without changing the Rust signature. The backend writes
      // `description:` verbatim into the YAML frontmatter.
      const tail: string[] = [];
      if (tags.length > 0) tail.push(`tags: ${tags.join(", ")}`);
      if (model) tail.push(`model: ${model}`);
      if (toolsSelected.length > 0) tail.push(`tools: ${toolsSelected.join(", ")}`);
      const finalDescription = tail.length > 0
        ? `${description.trim()} (${tail.join(" · ")})`
        : description.trim();

      const written = await skillCreate({
        name,
        description: finalDescription,
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
              templates={SKILL_TEMPLATES}
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
              tagsRaw={tagsRaw}
              setTagsRaw={setTagsRaw}
              tags={tags}
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
              summary={{ name, description, body, tags, model, toolsSelected, templateId }}
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
// Layout sub-components
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
      <h2 className="text-sm font-semibold">New skill</h2>
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
            {busy ? "Creating..." : "Create skill"}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Templates
// ---------------------------------------------------------------------------

function StepTemplates(props: {
  templates: SkillTemplate[];
  selectedId: SkillTemplateId;
  onPick: (id: SkillTemplateId) => void;
  aiCopied: boolean;
  onCopyAiPrompt: () => void;
}) {
  const { templates, selectedId, onPick, aiCopied, onCopyAiPrompt } = props;
  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
        Starter templates seed the body editor with a battle-tested scaffold.
        Pick the closest match — you can rewrite anything later.
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
              </div>
              <span
                className="text-xs"
                style={{ color: "var(--color-text-muted)" }}
              >
                {tpl.hint}
              </span>
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
          Rather have Claude draft this? This opens a new Claude session and
          pastes a prompt that launches the{" "}
          <code>skill-creator</code> skill — it drafts, validates, and packages
          the skill for you.
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

// ---------------------------------------------------------------------------
// Step 2 — Frontmatter
// ---------------------------------------------------------------------------

function StepFrontmatter(props: {
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
}) {
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

// ---------------------------------------------------------------------------
// Step 3 — Body editor with live preview
// ---------------------------------------------------------------------------

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
          Markdown body. The backend wraps this with the YAML frontmatter
          built from Step 2.
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
          Body is {body.trim().length} chars; needs at least {MIN_BODY_CHARS}
          for the skill to be reliable.
        </HelperText>
      )}
      {bodyMissingExample && (
        <HelperText>
          Tip: skills that include a fenced example or an "Example" section
          trigger more reliably.
        </HelperText>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Target + summary
// ---------------------------------------------------------------------------

function StepTarget(props: {
  scope: TargetScope;
  setScope: (s: TargetScope) => void;
  projects: { id: string; name: string }[];
  projectId: string | null;
  setProjectId: (v: string | null) => void;
  targetValid: boolean;
  summary: {
    name: string;
    description: string;
    body: string;
    tags: string[];
    model: string;
    toolsSelected: string[];
    templateId: SkillTemplateId;
  };
}) {
  const { scope, setScope, projects, projectId, setProjectId, targetValid, summary } = props;
  return (
    <div className="space-y-4">
      <FieldLabel label="Install scope">
        <div className="flex gap-3">
          <ScopeRadio
            label="Global"
            sub="~/.claude/skills/"
            active={scope === "global"}
            onClick={() => setScope("global")}
          />
          <ScopeRadio
            label="Project"
            sub="<project>/.claude/skills/"
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
        {summary.tags.length > 0 && (
          <SummaryRow k="Tags" v={summary.tags.join(", ")} />
        )}
        {summary.model && <SummaryRow k="Model" v={summary.model} />}
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
// Small shared bits
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

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="rounded px-2 py-0.5 font-mono text-xs"
      style={{ background: "var(--color-surface-2)" }}
    >
      {children}
    </span>
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

// ---------------------------------------------------------------------------
// Tiny markdown preview — intentionally minimal. Handles headings, lists,
// fenced code blocks, inline code, and paragraphs. Anything fancier would
// pull in `marked` or `react-markdown` which the codebase currently avoids.
// ---------------------------------------------------------------------------

function MarkdownPreview({ source }: { source: string }) {
  const blocks = useMemo(() => renderBlocks(source), [source]);
  return <div className="prose-tight space-y-2">{blocks}</div>;
}

function renderBlocks(src: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = src.split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded p-2 font-mono text-[11.5px]"
          style={{ background: "var(--color-surface-3)" }}
        >
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    // Headings
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
    // Bullet list block
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
    // Numbered list block
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
    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Paragraph — collect until blank or block-start.
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
  // Inline code: split on backticks, alternate code/text.
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, idx) => {
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <code
          key={idx}
          className="rounded px-1 font-mono text-[11.5px]"
          style={{ background: "var(--color-surface-3)" }}
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={idx}>{p}</span>;
  });
}

export default CreateSkillModal;
