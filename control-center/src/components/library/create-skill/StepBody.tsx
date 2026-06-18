// Step 3 — Body editor with live markdown preview side-by-side.

import { Code, Eye } from "../icons";
import { HelperText } from "./ui-primitives";
import { MarkdownPreview } from "./MarkdownPreview";
import { MIN_BODY_CHARS } from "../creatorTemplates";

type StepBodyProps = {
  body: string;
  setBody: (v: string) => void;
  bodyValid: boolean;
  bodyMissingExample: boolean;
  previewOpen: boolean;
  togglePreview: () => void;
};

export function StepBody(props: StepBodyProps) {
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
