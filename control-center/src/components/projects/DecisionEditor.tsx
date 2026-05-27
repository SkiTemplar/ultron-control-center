// ULTRON Control Center — DecisionEditor modal (KIRKARDO 24)
//
// Used for both create and edit flows. Validates inline (title ≥ 5ch,
// rationale ≥ 10ch) and delegates to decisions_add / decisions_update.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  DecisionRecord,
  DecisionPayload,
  DecisionPatch,
  DecisionStatus,
} from "../../types";

const STATUS_OPTIONS: DecisionStatus[] = [
  "proposed",
  "accepted",
  "superseded",
  "rejected",
];

const STATUS_LABELS: Record<DecisionStatus, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  superseded: "Superseded",
  rejected: "Rejected",
};

interface Props {
  projectId: string;
  /** Present → edit mode; absent → create mode */
  record?: DecisionRecord;
  onSaved: (record: DecisionRecord) => void;
  onClose: () => void;
}

interface FormState {
  decision: string;
  rationale: string;
  /** One alternative per line */
  alternativesRaw: string;
  /** Comma-separated tags */
  tagsRaw: string;
  /** One URL per line */
  urlsRaw: string;
  status: DecisionStatus;
  author: string;
  supersedes_id: string;
}

function initialForm(record?: DecisionRecord): FormState {
  if (!record) {
    return {
      decision: "",
      rationale: "",
      alternativesRaw: "",
      tagsRaw: "",
      urlsRaw: "",
      status: "proposed",
      author: "",
      supersedes_id: "",
    };
  }
  return {
    decision: record.decision,
    rationale: record.rationale,
    alternativesRaw: record.alternatives_considered.join("\n"),
    tagsRaw: record.tags.join(", "),
    urlsRaw: record.context_urls.join("\n"),
    status: record.status,
    author: record.author ?? "",
    supersedes_id: record.supersedes_id ?? "",
  };
}

function validate(f: FormState): string | null {
  if (f.decision.trim().length < 5) {
    return "Decision title must be at least 5 characters.";
  }
  if (f.rationale.trim().length < 10) {
    return "Rationale must be at least 10 characters.";
  }
  return null;
}

function parseLinesField(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function parseTagsField(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export default function DecisionEditor({
  projectId,
  record,
  onSaved,
  onClose,
}: Props) {
  const [form, setForm] = useState<FormState>(() => initialForm(record));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-initialise when the record prop changes (e.g. modal re-used).
  useEffect(() => {
    setForm(initialForm(record));
    setError(null);
  }, [record?.id]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    const validationError = validate(form);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    const alternatives = parseLinesField(form.alternativesRaw);
    const tags = parseTagsField(form.tagsRaw);
    const context_urls = parseLinesField(form.urlsRaw);
    const author = form.author.trim() || null;
    const supersedes_id = form.supersedes_id.trim() || null;

    try {
      if (record) {
        const patch: DecisionPatch = {
          decision: form.decision.trim(),
          rationale: form.rationale.trim(),
          alternatives_considered: alternatives,
          status: form.status,
          supersedes_id,
          context_urls,
          author,
          tags,
        };
        const updated = (await invoke("decisions_update", {
          projectId,
          id: record.id,
          patch,
        })) as DecisionRecord;
        onSaved(updated);
      } else {
        const payload: DecisionPayload = {
          decision: form.decision.trim(),
          rationale: form.rationale.trim(),
          alternatives_considered: alternatives,
          status: form.status,
          supersedes_id,
          context_urls,
          author,
          tags,
        };
        const created = (await invoke("decisions_add", {
          projectId,
          payload,
        })) as DecisionRecord;
        onSaved(created);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="relative w-full max-w-lg rounded-xl border border-amber-500/40 bg-neutral-900 p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-base font-semibold text-amber-300">
            {record ? "Edit Decision" : "Add Decision"}
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:text-neutral-200 transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <div className="space-y-4">
          {/* Title */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-400">
              Decision title <span className="text-amber-400">*</span>
            </label>
            <input
              type="text"
              value={form.decision}
              onChange={(e) => set("decision", e.target.value)}
              placeholder="e.g. Use PostgreSQL for primary storage"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500 transition-colors"
            />
          </div>

          {/* Rationale */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-400">
              Rationale <span className="text-amber-400">*</span>
            </label>
            <textarea
              value={form.rationale}
              onChange={(e) => set("rationale", e.target.value)}
              rows={3}
              placeholder="Why this decision over the alternatives?"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500 transition-colors resize-none"
            />
          </div>

          {/* Alternatives */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-400">
              Alternatives considered{" "}
              <span className="text-neutral-600">(one per line)</span>
            </label>
            <textarea
              value={form.alternativesRaw}
              onChange={(e) => set("alternativesRaw", e.target.value)}
              rows={2}
              placeholder={"SQLite\nMySQL"}
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500 transition-colors resize-none"
            />
          </div>

          {/* Status + Author — inline row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-neutral-400">
                Status
              </label>
              <select
                value={form.status}
                onChange={(e) =>
                  set("status", e.target.value as DecisionStatus)
                }
                className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-amber-500 transition-colors"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-neutral-400">
                Author
              </label>
              <input
                type="text"
                value={form.author}
                onChange={(e) => set("author", e.target.value)}
                placeholder="optional"
                className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500 transition-colors"
              />
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-400">
              Tags{" "}
              <span className="text-neutral-600">(comma-separated)</span>
            </label>
            <input
              type="text"
              value={form.tagsRaw}
              onChange={(e) => set("tagsRaw", e.target.value)}
              placeholder="backend, database, performance"
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500 transition-colors"
            />
          </div>

          {/* Context URLs */}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-400">
              Context URLs{" "}
              <span className="text-neutral-600">(one per line)</span>
            </label>
            <textarea
              value={form.urlsRaw}
              onChange={(e) => set("urlsRaw", e.target.value)}
              rows={2}
              placeholder={"https://github.com/org/repo/issues/42\nhttps://pr.link"}
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500 transition-colors resize-none"
            />
          </div>

          {/* Error */}
          {error && (
            <p className="rounded-md border border-red-700/50 bg-red-900/20 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : record ? "Save changes" : "Add decision"}
          </button>
        </div>
      </div>
    </div>
  );
}
