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
    ((iKind === "claude" || iKind === "codex" || iKind === "session") &&
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
          Añadir elemento — {itemTarget.name ?? itemTarget.id}
        </h3>
        <p className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Elige un tipo e indica su ruta. El elemento aparece como chip en la fila del proyecto;
          «Lanzar todo» lanza todos los elementos en orden.
        </p>

        <div className="mt-3 space-y-3">
          {/* Kind selector */}
          <div>
            <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Tipo
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
                Ruta
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
                  Elegir
                </button>
              </div>
            </div>
          )}

          {/* Provider sub-selector (session kind) */}
          {iKind === "session" && (
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Proveedor
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
              </select>
            </div>
          )}

          {/* Cwd (session / legacy claude/codex) */}
          {(iKind === "claude" || iKind === "codex" || iKind === "session") && (
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Directorio de trabajo
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
                  Elegir
                </button>
              </div>
            </div>
          )}

          {/* IDE path override */}
          {iKind === "ide" && (
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Carpeta del proyecto
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
                  Elegir
                </button>
              </div>
              <p className="mt-1 text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                Abre la carpeta en el IDE preferido del proyecto. Si no hay ninguno, lo detecta solo.
              </p>
            </div>
          )}

          {/* Args (exe only) */}
          {iKind === "exe" && (
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Argumentos (opcionales, separados por espacios; comillas dobles si llevan espacios)
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
              Etiqueta (opcional)
            </label>
            <input
              type="text"
              value={iLabel}
              onChange={(e) => setILabel(e.target.value)}
              placeholder="p. ej. Lanzar juego"
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
            Cancelar
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saveDisabled}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {itemSaving ? "Guardando…" : "Añadir"}
          </button>
        </div>
      </div>
    </div>
  );
}
