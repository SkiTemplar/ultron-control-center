// ProjectWizardModal — create / edit project overlay modal.
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectExecutable, ProjectShell, SessionProvider } from "../../types";

/// Preset accent colours. Picked to stay legible both as a card tint (very
/// low alpha) and as a Claude Code accent on a black terminal.
const PROJECT_SWATCHES = [
  "#e0263c", // ULTRON red
  "#38bdf8", // sky
  "#3ddc84", // green
  "#f5a524", // amber
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
  "#94a3b8", // slate
] as const;

export interface ProjectWizardState {
  editingId: string | null;
  wName: string;
  wPath: string;
  wTags: string;
  wIde: string;
  wColor: string;
  wDefaultProvider: SessionProvider;
  wDefaultShell: ProjectShell | "";
  wParentFolderOverride: string;
  wNotes: string;
  /** FRENTE D — comando para lanzar la app del proyecto (p. ej. `npm run
   *  tauri dev`), ejecutado en una terminal nueva con cwd = wPath. */
  wAppCommand: string;
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
  setWColor: (v: string) => void;
  setWDefaultProvider: (v: SessionProvider) => void;
  setWDefaultShell: (v: ProjectShell | "") => void;
  setWParentFolderOverride: (v: string) => void;
  setWNotes: (v: string) => void;
  setWAppCommand: (v: string) => void;
  setWExecutables: (updater: (prev: ProjectExecutable[]) => ProjectExecutable[]) => void;
}

export function ProjectWizardModal({
  editingId,
  wName, wPath, wTags, wIde, wColor, wDefaultProvider, wDefaultShell,
  wParentFolderOverride, wNotes, wAppCommand, wExecutables,
  creating, createError, tagPool, wTagsParsed,
  onClose, onSave, onPickPath, onToggleTag,
  setWName, setWPath, setWTags, setWIde, setWColor,
  setWDefaultProvider, setWDefaultShell,
  setWParentFolderOverride, setWNotes, setWAppCommand, setWExecutables,
}: ProjectWizardModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={editingId ? "Editar proyecto" : "Proyecto nuevo"}
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
            {editingId ? `Editar proyecto: ${editingId}` : "Proyecto nuevo"}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
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
              Nombre
            </label>
            <input
              type="text"
              value={wName}
              onChange={(e) => setWName(e.target.value)}
              placeholder="p. ej. Mi juego"
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
              Ruta (opcional: déjala vacía para un grupo de lanzadores sin carpeta)
            </label>
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={wPath}
                onChange={(e) => setWPath(e.target.value)}
                placeholder="C:\Users\... (o déjala vacía)"
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
                title="Elegir una carpeta"
              >
                Carpeta
              </button>
            </div>
          </div>

          {/* IDE */}
          <div>
            <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              IDE (editor preferido para «Lanzar todo» y el botón IDE)
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
              <option value="">(ninguno: detección automática)</option>
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
              <option value="obsidian">Obsidian</option>
            </select>
          </div>

          {/* Tags */}
          <div className="col-span-2">
            <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Etiquetas (separadas por comas)
            </label>
            <input
              type="text"
              value={wTags}
              onChange={(e) => setWTags(e.target.value)}
              placeholder="p. ej. juegos, trabajo, personal"
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
                  existentes ·
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
                      title={active ? `Quitar «${tag}» de este proyecto` : `Añadir «${tag}» a este proyecto`}
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
              title="Proveedor que se usa al pulsar el botón de IA en la tarjeta de este proyecto."
            >
              Proveedor por defecto
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
              <option value="codex">Codex</option>
            </select>
          </div>

          {/* Default shell */}
          <div>
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Shell que se abre al lanzar una terminal sin IA en el espacio de trabajo de este proyecto."
            >
              Shell por defecto
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
              <option value="">(por defecto: ajuste global)</option>
              <option value="powershell">PowerShell</option>
              <option value="powershell-admin">PowerShell (admin)</option>
              <option value="cmd">cmd.exe</option>
              <option value="bash">Bash / Git Bash</option>
            </select>
          </div>

          {/* Accent colour */}
          <div className="col-span-2">
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Tiñe la tarjeta de este proyecto y los acentos de Claude Code al abrir una sesión aquí. Nunca cambia el fondo de la terminal."
            >
              Color (opcional: tiñe la tarjeta y el tema de Claude)
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {PROJECT_SWATCHES.map((hex) => {
                const active = wColor.toLowerCase() === hex;
                return (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => setWColor(active ? "" : hex)}
                    aria-label={`Color ${hex}`}
                    aria-pressed={active}
                    className="h-6 w-6 rounded-full"
                    style={{
                      background: hex,
                      border: active
                        ? "2px solid var(--color-text)"
                        : "1px solid var(--color-border-strong)",
                    }}
                  />
                );
              })}
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(wColor) ? wColor : "#38bdf8"}
                onChange={(e) => setWColor(e.target.value.toLowerCase())}
                aria-label="Color personalizado"
                className="h-6 w-8 cursor-pointer rounded"
                style={{ background: "transparent", border: "1px solid var(--color-border-strong)" }}
              />
              <input
                type="text"
                value={wColor}
                onChange={(e) => setWColor(e.target.value)}
                placeholder="#38bdf8"
                spellCheck={false}
                className="w-24 rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  fontFamily: "var(--font-mono)",
                  outline: "none",
                }}
              />
              {wColor && (
                <button
                  type="button"
                  onClick={() => setWColor("")}
                  className="rounded px-2 py-1 text-[11px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  Sin color
                </button>
              )}
            </div>
          </div>

          {/* Parent folder override */}
          <div className="col-span-2">
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Carpeta en la que se abren las terminales nuevas (vacía: la del proyecto)."
            >
              Carpeta para terminales (opcional)
            </label>
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={wParentFolderOverride}
                onChange={(e) => setWParentFolderOverride(e.target.value)}
                placeholder="(vacía: se usa la carpeta del proyecto)"
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
                    const picked = await openDialog({ directory: true, multiple: false, title: "Carpeta para las terminales nuevas" });
                    if (typeof picked === "string" && picked) setWParentFolderOverride(picked);
                  } catch { /* user cancelled */ }
                }}
                className="rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title="Elegir una carpeta"
              >
                Carpeta
              </button>
            </div>
          </div>

          {/* Notes */}
          <div className="col-span-2">
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Notas libres de este proyecto (no son la pestaña Notas)."
            >
              Notas (opcional)
            </label>
            <textarea
              value={wNotes}
              onChange={(e) => setWNotes(e.target.value)}
              rows={4}
              placeholder="Recordatorios del proyecto, notas del stack, pendientes que no merecen una tarjeta del kanban…"
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

          {/* App command — FRENTE D: botón "Abrir app" en la tarjeta */}
          <div className="col-span-2">
            <label
              className="text-[10px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
              title="Comando que lanza la app del proyecto (p. ej. npm run tauri dev), ejecutado en una terminal nueva con cwd = la ruta del proyecto."
            >
              Comando de arranque (opcional)
            </label>
            <input
              type="text"
              value={wAppCommand}
              onChange={(e) => setWAppCommand(e.target.value)}
              placeholder="npm run tauri dev"
              className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                fontFamily: "var(--font-mono)",
                outline: "none",
              }}
            />
          </div>

          {/* Executables editor */}
          <div className="col-span-2">
            <div className="flex items-center justify-between">
              <label
                className="text-[10px] uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
                title="Asocia accesos .exe, .lnk o .bat a este proyecto."
              >
                Ejecutables (lanzadores rápidos del proyecto)
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
                title="Añadir un ejecutable"
              >
                + Añadir ejecutable
              </button>
            </div>
            <div className="mt-1 space-y-1.5">
              {wExecutables.length === 0 && (
                <p className="text-[11.5px]" style={{ color: "var(--color-text-faint)" }}>
                  Ninguno asociado. Pulsa «+ Añadir ejecutable» para crear un lanzador rápido.
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
                    placeholder="p. ej. Lanzar juego"
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
                          title: "Elegir un ejecutable",
                          filters: [{ name: "Ejecutables", extensions: ["exe", "lnk", "bat", "cmd"] }],
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
                    title="Elegir un .exe, .lnk, .bat o .cmd"
                  >
                    Elegir
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
                    title="Quitar este ejecutable"
                    aria-label="Quitar ejecutable"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {editingId === null && wExecutables.length > 0 && (
              <p className="mt-1 text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                Guarda primero el proyecto nuevo y vuelve a abrir Editar para asociar ejecutables.
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
              ? editingId ? "Guardando…" : "Creando…"
              : editingId ? "Guardar" : "Crear"}
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
            Cancelar
          </button>
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed" style={{ color: "var(--color-text-tertiary)" }}>
          Después de crear el proyecto, usa «+ Añadir elemento» en su fila para asociar lanzadores.
        </p>
      </div>
    </div>
  );
}
