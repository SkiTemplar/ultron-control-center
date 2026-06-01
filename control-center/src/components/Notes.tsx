// ULTRON Control Center 2.6 — Global Notes tab (card-v26-fb-005)
//
// Cross-project markdown notes. File-per-note at
// `~/.ultron/cockpit/notes/<slug>.md`. Two-pane layout:
//   - left: list of notes sorted by modified time
//   - right: edit (textarea) or preview (Markdown) for the selected note

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../lib/dialog";
import { Markdown } from "../lib/markdown";
import {
  addTodo,
  clearDone,
  loadTodos,
  onTodosUpdated,
  removeTodo,
  toggleTodo,
  type TodoItem,
} from "../lib/todos";

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

export function Notes() {
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
  // -- To-Do panel (fullize 2026-06-01) — shared store with Dashboard TodoCard --
  const [todos, setTodos] = useState<TodoItem[]>(() => loadTodos());
  const [todoDraft, setTodoDraft] = useState("");
  const todoInputRef = useRef<HTMLInputElement>(null);
  // -- delete confirm popover (v2.5.2 fb-notes-delete-popover) --
  // The old global confirmDialog appeared in the bottom-left, way far from
  // the Delete button (top-right). Use an inline contextual popover anchored
  // to the Delete button instead so the confirm shows up next to where the
  // user clicked.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const deletePopoverRef = useRef<HTMLDivElement>(null);

  // Returns the refreshed list so callers can batch follow-up state changes
  // (e.g. setSelectedSlug) in the same render, preventing a flash where the
  // list is populated but selectedSlug still points to null.
  const loadList = useCallback(async (): Promise<NoteEntry[]> => {
    setLoading(true);
    setError(null);
    try {
      const r = (await invoke("notes_list_global")) as NoteEntry[];
      setList(r);
      return r;
    } catch (e) {
      setError(String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

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
        title: "Notes",
        kind: "warning",
        okLabel: "Discard",
      });
      if (!ok) return;
    }
    setSelectedSlug(slug);
    setEditing(false);
    setError(null);
    try {
      const text = (await invoke("notes_load_global", { slug })) as string;
      setBody(text);
      setOriginalBody(text);
    } catch (e) {
      setError(String(e));
    }
  }

  function startCreatingNew() {
    setCreatingNew(true);
    setNewTitle("");
    // Focus the input on the next paint cycle.
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
      await invoke("notes_save_global", { slug, body: initial });
      const updated = await loadList();
      // Guard: only auto-select when the backend confirms the note is visible
      // in the listing (handles edge cases where the file write races the read).
      if (updated.some((n) => n.slug === slug)) {
        setSelectedSlug(slug);
        setBody(initial);
        setOriginalBody(initial);
        setEditing(true);
      }
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
      await invoke("notes_save_global", { slug: selectedSlug, body });
      setOriginalBody(body);
      setEditing(false);
      await loadList();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Keep the To-Do panel in sync with the Dashboard's TodoCard (same store).
  useEffect(() => onTodosUpdated(() => setTodos(loadTodos())), []);

  function submitTodo() {
    if (!todoDraft.trim()) return;
    setTodos(addTodo(todoDraft));
    setTodoDraft("");
    todoInputRef.current?.focus();
  }

  const doneTodos = todos.filter((t) => t.done).length;

  // Close the delete-confirm popover when clicking outside it.
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
      await invoke("notes_delete_global", { slug: selectedSlug });
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
        className="flex w-72 shrink-0 flex-col border-r"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div
          className="flex items-center justify-between gap-2 border-b px-3 py-2"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span className="text-[13px] font-semibold">Notes</span>
          <button
            type="button"
            onClick={startCreatingNew}
            disabled={saving || creatingNew}
            className="rounded-md px-2.5 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title="Create a new global note"
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
              className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px]"
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
            <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              Loading…
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              {list.length === 0 ? "No notes yet. Click + New to create one." : "No matches."}
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
                        background: active ? "var(--color-surface-3)" : "transparent",
                        color: active ? "var(--color-text)" : "var(--color-text-secondary)",
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

        {/* To-Do panel (fullize 2026-06-01). Shares lib/todos.ts with the
            Dashboard's TodoCard — add here, see it there, and vice versa.
            KISS: input + add, list with check/text/delete, "Limpiar hechas". */}
        <section
          className="flex max-h-[45%] shrink-0 flex-col border-t"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div
            className="flex items-center justify-between gap-2 px-3 py-2"
          >
            <span className="text-[13px] font-semibold">To-Do</span>
            {doneTodos > 0 && (
              <button
                type="button"
                onClick={() => setTodos(clearDone())}
                className="rounded px-1.5 py-0.5 text-[10.5px] hover:underline"
                style={{ color: "var(--color-text-tertiary)" }}
                title="Quitar las completadas"
              >
                Limpiar hechas
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 px-2 pb-2">
            <input
              ref={todoInputRef}
              type="text"
              value={todoDraft}
              onChange={(e) => setTodoDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitTodo();
                }
              }}
              placeholder="Nueva tarea…"
              className="min-w-0 flex-1 rounded px-2 py-1 text-[12px] outline-none"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border-strong)",
                color: "var(--color-text)",
              }}
            />
            <button
              type="button"
              onClick={submitTodo}
              disabled={!todoDraft.trim()}
              className="shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
              title="Añadir tarea"
            >
              +
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {todos.length === 0 ? (
              <p
                className="px-1 py-1 text-[11.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Sin tareas. Añade una arriba.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {todos.map((t) => (
                  <li
                    key={t.id}
                    className="group flex items-center gap-2 rounded px-1 py-1 text-[12.5px]"
                  >
                    <input
                      type="checkbox"
                      checked={t.done}
                      onChange={() => setTodos(toggleTodo(t.id))}
                      className="h-3.5 w-3.5 shrink-0 cursor-pointer"
                    />
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={t.text}
                      style={{
                        color: t.done
                          ? "var(--color-text-faint)"
                          : "var(--color-text)",
                        textDecoration: t.done ? "line-through" : "none",
                      }}
                    >
                      {t.text}
                    </span>
                    <button
                      type="button"
                      onClick={() => setTodos(removeTodo(t.id))}
                      title="Borrar"
                      className="shrink-0 px-1 text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div
            className="flex h-full items-center justify-center text-[12.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {list.length === 0 ? "Create your first note." : "Select a note to view or edit it."}
          </div>
        ) : (
          <>
            <header
              className="flex items-center justify-between gap-3 border-b px-4 py-2"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="min-w-0">
                <div
                  className="truncate text-[14px] font-semibold"
                  style={{ color: "var(--color-text)" }}
                  title={selected.title}
                >
                  {selected.title}
                </div>
                <div
                  className="truncate text-[10.5px]"
                  style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}
                  title={selected.slug}
                >
                  ~/.ultron/cockpit/notes/{selected.slug}.md
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
                            title: "Notes",
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

            {/* v2.5.2 fb-notes-layout: drop the chunky outer padding so the
                editor/preview fills the right pane edge-to-edge (no wasted
                margin around it). The textarea/markdown already provide their
                own breathing room. */}
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

export default Notes;
