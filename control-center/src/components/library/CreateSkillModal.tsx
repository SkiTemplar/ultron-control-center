// P5 — In-app new skill modal. Same shape as CreateAgentModal but
// writes <root>/skills/<name>/SKILL.md.

import { useState } from "react";
import type { TargetScope } from "../../types";
import { skillCreate } from "../../lib/library-client";
import { Plus, X } from "./icons";

type Props = {
  defaultScope?: TargetScope;
  defaultProjectId?: string;
  projects: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (writtenPath: string) => void;
};

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function CreateSkillModal({
  defaultScope = "global",
  defaultProjectId,
  projects,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<TargetScope>(defaultScope);
  const [projectId, setProjectId] = useState<string | null>(
    defaultProjectId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid =
    KEBAB_RE.test(name) &&
    description.trim().length > 0 &&
    body.trim().length > 0 &&
    (scope === "global" || !!projectId);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const written = await skillCreate({
        name,
        description,
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
      <div className="flex max-h-[85vh] w-[min(640px,92vw)] flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] p-3">
          <Plus size={16} />
          <h2 className="text-sm font-semibold">New skill</h2>
          <button
            className="ml-auto rounded p-1 hover:bg-[var(--color-surface-2)]"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm">
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">
              Name (kebab-case)
            </span>
            <input
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
            />
            {name && !KEBAB_RE.test(name) && (
              <div className="mt-1 text-xs text-[var(--color-error)]">
                Must be lowercase + digits + dashes, no leading/trailing dash.
              </div>
            )}
          </label>
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">
              Description (1-2 lines)
            </span>
            <input
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 outline-none"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs text-[var(--color-text-muted)]">
              Body (markdown)
            </span>
            <textarea
              className="mt-1 h-52 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs outline-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="# Skill content..."
            />
          </label>
          <fieldset className="flex gap-3">
            <label className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                checked={scope === "global"}
                onChange={() => setScope("global")}
              />
              Global
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                checked={scope === "project"}
                onChange={() => setScope("project")}
              />
              Project
            </label>
          </fieldset>
          {scope === "project" && (
            <select
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
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
          )}
          {err && (
            <div className="rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-2 text-xs text-[var(--color-error)]">
              {err}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-3">
          <button
            className="rounded border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            onClick={submit}
            disabled={!valid || busy}
          >
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CreateSkillModal;
