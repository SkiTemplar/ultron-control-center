// AddItemModal — modal for adding a launcher item to a project.
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import type { LauncherItemKind, ProjectInfo, SessionProvider } from "../../types";
import { ITEM_KINDS } from "./utils";

export interface AddItemModalProps {
  itemTarget: ProjectInfo;
  iKind: LauncherItemKind;
  iPath: string;
  iCwd: string;
  iArgs: string;
  iLabel: string;
  iProvider: SessionProvider;
  itemSaving: boolean;
  itemError: string | null;
  onClose: () => void;
  onSave: () => void;
  onPickFile: () => void;
  onPickFolder: () => void;
  setIKind: (v: LauncherItemKind) => void;
  setIPath: (v: string) => void;
  setICwd: (v: string) => void;
  setIArgs: (v: string) => void;
  setILabel: (v: string) => void;
  setIProvider: (v: SessionProvider) => void;
}

export function AddItemModal({
  itemTarget,
  iKind, iPath, iCwd, iArgs, iLabel, iProvider,
  itemSaving, itemError,
  onClose, onSave, onPickFile, onPickFolder,
  setIKind, setIPath, setICwd, setIArgs, setILabel, setIProvider,
}: AddItemModalProps) {
  const saveDisabled =
    itemSaving ||
    ((iKind === "exe" || iKind === "folder") && !iPath.trim()) ||
    (iKind === "ide" && !iPath.trim() && !itemTarget.path) ||
    ((iKind === "claude" || iKind === "codex" || iKind === "gemini" || iKind === "session") &&
      !iCwd.trim() && !itemTarget.path);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={() => !itemSaving && onClose()}
    >
      <div
        className="w-full max-w-[520px] rounded p-5"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[14px] font-semibold">
          Add item — {itemTarget.name ?? itemTarget.id}
        </h3>
        <p className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Pick a kind and supply its path. The item appears as a chip on the project row;
          clicking "Launch all" fires every item in order.
        </p>

        <div className="mt-3 space-y-3">
          {/* Kind selector */}
          <div>
            <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Kind
            </label>
            <select
              value={iKind}
              onChange={(e) => setIKind(e.target.value as LauncherItemKind)}
              className="mt-1 w-full rounded px-2 py-1.5 text-[12px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {ITEM_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label} — {k.hint}
                </option>
              ))}
            </select>
          </div>

          {/* Path (exe / folder) */}
          {(iKind === "exe" || iKind === "folder") && (
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Path
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  type="text"
                  value={iPath}
                  onChange={(e) => setIPath(e.target.value)}
                  placeholder={iKind === "exe" ? "C:/Program Files/MyGame/MyGame.exe" : "~/.ultron/control-center"}
                  className="flex-1 rounded px-2 py-1.5 text-[11.5px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                    fontFamily: "var(--font-mono)",
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={iKind === "exe" ? onPickFile : onPickFolder}
                  className="rounded px-2 py-1 text-[11.5px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  Pick
                </button>
              </div>
            </div>
          )}

          {/* Provider sub-selector (session kind) */}
          {iKind === "session" && (
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Provider
              </label>
              <select
                value={iProvider}
                onChange={(e) => setIProvider(e.target.value as SessionProvider)}
                className="mt-1 w-full rounded px-2 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  fontFamily: "var(--font-mono)",
                  outline: "none",
                }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
          )}

          {/* Cwd (session / legacy claude/codex/gemini) */}
          {(iKind === "claude" || iKind === "codex" || iKind === "gemini" || iKind === "session") && (
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Cwd
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  type="text"
                  value={iCwd}
                  onChange={(e) => setICwd(e.target.value)}
                  placeholder={itemTarget.path ?? "~/.ultron"}
                  className="flex-1 rounded px-2 py-1.5 text-[11.5px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                    fontFamily: "var(--font-mono)",
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={onPickFolder}
                  className="rounded px-2 py-1 text-[11.5px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  Pick
                </button>
              </div>
            </div>
          )}

          {/* IDE path override */}
          {iKind === "ide" && (
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Project path
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  type="text"
                  value={iPath || itemTarget.path || ""}
                  onChange={(e) => setIPath(e.target.value)}
                  placeholder={itemTarget.path ?? "~/..."}
                  className="flex-1 rounded px-2 py-1.5 text-[11.5px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                    fontFamily: "var(--font-mono)",
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={onPickFolder}
                  className="rounded px-2 py-1 text-[11.5px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  Pick
                </button>
              </div>
              <p className="mt-1 text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                Opens the directory in the project's preferred IDE. Auto-detects if none is set.
              </p>
            </div>
          )}

          {/* Args (exe only) */}
          {iKind === "exe" && (
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Args (optional, space-separated; use double-quotes for spaces)
              </label>
              <input
                type="text"
                value={iArgs}
                onChange={(e) => setIArgs(e.target.value)}
                placeholder="--windowed --no-launcher"
                className="mt-1 w-full rounded px-2 py-1.5 text-[11.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  fontFamily: "var(--font-mono)",
                  outline: "none",
                }}
              />
            </div>
          )}

          {/* Label */}
          <div>
            <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Label (optional)
            </label>
            <input
              type="text"
              value={iLabel}
              onChange={(e) => setILabel(e.target.value)}
              placeholder="e.g. Launch Game"
              className="mt-1 w-full rounded px-2 py-1.5 text-[12px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
          </div>
        </div>

        {itemError && (
          <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            {itemError}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={itemSaving}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saveDisabled}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {itemSaving ? "Saving…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
