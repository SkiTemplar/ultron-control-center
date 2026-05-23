// ULTRON Control Center 2.0 — Card create/edit modal
//
// Fields: title, description (markdown textarea), agent (text input —
// agent-picker dropdown integrates in sub-commit 7), prompt template with
// {var} preview, cwd override, tags. Save calls kanban_create_card /
// kanban_update_card. "Run again" calls kanban_dispatch_card.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Save, X } from "./icons";
import type { Card, KanbanBoard } from "../../types";

type Props =
  | {
      projectId: string;
      board: KanbanBoard;
      mode: "create";
      columnId: string;
      card: null;
      onClose: () => void;
      onSaved: () => void;
    }
  | {
      projectId: string;
      board: KanbanBoard;
      mode: "edit";
      columnId: string;
      card: Card;
      onClose: () => void;
      onSaved: () => void;
    };

export default function CardEditorModal(props: Props) {
  const { projectId, mode, columnId, onClose, onSaved, board } = props;
  const initial = mode === "edit" ? props.card : null;

  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [agent, setAgent] = useState(initial?.agent ?? "");
  const [promptTemplate, setPromptTemplate] = useState(
    initial?.prompt_template ?? "",
  );
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (!promptTemplate) return board.default_prompt_template ?? "";
    return promptTemplate
      .replace(/\{title\}/g, title)
      .replace(/\{description\}/g, description)
      .replace(/\{tags\}/g, tags)
      .replace(/\{card_id\}/g, initial?.id ?? "<new>");
  }, [promptTemplate, title, description, tags, initial?.id, board.default_prompt_template]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      if (mode === "create") {
        await invoke("kanban_create_card", {
          projectId,
          columnId,
          partial: {
            title: title.trim() || "Untitled",
            description,
            agent: agent || null,
            prompt_template: promptTemplate || null,
            cwd: cwd || null,
            tags: tagList,
          },
        });
      } else {
        await invoke("kanban_update_card", {
          projectId,
          cardId: initial!.id,
          patch: {
            title,
            description,
            agent: agent || null,
            prompt_template: promptTemplate || null,
            cwd: cwd || null,
            tags: tagList,
          },
        });
      }
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const runAgain = async () => {
    if (mode !== "edit") return;
    setError(null);
    try {
      await invoke("kanban_dispatch_card", {
        projectId,
        cardId: initial!.id,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-3xl flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
          <h2 className="text-sm font-semibold">
            {mode === "create" ? "New card" : "Edit card"}
          </h2>
          <button onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-4 p-4 text-xs">
          <div className="col-span-2">
            <label className="mb-1 block text-[var(--color-text-muted)]">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              placeholder="Card title"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-[var(--color-text-muted)]">
              Description (markdown)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono"
              placeholder="What needs to happen…"
            />
          </div>
          <div>
            <label className="mb-1 block text-[var(--color-text-muted)]">Agent</label>
            <input
              value={agent ?? ""}
              onChange={(e) => setAgent(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              placeholder={board.default_agent ?? "(project default)"}
            />
          </div>
          <div>
            <label className="mb-1 block text-[var(--color-text-muted)]">cwd override</label>
            <input
              value={cwd ?? ""}
              onChange={(e) => setCwd(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              placeholder="(project path)"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-[var(--color-text-muted)]">
              Prompt template (use {"{title}"} {"{description}"} {"{tags}"} {"{card_id}"})
            </label>
            <textarea
              value={promptTemplate ?? ""}
              onChange={(e) => setPromptTemplate(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono"
              placeholder={board.default_prompt_template ?? "Free-form template…"}
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-[var(--color-text-muted)]">Preview</label>
            <pre className="max-h-32 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2 font-mono whitespace-pre-wrap">
              {preview || "(empty)"}
            </pre>
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-[var(--color-text-muted)]">Tags (comma-separated)</label>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              placeholder="bug, p1, docs"
            />
          </div>
          {mode === "edit" && initial && initial.runs.length > 0 && (
            <div className="col-span-2">
              <label className="mb-1 block text-[var(--color-text-muted)]">Runs</label>
              <ul className="max-h-32 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2 font-mono text-[10px]">
                {initial.runs.map((r) => (
                  <li key={r.session_id} className="flex justify-between py-0.5">
                    <span>{r.session_id.slice(-14)}</span>
                    <span>{r.status.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {error && (
          <div className="border-t border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-2">
          {mode === "edit" && (
            <button
              onClick={runAgain}
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-2)]"
            >
              <Play size={11} /> Run again
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-3 py-1 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent)]/30 disabled:opacity-50"
          >
            <Save size={11} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}
