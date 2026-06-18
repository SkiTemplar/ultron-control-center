import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EVENT_OPTIONS } from "./constants";
import type { HookRecord, HookMutationResult } from "./types";

export function HookFormModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  initial?: HookRecord;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [event, setEvent] = useState<string>(initial?.event ?? "PreToolUse");
  const [matcher, setMatcher] = useState<string>(initial?.matcher ?? "");
  const [command, setCommand] = useState<string>(initial?.command ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!command.trim()) {
      setErr("Command cannot be empty.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (mode === "add") {
        const res = (await invoke("add_hook", {
          event,
          matcher: matcher.trim() || null,
          command,
        })) as HookMutationResult;
        onSaved(`Added hook. Backup: ${res.backup_path ?? "n/a"}`);
      } else if (initial) {
        const res = (await invoke("update_hook", {
          id: initial.id,
          command,
          enabled: null,
          matcher: matcher.trim() || null,
        })) as HookMutationResult;
        onSaved(`Updated hook. Backup: ${res.backup_path ?? "n/a"}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-md border p-5 shadow-xl"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">
          {mode === "add" ? "Add hook" : "Edit hook"}
        </div>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Event
          </div>
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            disabled={mode === "edit"}
            className="w-full rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {EVENT_OPTIONS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          {mode === "edit" && (
            <div className="mt-1 text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
              Event is immutable. Delete and re-add to change it.
            </div>
          )}
        </label>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Matcher (optional regex — e.g. "Bash", "Read|Glob|Grep", "mcp__.*")
          </div>
          <input
            type="text"
            value={matcher}
            onChange={(e) => setMatcher(e.target.value)}
            className="w-full rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Command
          </div>
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={6}
            className="w-full rounded px-2 py-1 font-mono text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        {err && (
          <div
            className="mb-3 rounded border px-2 py-1 text-[11.5px]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-danger, #f88)" }}
          >
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {saving ? "Saving..." : mode === "add" ? "Add hook" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
