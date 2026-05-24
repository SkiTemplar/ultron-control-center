// ULTRON Control Center 2.6 — Per-project Notes notebook (card-v26-fb-046).
//
// Multiple markdown notes scoped to a single project. Two-pane layout that
// mirrors the global Notes tab:
//   - left:  list of project notes (sorted by mtime) with inline "+ New"
//   - right: read-only Markdown preview OR raw textarea editor
//
// Persistence: `~/.ultron/cockpit/projects/<project_id>/notes/<slug>.md`
// owned by `project_notes_list` / `project_note_load` / `project_note_save`
// / `project_note_delete` (atomic tmp+rename on the Rust side).
//
// The legacy single-file `notes.md` continues to be served by
// `project_notes_load` / `project_notes_save` for back-compat, but this UI
// only operates on the per-slug notebook directory.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../../lib/dialog";
import { Markdown } from "../../lib/markdown";

type Props = { projectId: string };

type NoteEntry = {
  slug: string;
  title: string;
  size_bytes: number;
  modified_iso: string | null;
  preview: string;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const m = /^epoch:(\d+)$/.exec(iso);
  if (!m) return iso;
  const secs = parseInt(m[1], 10);
  if (!Number.isFinite(secs)) return iso;
  const diff = Date.now() / 1000 - secs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ProjectNotes({ projectId }: Props) {
  const [list, setList] = useState<NoteEntry[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [originalBody, setOriginalBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const newTitleRef = useRef<HTMLInputElement>(null);
  // -- delete confirm popover (v2.5.2 fb-notes-delete-popover) --
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const deletePopoverRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = (await invoke("project_notes_list", { projectId })) as NoteEntry[];
      setList(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedSlug(null);
    setBody("");
    setOriginalBody("");
    setEditing(false);
    void loadList();
  }, [projectId, loadList]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((n) =>
      `${n.title} ${n.slug} ${n.preview}`.toLowerCase().includes(q),
    );
  }, [list, query]);

  const selected = useMemo(
    () => list.find((n) => n.slug === selectedSlug) ?? null,
    [list, selectedSlug],
  );

  async function selectNote(slug: string) {
    if (editing && body !== originalBody) {
      const ok = await confirmDialog("Discard unsaved changes?", {
        title: "Project notes",
        kind: "warning",
        okLabel: "Discard",
      });
      if (!ok) return;
    }
    setSelectedSlug(slug);
    setEditing(false);
    setError(null);
    try {
      const text = (await invoke("project_note_load", {
        projectId,
        slug,
      })) as string;
      setBody(text);
      setOriginalBody(text);
    } catch (e) {
      setError(String(e));
    }
  }

  function startCreatingNew() {
    setCreatingNew(true);
    setNewTitle("");
    window.setTimeout(() => newTitleRef.current?.focus(), 0);
  }

  async function confirmCreateNew() {
    const title = newTitle.trim();
    if (!title) {
      setCreatingNew(false);
      return;
    }
    const base = slugify(title) || "note";
    const taken = new Set(list.map((n) => n.slug));
    const slug = uniqueSlug(base, taken);
    const initial = `# ${title}\n\n`;
    setCreatingNew(false);
    setNewTitle("");
    setSaving(true);
    setError(null);
    try {
      await invoke("project_note_save", { projectId, slug, body: initial });
      await loadList();
      setSelectedSlug(slug);
      setBody(initial);
      setOriginalBody(initial);
      setEditing(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function cancelCreateNew() {
    setCreatingNew(false);
    setNewTitle("");
  }

  async function saveCurrent() {
    if (!selectedSlug) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("project_note_save", {
        projectId,
        slug: selectedSlug,
        body,
      });
      setOriginalBody(body);
      setEditing(false);
      await loadList();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!deleteConfirmOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        deletePopoverRef.current &&
        !deletePopoverRef.current.contains(e.target as Node)
      ) {
        setDeleteConfirmOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [deleteConfirmOpen]);

  async function deleteCurrent() {
    if (!selectedSlug) return;
    setDeleteConfirmOpen(false);
    setSaving(true);
    setError(null);
    try {
      await invoke("project_note_delete", { projectId, slug: selectedSlug });
      setSelectedSlug(null);
      setBody("");
      setOriginalBody("");
      setEditing(false);
      await loadList();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = editing && body !== originalBody;

  return (
    <div className="flex h-full">
      <aside
        className="flex w-64 shrink-0 flex-col border-r"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div
          className="flex items-center justify-between gap-2 border-b px-3 py-2"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span className="text-[12.5px] font-semibold">Notes</span>
          <button
            type="button"
            onClick={startCreatingNew}
            disabled={saving || creatingNew}
            className="rounded-md px-2.5 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title="Create a new project note"
          >
            + New
          </button>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes…"
          className="m-2 rounded px-2 py-1 text-[12px] outline-none"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text)",
          }}
        />
        {creatingNew && (
          <div
            className="mx-2 mb-1 flex items-center gap-1 rounded-md border px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              borderColor: "var(--color-accent)",
            }}
          >
            <input
              ref={newTitleRef}
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmCreateNew();
                if (e.key === "Escape") cancelCreateNew();
              }}
              placeholder="Note title — press Enter to create"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              style={{ color: "var(--color-text)" }}
            />
            <button
              type="button"
              onClick={cancelCreateNew}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px]"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
              }}
              title="Cancel (Esc)"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p
              className="px-3 py-2 text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Loading…
            </p>
          ) : filtered.length === 0 ? (
            <p
              className="px-3 py-2 text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {list.length === 0
                ? "No notes yet. Click + New to create one."
                : "No matches."}
            </p>
          ) : (
            <ul className="space-y-px">
              {filtered.map((n) => {
                const active = n.slug === selectedSlug;
                return (
                  <li key={n.slug}>
                    <button
                      type="button"
                      onClick={() => void selectNote(n.slug)}
                      className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-[13px] transition-colors"
                      style={{
                        background: active
                          ? "var(--color-surface-3)"
                          : "transparent",
                        color: active
                          ? "var(--color-text)"
                          : "var(--color-text-secondary)",
                        borderLeft: active
                          ? "2px solid var(--color-accent)"
                          : "2px solid transparent",
                      }}
                    >
                      <span className="truncate font-medium">{n.title}</span>
                      {n.preview && (
                        <span
                          className="line-clamp-1 text-[11.5px]"
                          style={{ color: "var(--color-text-tertiary)" }}
                        >
                          {n.preview}
                        </span>
                      )}
                      <span
                        className="text-[10.5px] tabular-nums"
                        style={{ color: "var(--color-text-faint)" }}
                      >
                        {relativeTime(n.modified_iso)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div
            className="flex h-full items-center justify-center text-[12.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {list.length === 0
              ? "Create your first project note."
              : "Select a note to view or edit it."}
          </div>
        ) : (
          <>
            <header
              className="flex items-center justify-between gap-3 border-b px-4 py-2"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="min-w-0">
                <div
                  className="truncate text-[13.5px] font-semibold"
                  style={{ color: "var(--color-text)" }}
                  title={selected.title}
                >
                  {selected.title}
                </div>
                <div
                  className="truncate text-[10.5px]"
                  style={{
                    color: "var(--color-text-tertiary)",
                    fontFamily: "var(--font-mono)",
                  }}
                  title={selected.slug}
                >
                  cockpit/projects/{projectId}/notes/{selected.slug}.md
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {!editing ? (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="rounded-md border px-2.5 py-1 text-[11.5px]"
                    style={{
                      background: "var(--color-surface-2)",
                      borderColor: "var(--color-border-strong)",
                      color: "var(--color-text)",
                    }}
                  >
                    Edit
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void saveCurrent()}
                      disabled={!dirty || saving}
                      className="rounded-md px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
                      style={{
                        background: "var(--color-accent)",
                        color: "var(--color-accent-text)",
                      }}
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (dirty) {
                          void confirmDialog("Discard unsaved changes?", {
                            title: "Project notes",
                            kind: "warning",
                            okLabel: "Discard",
                          }).then((ok) => {
                            if (!ok) return;
                            setBody(originalBody);
                            setEditing(false);
                          });
                          return;
                        }
                        setBody(originalBody);
                        setEditing(false);
                      }}
                      disabled={saving}
                      className="rounded-md border px-2.5 py-1 text-[11.5px]"
                      style={{
                        background: "transparent",
                        borderColor: "var(--color-border-strong)",
                        color: "var(--color-text-tertiary)",
                      }}
                    >
                      Cancel
                    </button>
                  </>
                )}
                <div className="relative" ref={deletePopoverRef}>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmOpen((v) => !v)}
                    disabled={saving}
                    className="rounded-md border px-2.5 py-1 text-[11.5px]"
                    style={{
                      background: deleteConfirmOpen
                        ? "rgba(248, 81, 73, 0.10)"
                        : "transparent",
                      borderColor: "rgba(248, 81, 73, 0.32)",
                      color: "var(--color-danger)",
                    }}
                  >
                    Delete
                  </button>
                  {deleteConfirmOpen && (
                    <div
                      className="absolute right-0 z-20 mt-1 w-56 rounded-md border p-2 shadow-lg"
                      style={{
                        background: "var(--color-surface-2)",
                        borderColor: "rgba(248, 81, 73, 0.32)",
                      }}
                    >
                      <p
                        className="mb-2 text-[11.5px] leading-snug"
                        style={{ color: "var(--color-text)" }}
                      >
                        Delete <span className="font-semibold">{selected.title}</span>?
                      </p>
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmOpen(false)}
                          className="rounded border px-2 py-0.5 text-[11px]"
                          style={{
                            background: "transparent",
                            borderColor: "var(--color-border-strong)",
                            color: "var(--color-text-tertiary)",
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteCurrent()}
                          className="rounded px-2 py-0.5 text-[11px] font-medium"
                          style={{
                            background: "var(--color-danger)",
                            color: "#fff",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </header>

            {error && (
              <div
                className="mx-4 mt-2 rounded p-2 text-[11.5px]"
                style={{
                  background: "rgba(248, 81, 73, 0.06)",
                  border: "1px solid rgba(248, 81, 73, 0.22)",
                  color: "var(--color-danger)",
                }}
              >
                {error}
              </div>
            )}

            {/* v2.5.2 fb-notes-layout: same edge-to-edge pass as global Notes. */}
            <div className="flex-1 overflow-auto px-4 py-3">
              {editing ? (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  spellCheck={false}
                  className="h-full min-h-[400px] w-full resize-none rounded-md p-4 text-[14px] leading-relaxed outline-none"
                  style={{
                    background: "var(--color-surface-1)",
                    border: "1px solid var(--color-border-strong)",
                    color: "var(--color-text)",
                    fontFamily: "var(--font-mono)",
                  }}
                />
              ) : (
                <div className="text-[14px] leading-relaxed">
                  <Markdown source={body || "*(empty note)*"} />
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
