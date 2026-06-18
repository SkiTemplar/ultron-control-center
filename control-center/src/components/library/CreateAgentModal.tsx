// Agent Creator v2 — multi-step wizard mirroring CreateSkillModal.
//
// Step 1: Pick a template (Empty / Reviewer / Researcher / Implementer /
//         Debugger / Coordinator). Each template seeds tools, model, body.
// Step 2: Frontmatter form — name, description, model preset, tools multi-select.
// Step 3: Body editor with live markdown preview.
// Step 4: Target scope + final summary.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { agentCreate } from "../../lib/library-client";
import { getPrompt } from "../../lib/button-prompts";
import {
  AGENT_TEMPLATES,
  MAX_DESCRIPTION_CHARS,
  MIN_BODY_CHARS,
  type AgentTemplateId,
  applyName,
} from "./creatorTemplates";
import type { Props, Step, ModelChoice } from "./create-agent/types";
import { Header, Footer } from "./create-agent/layout";
import {
  StepTemplates,
  StepFrontmatter,
  StepBody,
  StepTarget,
} from "./create-agent/steps";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
  const [scope, setScope] = useState(defaultScope);
  const [projectId, setProjectId] = useState<string | null>(
    defaultProjectId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [aiCopied, setAiCopied] = useState(false);

  const template =
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
    const prompt = await getPrompt("library.create_agent", {
      NAME: name || "<agent-name>",
      DESCRIPTION: description || "<one-line goal>",
    });
    try {
      await navigator.clipboard.writeText(prompt);
      setAiCopied(true);
      setTimeout(() => setAiCopied(false), 2000);
      // v2.4: spawn a Claude session ready to receive the prompt.
      try {
        await invoke("spawn_session", {
          provider: "claude",
          prompt: null,
          flags: { pasteOnly: true, respectClipboard: true },
        });
      } catch {
        // Non-fatal — clipboard already has the prompt.
      }
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

export default CreateAgentModal;
