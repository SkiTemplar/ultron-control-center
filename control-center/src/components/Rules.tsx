// ULTRON Control Center 2.6 — Rules viewer.
//
// USER's quote: "no puedo ver todo lo que incluye una rule, entonces la
// verdad es que no sé qué puede tener... poder editarla quizá directamente
// desde el archivo y tal".
//
// What changed in v2.6:
//   - 3-way view toggle (Grid / Tree / Blocks). Default = Blocks.
//   - Clicking a rule (in any view) opens a right-side detail panel that:
//       · renders the full markdown via lib/markdown.tsx
//       · has an inline "Edit" textarea with Save/Cancel (rules_write)
//       · has "Edit with AI" which spawns a Claude session pre-loaded with
//         the rule body in the clipboard + an improvement prompt
//   - Layout becomes a 2-pane split when the detail panel is open. The
//     left pane stays interactive; clicking another rule re-loads.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { RuleFile } from "../types";
import { BookOpen, Edit, Folder, Save, Wand, X } from "./library/icons";
import { TreeView, type TreeOrigin } from "./library/TreeView";
import {
  BlocksView,
  type BlocksItem,
} from "./library/BlocksView";
import { ViewToggle, useLibraryViewMode } from "./library/ViewToggle";
import { Markdown } from "../lib/markdown";

const NO_CATEGORY = "root";

function deriveCategory(r: RuleFile): string {
  const rel = (r.relative ?? "").replace(/\\/g, "/");
  const first = rel.split("/")[0];
  if (!first || first === r.name || first.endsWith(".md")) return NO_CATEGORY;
  return first;
}

/// Sub-category derived from the second path segment. e.g. for
///   typescript/coding-style.md  → top: "typescript", sub: null (file)
///   common/git/workflow.md      → top: "common",     sub: "git"
function deriveSubGroup(r: RuleFile): string | null {
  const rel = (r.relative ?? "").replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  return parts[1];
}

export function Rules() {
  const [rules, setRules] = useState<RuleFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [view, setView] = useLibraryViewMode("rules");

  // Detail-panel state.
  const [selected, setSelected] = useState<RuleFile | null>(null);
  const [body, setBody] = useState<string>("");
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await invoke("rules_list")) as RuleFile[];
      setRules(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rules) set.add(deriveCategory(r));
    return Array.from(set).sort((a, b) => {
      if (a === NO_CATEGORY) return 1;
      if (b === NO_CATEGORY) return -1;
      return a.localeCompare(b);
    });
  }, [rules]);

  useEffect(() => {
    if (category !== "all" && !categories.includes(category)) {
      setCategory("all");
    }
  }, [categories, category]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules.filter((r) => {
      if (category !== "all" && deriveCategory(r) !== category) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.relative.toLowerCase().includes(q) ||
        (r.preview ?? "").toLowerCase().includes(q)
      );
    });
  }, [rules, category, query]);

  // Tree-view: 1 synthetic origin per top-level folder ("common", "rust",
  // "typescript"). Inside each, group by sub-folder (or use "*" leaves at
  // the top when the rule is directly under the folder).
  const treeOrigins: TreeOrigin<RuleFile>[] = useMemo(() => {
    const byTop = new Map<string, RuleFile[]>();
    for (const r of filtered) {
      const top = deriveCategory(r);
      const arr = byTop.get(top) ?? [];
      arr.push(r);
      byTop.set(top, arr);
    }
    return Array.from(byTop.entries())
      .sort(([a], [b]) => {
        if (a === NO_CATEGORY) return 1;
        if (b === NO_CATEGORY) return -1;
        return a.localeCompare(b);
      })
      .map(([id, list]) => {
        // Group by sub-folder or "(root)" when the rule lives directly under
        // the top-level folder.
        const byGroup = new Map<string, RuleFile[]>();
        for (const r of list) {
          const sub = deriveSubGroup(r) ?? "(root)";
          const arr = byGroup.get(sub) ?? [];
          arr.push(r);
          byGroup.set(sub, arr);
        }
        return {
          id,
          label: id,
          groups: Array.from(byGroup.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, leaves]) => ({
              name,
              leaves: leaves.map((r) => ({
                key: r.path,
                label: r.name,
                data: r,
              })),
            })),
        };
      });
  }, [filtered]);

  // Blocks-view items.
  const blockItems: BlocksItem<RuleFile>[] = useMemo(
    () =>
      filtered.map((r) => ({
        key: r.path,
        topGroup:
          deriveCategory(r) === NO_CATEGORY ? "Root" : deriveCategory(r),
        subGroup: deriveSubGroup(r),
        data: r,
      })),
    [filtered],
  );

  const handleOpenExternal = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      setError(`open ${path}: ${e}`);
    }
  };

  // ---- Detail pane wiring ----

  const openDetail = async (r: RuleFile) => {
    setSelected(r);
    setEditing(false);
    setSaveError(null);
    setBodyError(null);
    setBody("");
    setBodyLoading(true);
    try {
      const text = (await invoke("rules_read", { path: r.path })) as string;
      setBody(text);
      setDraft(text);
    } catch (e) {
      setBodyError(String(e));
    } finally {
      setBodyLoading(false);
    }
  };

  const closeDetail = () => {
    setSelected(null);
    setEditing(false);
    setSaveError(null);
    setBody("");
    setDraft("");
  };

  const startEdit = () => {
    setDraft(body);
    setEditing(true);
    setSaveError(null);
  };

  const cancelEdit = () => {
    setDraft(body);
    setEditing(false);
    setSaveError(null);
  };

  const saveEdit = async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      // rules_write takes the relative path inside ~/.claude/rules/. The
      // RuleFile.relative is exactly that (e.g. "typescript/coding-style.md").
      await invoke("rules_write", {
        name: selected.relative,
        body: draft,
      });
      setBody(draft);
      setEditing(false);
      // Refresh the list to update the preview text.
      void reload();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // Spawn a Claude session with the rule body in the clipboard and a
  // pre-baked improvement prompt — mirrors the existing spawn_session pattern
  // used by lib/button-prompts.ts and Plans.tsx.
  const editWithAi = async () => {
    if (!selected) return;
    // navigator.clipboard is the established pattern in this codebase (see
    // lib/button-prompts.ts) — the Tauri 2 WebView exposes it directly so
    // we don't pull in @tauri-apps/plugin-clipboard-manager.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(body);
      }
    } catch (e) {
      // Clipboard failure is non-fatal — surface the error but still spawn.
      setSaveError(`clipboard: ${String(e)}`);
    }
    const prompt =
      `Improve this Claude Code rule for clarity and completeness. ` +
      `The current rule body is in your clipboard (paste it).\n\n` +
      `Rule file: ${selected.relative}\n` +
      `Rule name: ${selected.name}\n\n` +
      `Goals:\n` +
      `1. Keep the structure and intent intact.\n` +
      `2. Fill obvious gaps (missing examples, vague wording, dead links).\n` +
      `3. Stay concise — no filler, no marketing language.\n` +
      `4. Output the new file body only (no commentary). I'll paste it back.`;
    try {
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: null,
        flags: { dangerouslySkipPermissions: false },
      });
    } catch (e) {
      setSaveError(`spawn_session: ${String(e)}`);
    }
  };

  // ---- Card grid (used by Grid mode + Blocks leaves) ----

  const renderCardGrid = (items: RuleFile[]) => (
    <ul className="grid gap-2 md:grid-cols-2">
      {items.map((r) => {
        const cat = deriveCategory(r);
        const isActive = selected?.path === r.path;
        return (
          <li
            key={r.path}
            className="cursor-pointer rounded-md p-3 text-sm transition-colors"
            style={{
              border: `1px solid ${
                isActive
                  ? "var(--color-accent)"
                  : "var(--color-border-strong)"
              }`,
              background: isActive
                ? "var(--color-surface-3)"
                : "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            onClick={() => void openDetail(r)}
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <BookOpen
                  size={12}
                  className="shrink-0 text-[var(--color-text-tertiary)]"
                />
                <span className="truncate font-medium">{r.name}</span>
              </div>
              <span
                className="truncate text-[10.5px]"
                style={{
                  color: "var(--color-text-tertiary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {r.relative}
              </span>
            </div>
            {cat !== NO_CATEGORY && (
              <div
                className="mb-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                <Folder size={10} /> {cat}
              </div>
            )}
            <pre
              className="mb-2 max-h-20 overflow-hidden whitespace-pre-wrap text-xs leading-snug"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {r.preview || "(sin preview)"}
            </pre>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void openDetail(r);
                }}
                className="rounded-md border px-2 py-0.5 text-xs"
                style={{
                  borderColor: "var(--color-border-strong)",
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                View
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleOpenExternal(r.path);
                }}
                className="rounded-md border px-2 py-0.5 text-xs"
                style={{
                  borderColor: "var(--color-border-strong)",
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                }}
              >
                Open externally
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );

  // ---- Detail pane ----

  const DetailPane = () => {
    if (!selected) return null;
    return (
      <aside
        className="flex h-full w-full flex-col overflow-hidden rounded-md"
        style={{
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-surface-2)",
        }}
      >
        <header
          className="flex items-start justify-between gap-2 border-b p-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <BookOpen size={13} className="text-[var(--color-text-tertiary)]" />
              <span
                className="truncate text-[13.5px] font-semibold"
                style={{ color: "var(--color-text)" }}
                title={selected.name}
              >
                {selected.name}
              </span>
            </div>
            <div
              className="mt-0.5 truncate text-[10.5px]"
              style={{
                color: "var(--color-text-tertiary)",
                fontFamily: "var(--font-mono)",
              }}
              title={selected.path}
            >
              {selected.relative}
            </div>
          </div>
          <button
            type="button"
            onClick={closeDetail}
            className="rounded p-1 transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
            title="Close detail panel"
            aria-label="Close"
          >
            <X size={12} />
          </button>
        </header>

        {/* Action bar */}
        <div
          className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
          style={{ borderColor: "var(--color-border)" }}
        >
          {!editing ? (
            <>
              <button
                type="button"
                onClick={startEdit}
                disabled={bodyLoading || !!bodyError}
                className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                title="Edit this rule inline"
              >
                <Edit size={11} /> Edit
              </button>
              <button
                type="button"
                onClick={() => void editWithAi()}
                disabled={bodyLoading || !!bodyError}
                className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  borderColor: "var(--color-border-strong)",
                  color: "var(--color-text)",
                }}
                title="Spawn a Claude session with the rule body in your clipboard + an improvement prompt"
              >
                <Wand size={11} /> Edit with AI
              </button>
              <button
                type="button"
                onClick={() => void handleOpenExternal(selected.path)}
                className="rounded-md border px-2.5 py-1 text-[11.5px] transition-colors"
                style={{
                  background: "transparent",
                  borderColor: "var(--color-border-strong)",
                  color: "var(--color-text-secondary)",
                }}
                title="Open in the OS-default editor"
              >
                Open externally
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void saveEdit()}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                <Save size={11} /> {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
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
        </div>

        {saveError && (
          <div
            className="mx-3 mt-2 rounded-md p-2 text-[11.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.08)",
              border: "1px solid rgba(248, 81, 73, 0.30)",
              color: "var(--color-danger)",
            }}
          >
            {saveError}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {bodyLoading ? (
            <p
              className="text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Loading rule body…
            </p>
          ) : bodyError ? (
            <p
              className="text-xs"
              style={{ color: "var(--color-danger)" }}
            >
              {bodyError}
            </p>
          ) : editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-full min-h-[400px] w-full resize-none rounded-md p-3 text-[12.5px] leading-relaxed outline-none"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border-strong)",
                color: "var(--color-text)",
                fontFamily: "var(--font-mono)",
              }}
            />
          ) : (
            <Markdown source={body || "*(empty file)*"} />
          )}
        </div>
      </aside>
    );
  };

  // ---- Render ----

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Rules</h2>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            ~/.claude/rules/**/*.md · {filtered.length} of {rules.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle mode={view} onChange={setView} />
          <button
            onClick={reload}
            className="rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          >
            Refresh
          </button>
        </div>
      </header>

      {view !== "blocks" && categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="text-[10.5px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Category
          </span>
          <button
            onClick={() => setCategory("all")}
            className="rounded-full border px-2.5 py-0.5 text-[11px] transition-colors"
            style={{
              borderColor:
                category === "all"
                  ? "var(--color-text)"
                  : "var(--color-border-strong)",
              background:
                category === "all"
                  ? "var(--color-surface-4)"
                  : "transparent",
              color:
                category === "all"
                  ? "var(--color-text)"
                  : "var(--color-text-secondary)",
            }}
          >
            All
          </button>
          {categories.map((c) => {
            const active = c === category;
            return (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className="rounded-full border px-2.5 py-0.5 text-[11px] transition-colors"
                style={{
                  borderColor: active
                    ? "var(--color-text)"
                    : "var(--color-border-strong)",
                  background: active
                    ? "var(--color-surface-4)"
                    : "transparent",
                  color: active
                    ? "var(--color-text)"
                    : "var(--color-text-secondary)",
                }}
              >
                {c}
              </button>
            );
          })}
        </div>
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar rules…"
        className="w-full rounded-md px-3 py-2 text-sm outline-none"
        style={{
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-surface-2)",
          color: "var(--color-text)",
        }}
      />

      {error && (
        <div
          className="rounded-md p-3 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Layout: list pane on the left, detail pane on the right when open.
          On narrow viewports both panes stack vertically (rules list above,
          detail below) — keeps the editor usable on smaller windows. */}
      <div
        className="flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row"
      >
        <div
          className={selected ? "min-w-0 flex-1 overflow-y-auto" : "flex-1 overflow-y-auto"}
          style={{ minWidth: 0 }}
        >
          {loading ? (
            <p
              className="text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Loading…
            </p>
          ) : filtered.length === 0 ? (
            <p
              className="text-xs"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Sin reglas para el filtro actual.
            </p>
          ) : view === "blocks" ? (
            <BlocksView<RuleFile>
              items={blockItems}
              noun="rule"
              emptyLabel="Sin reglas para el filtro actual."
              renderLeaves={(items) =>
                renderCardGrid(items.map((it) => it.data))
              }
            />
          ) : view === "tree" ? (
            <TreeView<RuleFile>
              origins={treeOrigins}
              selectedKey={selected?.path ?? null}
              onSelect={(leaf) => void openDetail(leaf.data)}
              query={query}
            />
          ) : (
            renderCardGrid(filtered)
          )}
        </div>

        {selected && (
          <div
            className="overflow-hidden lg:w-[520px] lg:shrink-0"
            style={{ minWidth: 0 }}
          >
            <DetailPane />
          </div>
        )}
      </div>
    </div>
  );
}
