// Settings — Button Prompts panel (F7).
//
// Lists every entry in the ButtonPromptsCatalog (sourced from the Rust
// button_prompts module). Each row has:
//   - label + location badge + vars hint
//   - full-height textarea showing the effective prompt (editable)
//   - Save button (calls update_button_prompt)
//   - Reset button when the entry is overridden (calls reset_button_prompt)
//
// No backend changes needed — all four Tauri commands already exist:
//   list_button_prompts, update_button_prompt, reset_button_prompt, get_button_prompt
//
// Storage: ~/.claude/projects/control-center/button-prompts.json (only overrides
// are persisted; defaults are merged at read time in Rust, so new defaults
// propagate automatically).

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types — mirror the Rust structs from button_prompts.rs
// ---------------------------------------------------------------------------

type ButtonPrompt = {
  key: string;
  label: string;
  location: string;
  description: string;
  prompt: string;
  default_prompt: string;
  overridden: boolean;
  vars: string[];
};

type ButtonPromptsCatalog = {
  schema_version: number;
  buttons: ButtonPrompt[];
};

// ---------------------------------------------------------------------------
// Per-row state kept in a map so each row is independent
// ---------------------------------------------------------------------------

type RowState = {
  draft: string;
  saving: boolean;
  resetting: boolean;
  dirty: boolean;
  saved: boolean;
  error: string | null;
};

type RowAction =
  | { type: "edit"; value: string; current: string }
  | { type: "saving" }
  | { type: "saved"; prompt: ButtonPrompt }
  | { type: "save_error"; error: string }
  | { type: "resetting" }
  | { type: "reset_done"; prompt: ButtonPrompt }
  | { type: "reset_error"; error: string }
  | { type: "dismiss_saved" };

function rowReducer(state: RowState, action: RowAction): RowState {
  switch (action.type) {
    case "edit":
      return {
        ...state,
        draft: action.value,
        dirty: action.value !== action.current,
        saved: false,
        error: null,
      };
    case "saving":
      return { ...state, saving: true, error: null };
    case "saved":
      return {
        ...state,
        saving: false,
        dirty: false,
        saved: true,
        draft: action.prompt.prompt,
        error: null,
      };
    case "save_error":
      return { ...state, saving: false, error: action.error };
    case "resetting":
      return { ...state, resetting: true, error: null };
    case "reset_done":
      return {
        ...state,
        resetting: false,
        dirty: false,
        saved: false,
        draft: action.prompt.prompt,
        error: null,
      };
    case "reset_error":
      return { ...state, resetting: false, error: action.error };
    case "dismiss_saved":
      return { ...state, saved: false };
    default:
      return state;
  }
}

function makeInitialRow(prompt: string): RowState {
  return {
    draft: prompt,
    saving: false,
    resetting: false,
    dirty: false,
    saved: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// PromptRow — renders a single catalog entry
// ---------------------------------------------------------------------------

type PromptRowProps = {
  entry: ButtonPrompt;
  onUpdated: (updated: ButtonPrompt) => void;
};

function PromptRow({ entry, onUpdated }: PromptRowProps) {
  const [state, dispatch] = useReducer(rowReducer, makeInitialRow(entry.prompt));
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync draft when the parent catalog entry changes from outside (e.g. after
  // a successful reset from a sibling row — unlikely but correct).
  const prevKeyRef = useRef(entry.key);
  useEffect(() => {
    if (prevKeyRef.current !== entry.key) {
      prevKeyRef.current = entry.key;
      dispatch({ type: "reset_done", prompt: entry });
    }
  }, [entry]);

  function handleEdit(value: string) {
    dispatch({ type: "edit", value, current: entry.prompt });
  }

  async function handleSave() {
    dispatch({ type: "saving" });
    try {
      const updated = await invoke<ButtonPrompt>("update_button_prompt", {
        key: entry.key,
        prompt: state.draft,
      });
      dispatch({ type: "saved", prompt: updated });
      onUpdated(updated);
      // Auto-dismiss the "Saved" indicator after 2.5 s
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        dispatch({ type: "dismiss_saved" });
      }, 2500);
    } catch (e) {
      dispatch({ type: "save_error", error: String(e) });
    }
  }

  async function handleReset() {
    dispatch({ type: "resetting" });
    try {
      const updated = await invoke<ButtonPrompt>("reset_button_prompt", {
        key: entry.key,
      });
      dispatch({ type: "reset_done", prompt: updated });
      onUpdated(updated);
    } catch (e) {
      dispatch({ type: "reset_error", error: String(e) });
    }
  }

  const busy = state.saving || state.resetting;
  const isOverridden = entry.overridden || state.dirty;

  return (
    <div
      className="rounded"
      style={{
        background: "var(--color-surface-2)",
        border: `1px solid ${isOverridden ? "rgba(210,153,34,0.38)" : "var(--color-border-strong)"}`,
      }}
    >
      {/* Header row */}
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-[13px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {entry.label}
            </span>
            {isOverridden && !state.dirty && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  background: "rgba(210,153,34,0.12)",
                  color: "rgba(210,153,34,0.9)",
                  border: "1px solid rgba(210,153,34,0.28)",
                }}
              >
                custom
              </span>
            )}
            {state.dirty && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  background: "rgba(88,166,255,0.10)",
                  color: "var(--color-accent)",
                  border: "1px solid rgba(88,166,255,0.28)",
                }}
              >
                unsaved
              </span>
            )}
          </div>
          <div
            className="mt-0.5 text-[11.5px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {entry.description}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span
              className="text-[10.5px]"
              style={{
                color: "var(--color-text-faint)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {entry.location}
            </span>
            {entry.vars.length > 0 && (
              <span
                className="text-[10.5px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                vars:{" "}
                {entry.vars.map((v) => (
                  <code
                    key={v}
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-tertiary)",
                    }}
                  >
                    {"{"}
                    {v}
                    {"}"}{" "}
                  </code>
                ))}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {(entry.overridden || state.dirty) && !state.resetting && (
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={busy}
              className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border-strong)",
              }}
              title="Reset to built-in default"
            >
              {state.resetting ? "Resetting…" : "Reset to default"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={busy || !state.dirty}
            className="rounded px-3 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: state.dirty ? "var(--color-accent)" : "var(--color-surface-3)",
              color: state.dirty ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
              border: state.dirty ? "none" : "1px solid var(--color-border-strong)",
            }}
          >
            {state.saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Textarea */}
      <div className="px-4 pb-3">
        <textarea
          value={state.draft}
          onChange={(e) => handleEdit(e.target.value)}
          disabled={busy}
          rows={Math.max(4, Math.min(16, state.draft.split("\n").length + 1))}
          spellCheck={false}
          className="w-full resize-y rounded px-3 py-2 text-[12px] leading-relaxed disabled:opacity-60"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            fontFamily: "var(--font-mono)",
            outline: "none",
          }}
        />
      </div>

      {/* Status banners */}
      {state.saved && (
        <div
          className="mx-4 mb-3 rounded px-3 py-1.5 text-[11.5px]"
          style={{
            background: "rgba(63,185,80,0.06)",
            border: "1px solid rgba(63,185,80,0.22)",
            color: "var(--color-success)",
          }}
        >
          Saved.
        </div>
      )}
      {state.error && (
        <div
          className="mx-4 mb-3 rounded px-3 py-1.5 text-[11.5px]"
          style={{
            background: "rgba(248,81,73,0.06)",
            border: "1px solid rgba(248,81,73,0.22)",
            color: "var(--color-danger)",
          }}
        >
          {state.error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ButtonPromptsSection — top-level panel exported for Settings integration
// ---------------------------------------------------------------------------

type FilterMode = "all" | "overridden";

export function ButtonPromptsSection() {
  const [catalog, setCatalog] = useState<ButtonPromptsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await invoke<ButtonPromptsCatalog>("list_button_prompts");
      setCatalog(c);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function handleUpdated(updated: ButtonPrompt) {
    setCatalog((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        buttons: prev.buttons.map((b) => (b.key === updated.key ? updated : b)),
      };
    });
  }

  const buttons = catalog?.buttons ?? [];
  const overriddenCount = buttons.filter((b) => b.overridden).length;

  const q = search.trim().toLowerCase();
  const visible = buttons.filter((b) => {
    if (filter === "overridden" && !b.overridden) return false;
    if (q === "") return true;
    return (
      b.label.toLowerCase().includes(q) ||
      b.location.toLowerCase().includes(q) ||
      b.description.toLowerCase().includes(q) ||
      b.key.toLowerCase().includes(q)
    );
  });

  return (
    <div>
      {/* Section header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            className="text-[15px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            Button prompts
          </h2>
          <p
            className="mt-1 text-[12px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Every AI button in the Control Center reads its prompt from this
            catalog. Edits are persisted to{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>
              ~/.claude/projects/control-center/button-prompts.json
            </code>{" "}
            — only your overrides are saved; built-in defaults apply automatically
            for entries you have not changed.
          </p>
          {overriddenCount > 0 && (
            <p
              className="mt-1.5 text-[11.5px]"
              style={{ color: "rgba(210,153,34,0.85)" }}
            >
              {overriddenCount} {overriddenCount === 1 ? "entry" : "entries"} customized
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="shrink-0 rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by label, location or key…"
          className="flex-1 rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
            minWidth: 220,
          }}
        />

        {/* Filter tabs */}
        <div
          className="inline-flex rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {(["all", "overridden"] as FilterMode[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className="rounded px-3 py-1 text-[12px] font-medium transition-colors"
              style={{
                background: filter === f ? "var(--color-surface-3)" : "transparent",
                color: filter === f ? "var(--color-text)" : "var(--color-text-tertiary)",
              }}
            >
              {f === "all" ? `All (${buttons.length})` : `Custom (${overriddenCount})`}
            </button>
          ))}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248,81,73,0.06)",
            border: "1px solid rgba(248,81,73,0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !catalog && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-36 animate-pulse rounded"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border-strong)",
              }}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && visible.length === 0 && (
        <div
          className="rounded p-8 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {q || filter === "overridden"
            ? "No prompts match the current filter."
            : "No button prompts found."}
        </div>
      )}

      {/* Prompt list */}
      {!loading && visible.length > 0 && (
        <div className="space-y-3">
          {visible.map((entry) => (
            <PromptRow key={entry.key} entry={entry} onUpdated={handleUpdated} />
          ))}
        </div>
      )}
    </div>
  );
}
