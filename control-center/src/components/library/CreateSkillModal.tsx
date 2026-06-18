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
import { skillCreate } from "../../lib/library-client";
import { getPrompt } from "../../lib/button-prompts";
import {
  SKILL_TEMPLATES,
  applyName,
} from "./creatorTemplates";
import type { SkillTemplate, SkillTemplateId } from "./creatorTemplates";
import type { Props, Step } from "./create-skill/types";
import { KEBAB_RE } from "./create-skill/types";
import { MAX_DESCRIPTION_CHARS, MIN_BODY_CHARS } from "./creatorTemplates";
import { Header } from "./create-skill/Header";
import { Footer } from "./create-skill/Footer";
import { StepTemplates } from "./create-skill/StepTemplates";
import { StepFrontmatter } from "./create-skill/StepFrontmatter";
import { StepBody } from "./create-skill/StepBody";
import { StepTarget } from "./create-skill/StepTarget";

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

  const [scope, setScope] = useState(defaultScope);
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

export default CreateSkillModal;
