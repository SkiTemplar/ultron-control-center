// ProjectWizardModal — create / edit project overlay modal.
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectExecutable, ProjectShell, SessionProvider } from "../../types";

export interface ProjectWizardState {
  editingId: string | null;
  wName: string;
  wPath: string;
  wTags: string;
  wIde: string;
  wDefaultProvider: SessionProvider;
  wDefaultShell: ProjectShell | "";
  wParentFolderOverride: string;
  wNotes: string;
  wExecutables: ProjectExecutable[];
  creating: boolean;
  createError: string | null;
  tagPool: string[];
  wTagsParsed: string[];
}

export interface ProjectWizardModalProps extends ProjectWizardState {
  onClose: () => void;
  onSave: () => void;
  onPickPath: () => void;
  onToggleTag: (tag: string) => void;
  setWName: (v: string) => void;
  setWPath: (v: string) => void;
  setWTags: (v: string) => void;
  setWIde: (v: string) => void;
  setWDefaultProvider: (v: SessionProvider) => void;
  setWDefaultShell: (v: ProjectShell | "") => void;
  setWParentFolderOverride: (v: string) => void;
  setWNotes: (v: string) => void;
  setWExecutables: (updater: (prev: ProjectExecutable[]) => ProjectExecutable[]) => void;
}

export function ProjectWizardModal({
  editingId,
  wName, wPath, wTags, wIde, wDefaultProvider, wDefaultShell,
  wParentFolderOverride, wNotes, wExecutables,
  creating, createError, tagPool, wTagsParsed,
  onClose, onSave, onPickPath, onToggleTag,
  setWName, setWPath, setWTags, setWIde,
  setWDefaultProvider, setWDefaultShell,
  setWParentFolderOverride, setWNotes, setWExecutables,
}: ProjectWizardModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={editingId ? "Edit project" : "New project"}
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-3xl rounded-lg p-4 shadow-xl"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[12px] font-medium" style={{ color: "var(--color-text)" }}>
            {editingId ? `Edit project: ${editingId}` : "New project"}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-1.5 py-0.5 text-[12px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            ×
          </button>
        </div>

        {/* Form grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* Name */}
          <div>
            <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Name
            </label>
            <input
              type="text"
              value={wName}
              onChange={(e) => setWName(e.target.value)}
              placeholder="e.g. My Game"
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
          </div>

          {/* Path */}
          <div>
            <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Path (optional — leave blank for pure launch group)
            </label>
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={wPath}
                onChange={(e) => setWPath(e.target.value)}
                placeholder="C:\Users\... (or leave empty)"
                className="flex-1 rounded px-2 py-1.5 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  fontFamily: "var(--font-mono)",
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={onPickPath}
                className="rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title="Pick a folder"
              >
                Folder
              </button>
            </div>
          </div>

          {/* IDE */}
          <div>
            <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              IDE (preferred editor for "Launch all" + IDE button)
            </label>
            <select
              value={wIde}
              onChange={(e) => setWIde(e.target.value)}
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            >
              <option value="">(none — auto-detect)</option>
              <option value="vscode">VS Code</option>
              <option value="cursor">Cursor</option>
              <option value="code-insiders">VS Code Insiders</option>
              <option value="zed">Zed</option>
              <option value="intellij">IntelliJ IDEA</option>
              <option value="rider">Rider</option>
              <option value="webstorm">WebStorm</option>
              <option value="pycharm">PyCharm</option>
              <option value="clion">CLion</option>
              <option value="androidstudio">Android Studio</option>
              <option value="fleet">JetBrains Fleet</option>
              <option value="nvim">Neovim</option>
              <option value="sublime">Sublime Text</option>
            </select>
          </div>

          {/* Tags */}
          <div className="col-span-2">
            <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Tags (comma-separated)
            </label>
            <input
              type="text"
              value={wTags}
              onChange={(e) => setWTags(e.target.value)}
              placeholder="e.g. gaming, work, personal"
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
            {tagPool.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                <span
                  className="self-center text-[9.5px] uppercase tracking-[0.06em]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  pool ·
                </span>
                {tagPool.map((tag) => {
                  const active = wTagsParsed.some((t) => t.toLowerCase() === tag.toLowerCase());
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => onToggleTag(tag)}
                      className="rounded px-1.5 py-px text-[10.5px] transition-colors"
                      style={{
                        background: active ? "var(--color-accent)" : "var(--color-surface-1)",
                        color: active ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
                        border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
                      }}
                      title={active ? `Remove "${tag}" from this project` : `Add "${tag}" to this project`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Default provider */}
          <div>
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Provider used when you click the AI button on this project's card."
            >
              Default provider
            </label>
            <select
              value={wDefaultProvider}
              onChange={(e) => setWDefaultProvider(e.target.value as SessionProvider)}
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            >
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="codex">Codex</option>
            </select>
          </div>

          {/* Default shell */}
          <div>
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Shell launched when you open a non-AI terminal in this project's workspace."
            >
              Default shell
            </label>
            <select
              value={wDefaultShell}
              onChange={(e) => setWDefaultShell(e.target.value as ProjectShell | "")}
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            >
              <option value="">(default — global setting)</option>
              <option value="powershell">PowerShell</option>
              <option value="powershell-admin">PowerShell (admin)</option>
              <option value="cmd">cmd.exe</option>
              <option value="bash">Bash / Git Bash</option>
            </select>
          </div>

          {/* Parent folder override */}
          <div className="col-span-2">
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Override the cwd new terminals open in (leave empty to use the project path)."
            >
              Parent folder override (optional)
            </label>
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={wParentFolderOverride}
                onChange={(e) => setWParentFolderOverride(e.target.value)}
                placeholder="(empty — use the project path)"
                className="flex-1 rounded px-2 py-1.5 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  fontFamily: "var(--font-mono)",
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={async () => {
                  try {
                    const picked = await openDialog({ directory: true, multiple: false, title: "Parent folder for new terminals" });
                    if (typeof picked === "string" && picked) setWParentFolderOverride(picked);
                  } catch { /* user cancelled */ }
                }}
                className="rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title="Pick a folder"
              >
                Folder
              </button>
            </div>
          </div>

          {/* Notes */}
          <div className="col-span-2">
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Free-form notes attached to this project (not the Notes tab)."
            >
              Notes (optional)
            </label>
            <textarea
              value={wNotes}
              onChange={(e) => setWNotes(e.target.value)}
              rows={4}
              placeholder="Project-specific reminders, stack notes, todos that don't deserve a kanban card…"
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
                resize: "vertical",
                minHeight: 72,
                fontFamily: "var(--font-mono)",
              }}
            />
          </div>

          {/* Executables editor */}
          <div className="col-span-2">
            <div className="flex items-center justify-between">
              <label
                className="text-[10px] uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
                title="Bind .exe / .lnk / .bat shortcuts to this project."
              >
                Executables (Quick Launch on Project Home)
              </label>
              <button
                type="button"
                onClick={() => setWExecutables((prev) => [...prev, { name: "", path: "" }])}
                className="rounded px-2 py-0.5 text-[10.5px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title="Add a new executable entry"
              >
                + Add executable
              </button>
            </div>
            <div className="mt-1 space-y-1.5">
              {wExecutables.length === 0 && (
                <p className="text-[11.5px]" style={{ color: "var(--color-text-faint)" }}>
                  None bound. Click "+ Add executable" to create a Quick Launch button.
                </p>
              )}
              {wExecutables.map((exe, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="text"
                    value={exe.name}
                    onChange={(e) =>
                      setWExecutables((prev) =>
                        prev.map((row, i) => i === idx ? { ...row, name: e.target.value } : row)
                      )
                    }
                    placeholder="e.g. Launch Game"
                    className="min-w-[120px] flex-1 rounded px-2 py-1 text-[11.5px]"
                    style={{
                      background: "var(--color-surface-1)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border-strong)",
                      outline: "none",
                    }}
                  />
                  <input
                    type="text"
                    value={exe.path}
                    onChange={(e) =>
                      setWExecutables((prev) =>
                        prev.map((row, i) => i === idx ? { ...row, path: e.target.value } : row)
                      )
                    }
                    placeholder="C:/Program Files/MyGame/MyGame.exe"
                    className="min-w-[200px] flex-[2] rounded px-2 py-1 text-[11.5px]"
                    style={{
                      background: "var(--color-surface-1)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border-strong)",
                      fontFamily: "var(--font-mono)",
                      outline: "none",
                    }}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const picked = await openDialog({
                          directory: false,
                          multiple: false,
                          title: "Pick an executable",
                          filters: [{ name: "Executables", extensions: ["exe", "lnk", "bat", "cmd"] }],
                        });
                        if (typeof picked === "string" && picked) {
                          setWExecutables((prev) =>
                            prev.map((row, i) => {
                              if (i !== idx) return row;
                              const nameAuto = row.name.trim()
                                ? row.name
                                : picked.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop()
                                    ?.replace(/\.(exe|lnk|bat|cmd)$/i, "") ?? "";
                              return { ...row, path: picked, name: nameAuto };
                            })
                          );
                        }
                      } catch { /* user cancelled */ }
                    }}
                    className="rounded px-2 py-1 text-[11.5px]"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text-secondary)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                    title="Pick an .exe / .lnk / .bat / .cmd"
                  >
                    Pick
                  </button>
                  <button
                    type="button"
                    onClick={() => setWExecutables((prev) => prev.filter((_, i) => i !== idx))}
                    className="rounded px-1.5 py-1 text-[11.5px]"
                    style={{
                      background: "transparent",
                      color: "var(--color-danger)",
                      border: "1px solid rgba(248, 81, 73, 0.32)",
                    }}
                    title="Remove this executable"
                    aria-label="Remove executable"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {editingId === null && wExecutables.length > 0 && (
              <p className="mt-1 text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                Save the new project first, then re-open Edit to bind executables.
              </p>
            )}
          </div>
        </div>

        {createError && (
          <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            {createError}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onSave}
            disabled={creating || !wName.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {creating
              ? editingId ? "Saving…" : "Creating…"
              : editingId ? "Save" : "Create"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancel
          </button>
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed" style={{ color: "var(--color-text-tertiary)" }}>
          After creating the project, use "+ Add item" on the row to attach launcher items.
        </p>
      </div>
    </div>
  );
}
