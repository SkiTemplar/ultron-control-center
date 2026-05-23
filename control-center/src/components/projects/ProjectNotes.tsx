// ULTRON Control Center 2.0 — Per-project Notes sub-tab.
//
// Free-form markdown editor scoped to a single project. Left half is the
// raw editor (monospace textarea, debounced auto-save). Right half is the
// rendered preview via the dependency-free renderer in `src/lib/markdown.tsx`.
//
// Storage lives at `~/.ultron/cockpit/projects/<project_id>/notes.md`,
// owned by `notes_load` / `notes_save` (atomic tmp+rename on the Rust side).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { renderBlocks, tokenizeMarkdown } from "../../lib/markdown";

type Props = { projectId: string };

const AUTOSAVE_DEBOUNCE_MS = 600;

type SaveState = "idle" | "saving" | "saved" | "error";

export default function ProjectNotes({ projectId }: Props) {
  const [body, setBody] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  // The body that's already on disk. Tracked so we don't fire pointless
  // saves when the user opens, doesn't type, and switches tabs.
  const lastSavedRef = useRef<string>("");
  // Guard against the first useEffect run firing a save on a freshly loaded
  // body (we just read it; it doesn't need saving again).
  const skipNextAutosaveRef = useRef<boolean>(true);
  const debounceTimerRef = useRef<number | null>(null);

  // -- load on mount / project change --
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    skipNextAutosaveRef.current = true;
    void (async () => {
      try {
        const text = (await invoke("project_notes_load", { projectId })) as string;
        if (cancelled) return;
        setBody(text);
        lastSavedRef.current = text;
        setSaveState("idle");
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // -- debounced auto-save on change --
  const flushSave = useCallback(
    async (next: string) => {
      setSaveState("saving");
      setSaveError(null);
      try {
        await invoke("project_notes_save", { projectId, body: next });
        lastSavedRef.current = next;
        setSaveState("saved");
        // Drop the "saved" label after a couple of seconds so the toolbar
        // settles back to a neutral state instead of staying green forever.
        window.setTimeout(() => {
          setSaveState((cur) => (cur === "saved" ? "idle" : cur));
        }, 1800);
      } catch (e) {
        setSaveError(String(e));
        setSaveState("error");
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    if (body === lastSavedRef.current) return;
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      void flushSave(body);
      debounceTimerRef.current = null;
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [body, flushSave]);

  const blocks = useMemo(() => tokenizeMarkdown(body), [body]);

  const indicator = (() => {
    if (loading) return "Loading…";
    if (saveState === "saving") return "Saving…";
    if (saveState === "saved") return "Saved";
    if (saveState === "error") return "Save failed";
    return "Auto-save on";
  })();

  const indicatorColor = (() => {
    if (saveState === "error") return "var(--color-error, #f85149)";
    if (saveState === "saved") return "var(--color-success, #3fb950)";
    return "var(--color-text-muted)";
  })();

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-4 text-xs">
          <p className="font-semibold text-[var(--color-error)]">
            Could not load notes
          </p>
          <p className="mt-1 text-[var(--color-text-muted)]">{loadError}</p>
        </div>
      </div>
    );
  }

  const isEmpty = !loading && body.length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-1.5 text-xs">
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <span>Notes</span>
          <span className="text-[var(--color-text-faint)]">·</span>
          <span className="font-mono text-[10.5px]">
            cockpit/projects/{projectId}/notes.md
          </span>
        </div>
        <span style={{ color: indicatorColor }}>{indicator}</span>
      </div>

      {saveError && (
        <div className="border-b border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {saveError}
        </div>
      )}

      {/* Editor + preview */}
      <div className="grid flex-1 grid-cols-2 overflow-hidden">
        <div className="flex flex-col border-r border-[var(--color-border)]">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            placeholder={
              isEmpty
                ? "# Notes for this project\n\nWrite anything: design sketches, TODOs, links, command runbooks. Markdown is rendered on the right.\n\nAuto-saves locally to cockpit/projects/" +
                  projectId +
                  "/notes.md."
                : ""
            }
            className="h-full w-full resize-none bg-[var(--color-surface-0)] p-3 text-[12.5px] leading-relaxed outline-none"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-text)",
            }}
            disabled={loading}
          />
        </div>
        <div className="overflow-auto bg-[var(--color-surface-1)] px-4 py-3">
          {isEmpty ? (
            <div className="rounded border border-dashed border-[var(--color-border)] p-6 text-center text-[11.5px] text-[var(--color-text-muted)]">
              <p className="font-medium text-[var(--color-text-secondary)]">
                No notes yet
              </p>
              <p className="mt-1">
                These notes live on disk under{" "}
                <span className="font-mono text-[10.5px]">
                  ~/.ultron/cockpit/projects/{projectId}/notes.md
                </span>
                .
                <br />
                Project-scoped, local-only, never synced.
              </p>
            </div>
          ) : (
            <div className="prose-tight">{renderBlocks(blocks)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
