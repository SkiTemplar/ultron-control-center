// v2.6 — Shared right-side detail pane for Library cards (Skills / Agents /
// Rules). The user's redesign brief:
//
//   "al hacer click sale al lado la información y los botones, las tarjetas
//    son iguales … con los botones de: Edit, Edit with AI, Open Externally
//    (Siempre abre el workspace y ese archivo) para que las skills con
//    múltiples carpetas abra todo su workspace."
//
// Each consumer (Skills / Agents / Rules) wires the same component with the
// fields it has on hand:
//   - `kind`      — visual accent tint (cyan / violet / amber).
//   - `name`      — heading.
//   - `subtitle`  — origin or relative path, shown under the heading.
//   - `filePath`  — absolute path of the file shown when "Open Externally"
//                   is clicked; also used as the read_text_file argument.
//   - `folderPath` — workspace folder that should accompany the file when
//                    opening in VS Code. Pass an empty string for items
//                    that live as a single .md (the opener will then just
//                    open the file).
//   - `onSave`    — async writer; receives the new body. Optional — if
//                   absent, the Edit button is hidden.
//
// State machine:
//   ┌── view ──┐  Edit ──► ┌── edit ──┐
//   │ markdown │           │ textarea │
//   └──────────┘  ◄── Cancel/Save ────┘
//
// Sibling-file tabs (point 4 of the brief) sit above the body when the
// folder has more than one file. Clicking a tab swaps which file is read.
// We re-use `list_skill_files` (already used in v27-f14) — it accepts the
// entry path of any skill / agent / rule and lists its parent folder.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Markdown } from "../../lib/markdown";
import {
  BookOpen,
  Bot,
  Edit,
  ExternalLink,
  FileCode,
  Folder,
  Save,
  Sparkle,
  Wand,
  X,
} from "./icons";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LibraryDetailKind = "skill" | "agent" | "rule";

export type LibraryDetailProps = {
  kind: LibraryDetailKind;
  /** Heading text — typically the slug or display name of the entry. */
  name: string;
  /** Subtitle line — origin chip text, relative path, or other context. */
  subtitle: string;
  /** Absolute on-disk path of the primary file. Used by both the
   *  "Open Externally" button and `read_text_file` to load the body. */
  filePath: string;
  /** Absolute on-disk path of the parent workspace folder. May be empty
   *  when the entry lives as a single .md outside a folder. */
  folderPath: string;
  /** Optional save callback. If absent, the Edit button is hidden. The
   *  callback receives the new body and must throw on failure. */
  onSave?: (body: string) => Promise<void>;
  /** Optional close handler — wires the X button. */
  onClose?: () => void;
};

// ---------------------------------------------------------------------------
// Visual accents per entry kind (matches the card grid in Skills/Agents/Rules)
// ---------------------------------------------------------------------------

type Accent = {
  /** Soft tint for the kind chip in the header. */
  chipBg: string;
  chipBorder: string;
  chipText: string;
  /** Strong color for the action accent (Edit button background, etc). */
  ribbon: string;
  /** Icon for the header. */
  Icon: React.FC<{ size?: number; className?: string }>;
  /** Display label for the kind. */
  label: string;
};

function accentFor(kind: LibraryDetailKind): Accent {
  switch (kind) {
    case "skill":
      return {
        chipBg: "rgba(56, 189, 248, 0.12)",
        chipBorder: "rgba(56, 189, 248, 0.45)",
        chipText: "#67e8f9",
        ribbon: "rgba(56, 189, 248, 0.55)",
        Icon: Sparkle,
        label: "Skill",
      };
    case "agent":
      return {
        chipBg: "rgba(167, 139, 250, 0.14)",
        chipBorder: "rgba(167, 139, 250, 0.45)",
        chipText: "#c4b5fd",
        ribbon: "rgba(167, 139, 250, 0.55)",
        Icon: Bot,
        label: "Agent",
      };
    case "rule":
      return {
        chipBg: "rgba(132, 204, 22, 0.14)",
        chipBorder: "rgba(132, 204, 22, 0.45)",
        chipText: "#bef264",
        ribbon: "rgba(132, 204, 22, 0.55)",
        Icon: BookOpen,
        label: "Rule",
      };
  }
}

// ---------------------------------------------------------------------------
// Sibling-file metadata returned by list_skill_files (kept in sync with the
// shape declared in Skills.tsx / Agents.tsx).
// ---------------------------------------------------------------------------

type SiblingFile = {
  name: string;
  path: string;
  is_dir: boolean;
  ext: string | null;
  size_bytes: number | null;
};

// Whitelist of extensions that the detail pane can render as text. Anything
// else (binary blobs, fonts, etc.) is non-clickable and only surfaces as a
// hint that the file exists.
const TEXTUAL_EXTS = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "yaml",
  "yml",
  "toml",
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "rs",
  "go",
  "java",
  "cs",
  "rb",
  "sh",
  "ps1",
  "sql",
  "css",
  "html",
  "xml",
]);

function isTextual(file: SiblingFile): boolean {
  if (file.is_dir) return false;
  if (!file.ext) return false;
  return TEXTUAL_EXTS.has(file.ext);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LibraryDetailPane({
  kind,
  name,
  subtitle,
  filePath,
  folderPath,
  onSave,
  onClose,
}: LibraryDetailProps) {
  const accent = accentFor(kind);

  // Active file = the one currently shown in the body. Defaults to the
  // primary file and changes when the user clicks a sibling tab.
  const [activePath, setActivePath] = useState<string>(filePath);
  const [body, setBody] = useState<string>("");
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);

  const [siblings, setSiblings] = useState<SiblingFile[]>([]);
  const [siblingsLoaded, setSiblingsLoaded] = useState(false);

  // Edit state — only allowed when `onSave` is provided AND the active file
  // is the primary file (we don't want users to overwrite arbitrary plugin
  // source files via the inline editor).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset state when the selected entry changes (new card click).
  useEffect(() => {
    setActivePath(filePath);
    setEditing(false);
    setSaveError(null);
    setSiblings([]);
    setSiblingsLoaded(false);
  }, [filePath]);

  // Load the active file body. Re-runs on tab switches.
  useEffect(() => {
    let cancelled = false;
    setBody("");
    setBodyError(null);
    if (!activePath) {
      return;
    }
    setBodyLoading(true);
    (async () => {
      try {
        const text = (await invoke("read_text_file", {
          path: activePath,
        })) as string;
        if (cancelled) return;
        setBody(text);
        setDraft(text);
      } catch (e) {
        if (cancelled) return;
        setBodyError(String(e));
      } finally {
        if (!cancelled) setBodyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // Lazy-load sibling files when the user first sees the pane. We only show
  // tabs when there's more than one textual file in the folder.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await invoke("list_skill_files", {
          entryPath: filePath || folderPath,
        })) as SiblingFile[];
        if (cancelled) return;
        setSiblings(list);
      } catch {
        // Non-fatal — the pane still works without sibling tabs.
        if (cancelled) return;
        setSiblings([]);
      } finally {
        if (!cancelled) setSiblingsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, folderPath]);

  // Tabs we render: textual siblings, primary file pinned to the front. We
  // never render directories as tabs — the user can open them externally.
  const tabs = useMemo(() => {
    const textuals = siblings.filter(isTextual);
    // Inject the primary file at index 0 if it isn't already there.
    const primaryName = filePath.split(/[\\/]/).pop() ?? filePath;
    const hasPrimary = textuals.some((s) => s.path === filePath);
    const ordered = hasPrimary
      ? textuals
      : [
          {
            name: primaryName,
            path: filePath,
            is_dir: false,
            ext:
              primaryName.split(".").pop()?.toLowerCase() ?? null,
            size_bytes: null,
          } as SiblingFile,
          ...textuals,
        ];
    // Primary first, then alpha-sorted.
    ordered.sort((a, b) => {
      if (a.path === filePath) return -1;
      if (b.path === filePath) return 1;
      return a.name.localeCompare(b.name);
    });
    return ordered;
  }, [siblings, filePath]);

  // ---- Actions ----

  const isPrimary = activePath === filePath;
  const canEdit = !!onSave && isPrimary;

  const handleOpenExternally = async () => {
    try {
      await invoke("open_in_vscode", {
        folderPath: folderPath || "",
        filePath: activePath || filePath || "",
      });
    } catch (e) {
      setSaveError(`open externally: ${String(e)}`);
    }
  };

  const handleEditWithAi = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(body);
      }
    } catch (e) {
      setSaveError(`clipboard: ${String(e)}`);
    }
    const kindLabel =
      kind === "skill"
        ? "Claude Code skill"
        : kind === "agent"
        ? "Claude Code subagent"
        : "Claude Code rule";
    const prompt =
      `Improve this ${kindLabel} for clarity and completeness. ` +
      `The current body is in your clipboard (paste it).\n\n` +
      `File: ${activePath}\n` +
      `Name: ${name}\n\n` +
      `Goals:\n` +
      `1. Keep the structure and intent intact.\n` +
      `2. Fill obvious gaps (missing examples, vague wording, dead links).\n` +
      `3. Stay concise — no filler, no marketing language.\n` +
      `4. Output the new file body only (no commentary). I'll paste it back.`;
    try {
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: folderPath || null,
        flags: { dangerouslySkipPermissions: false },
      });
    } catch (e) {
      setSaveError(`spawn_session: ${String(e)}`);
    }
  };

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setBody(draft);
      setEditing(false);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // ---- Render ----

  const Icon = accent.Icon;

  return (
    <aside
      className="flex h-full w-full flex-col overflow-hidden rounded-md"
      style={{
        border: "1px solid var(--color-border-strong)",
        background: "var(--color-surface-2)",
        boxShadow: `inset 0 3px 0 ${accent.ribbon}`,
      }}
    >
      {/* Header */}
      <header
        className="flex items-start justify-between gap-2 border-b p-3"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Icon
              size={13}
              className="shrink-0"
            />
            <span
              className="truncate text-[13.5px] font-semibold"
              style={{ color: "var(--color-text)" }}
              title={name}
            >
              {name}
            </span>
            <span
              className="ml-1 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
              style={{
                background: accent.chipBg,
                color: accent.chipText,
                border: `1px solid ${accent.chipBorder}`,
              }}
            >
              {accent.label}
            </span>
          </div>
          <div
            className="mt-0.5 truncate text-[10.5px]"
            style={{
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-mono)",
            }}
            title={filePath}
          >
            {subtitle}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1"
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
        )}
      </header>

      {/* Action bar */}
      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        {!editing ? (
          <>
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  setDraft(body);
                  setEditing(true);
                  setSaveError(null);
                }}
                disabled={bodyLoading || !!bodyError}
                className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                title="Edit this file inline"
              >
                <Edit size={11} /> Edit
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleEditWithAi()}
              disabled={bodyLoading || !!bodyError}
              className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px] disabled:opacity-40"
              style={{
                background: "var(--color-surface-3)",
                borderColor: "var(--color-border-strong)",
                color: "var(--color-text)",
              }}
              title="Spawn a Claude session with the body in your clipboard + an improvement prompt"
            >
              <Wand size={11} /> Edit with AI
            </button>
            <button
              type="button"
              onClick={() => void handleOpenExternally()}
              className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
              style={{
                background: "transparent",
                borderColor: "var(--color-border-strong)",
                color: "var(--color-text-secondary)",
              }}
              title={
                folderPath
                  ? `Open workspace folder in VS Code with ${
                      activePath.split(/[\\/]/).pop() ?? "this file"
                    } focused`
                  : "Open this file in VS Code"
              }
            >
              <ExternalLink size={11} /> Open Externally
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              <Save size={11} /> {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(body);
                setEditing(false);
                setSaveError(null);
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
      </div>

      {/* Sibling-file tabs — only when the entry has multiple textual files */}
      {siblingsLoaded && tabs.length > 1 && (
        <div
          className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span
            className="mr-1 text-[10px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            <Folder size={10} className="-mb-px mr-1 inline-block" />
            Files
          </span>
          {tabs.map((f) => {
            const isActive = f.path === activePath;
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => {
                  if (editing) return;
                  setActivePath(f.path);
                }}
                disabled={editing}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40"
                style={{
                  background: isActive
                    ? "var(--color-surface-4)"
                    : "var(--color-surface-2)",
                  borderColor: isActive
                    ? accent.chipBorder
                    : "var(--color-border)",
                  color: isActive
                    ? "var(--color-text)"
                    : "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                }}
                title={f.path}
              >
                <FileCode size={10} />
                <span className="truncate" style={{ maxWidth: 140 }}>
                  {f.name}
                </span>
              </button>
            );
          })}
        </div>
      )}

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
            Loading…
          </p>
        ) : bodyError ? (
          <p className="text-xs" style={{ color: "var(--color-danger)" }}>
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
        ) : isPrimary || activePath.endsWith(".md") ? (
          <Markdown source={body || "*(empty file)*"} />
        ) : (
          // Non-markdown sibling: render as a code block so the user can
          // still skim the contents without leaving the Control Center.
          <pre
            className="overflow-auto rounded p-3 text-[11.5px] leading-relaxed"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            <code>{body}</code>
          </pre>
        )}
      </div>
    </aside>
  );
}

export default LibraryDetailPane;
