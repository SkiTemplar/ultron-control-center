// Step 1 — Pick a starter template.

import { Clipboard, FileText, Sparkles } from "../icons";
import type { SkillTemplate, SkillTemplateId } from "../creatorTemplates";

type StepTemplatesProps = {
  templates: SkillTemplate[];
  selectedId: SkillTemplateId;
  onPick: (id: SkillTemplateId) => void;
  aiCopied: boolean;
  onCopyAiPrompt: () => void;
};

export function StepTemplates(props: StepTemplatesProps) {
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
