// ULTRON Control Center — New OpenGL Project (vcpkg) modal.
//
// Replaces the legacy `crear_proyecto.bat` script: pick a parent folder, type
// a name, choose Simple vs. Context, hit Create. The Tauri backend command
// `create_opengl_project` (commands/opengl_project.rs) writes the project on
// disk and returns the absolute path.
//
// UX choices:
//   - Parent folder defaults to the last value the user picked (persisted in
//     localStorage under "ultron.opengl.last_parent"), or a sensible
//     home-directory fallback on first use.
//   - Kind is a 2-way segmented selector so the visual weight matches the
//     primary decision; the difference is described inline.
//   - On success we toast via console + return the project path so the
//     parent (Projects.tsx) can show its own banner / register the project.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getHomeDir, joinPath } from "../../lib/paths";

const STORAGE_KEY = "ultron.opengl.last_parent";
// First-run fallback — a sensible projects tree under the user's home
// directory. Resolved dynamically (never hardcoded) so the app stays portable
// across user accounts and OSes. The user can pick anything else through the
// Browse dialog; this is purely a UX nudge so the input isn't empty on first
// paint.
async function resolveDefaultParent(): Promise<string> {
  const home = await getHomeDir();
  return joinPath(home, "projects", "OpenGL");
}

type OpenGlKind = "simple" | "context";

type CreateResult = {
  success: boolean;
  project_path: string;
  message: string;
  files_created: string[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful scaffold with the absolute project path. The
   *  caller (Projects.tsx) can use this to refresh the project list or to
   *  surface a toast — the modal itself just closes. */
  onCreated?: (projectPath: string) => void;
};

export default function NewOpenGlProjectModal({ open, onClose, onCreated }: Props) {
  const [parentDir, setParentDir] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [projectName, setProjectName] = useState("");
  const [kind, setKind] = useState<OpenGlKind>("context");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Autofocus the name input when the modal first opens — that's the only
  // field the user has to fill in for the common path.
  useEffect(() => {
    if (open) {
      setError(null);
      setProjectName("");
      // Defer focus so the modal has actually mounted into the DOM.
      const id = window.setTimeout(() => nameInputRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // First-run default for the parent folder. If nothing is persisted yet,
  // resolve a portable default under the user's home dir. This runs in an
  // effect (not the useState initialiser) because it's async, and only fills
  // when the field is still empty so it never clobbers a user-picked value.
  useEffect(() => {
    if (!open || parentDir) return;
    let cancelled = false;
    resolveDefaultParent()
      .then((p) => {
        if (!cancelled) setParentDir((cur) => (cur ? cur : p));
      })
      .catch(() => {
        /* leave empty — the Browse dialog still works */
      });
    return () => {
      cancelled = true;
    };
  }, [open, parentDir]);

  // Close on Escape — small ergonomic detail that the rest of the app
  // honours, so we match it here too.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, busy, onClose]);

  if (!open) return null;

  async function browse() {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick the parent folder for the new OpenGL project",
        defaultPath: parentDir,
      });
      if (typeof picked === "string" && picked) {
        setParentDir(picked);
      }
    } catch (e) {
      // Cancelling the dialog throws on some backends — silently swallow.
      console.debug("[opengl-modal] folder picker dismissed:", e);
    }
  }

  async function create() {
    setError(null);
    const trimmedName = projectName.trim();
    const trimmedParent = parentDir.trim();
    if (!trimmedParent) {
      setError("Parent folder cannot be empty.");
      return;
    }
    if (!trimmedName) {
      setError("Project name cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      const r = (await invoke("create_opengl_project", {
        req: {
          parent_dir: trimmedParent,
          project_name: trimmedName,
          kind,
        },
      })) as CreateResult;
      if (!r.success) {
        setError(r.message || "Backend reported failure.");
        return;
      }
      try {
        localStorage.setItem(STORAGE_KEY, trimmedParent);
      } catch {
        /* ignore quota errors */
      }
      onCreated?.(r.project_path);
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-lg p-5 shadow-xl"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="opengl-modal-title"
        aria-modal="true"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2
              id="opengl-modal-title"
              className="text-[14px] font-semibold leading-tight"
              style={{ color: "var(--color-text)" }}
            >
              New OpenGL project (vcpkg)
            </h2>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Scaffolds CMake + vcpkg manifest + GLFW/GLAD/GLM main.cpp, ready
              to open in CLion or VS Code with CMake Tools.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-2 py-0.5 text-[12px] transition-colors disabled:opacity-40"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Parent folder */}
        <div className="mb-3">
          <label
            className="text-[10px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Parent folder
          </label>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={parentDir}
              onChange={(e) => setParentDir(e.target.value)}
              placeholder="C:\\Users\\…"
              className="flex-1 rounded px-2 py-1.5 text-[11.5px]"
              style={{
                background: "var(--color-surface-0)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                fontFamily: "var(--font-mono)",
                outline: "none",
              }}
              disabled={busy}
            />
            <button
              type="button"
              onClick={browse}
              disabled={busy}
              className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
              title="Pick a folder with the native picker"
            >
              Browse…
            </button>
          </div>
          <p
            className="mt-1 text-[10.5px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            The project folder will be created INSIDE this directory.
          </p>
        </div>

        {/* Project name */}
        <div className="mb-3">
          <label
            className="text-[10px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Project name
          </label>
          <input
            ref={nameInputRef}
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="e.g. Test_5 or my_renderer"
            className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
            style={{
              background: "var(--color-surface-0)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
            }}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) {
                e.preventDefault();
                void create();
              }
            }}
          />
          <p
            className="mt-1 text-[10.5px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            vcpkg lowercases it for the manifest (e.g. <code>CamelCase</code>{" "}
            → <code>camelcase</code>). Avoid: <code>{"< > : \" / \\ | ? *"}</code>
          </p>
        </div>

        {/* Kind selector */}
        <div className="mb-4">
          <label
            className="text-[10px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Kind
          </label>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <KindCard
              active={kind === "simple"}
              onClick={() => setKind("simple")}
              title="Simple"
              hint="Hello World main.cpp. Use it to verify your toolchain compiles + links GLFW/GLAD/GLM cleanly."
              disabled={busy}
            />
            <KindCard
              active={kind === "context"}
              onClick={() => setKind("context")}
              title="Context Window"
              hint="Full GLFW window + GLAD load + render loop. Includes src/shaders and src/assets folders."
              disabled={busy}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div
            className="mb-3 rounded px-3 py-2 text-[11.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.10)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.32)",
            }}
          >
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40"
            style={{
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !projectName.trim() || !parentDir.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kind selector card
// ---------------------------------------------------------------------------

function KindCard({
  active,
  onClick,
  title,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start gap-1 rounded p-2.5 text-left transition-colors disabled:opacity-40"
      style={{
        background: active ? "var(--color-surface-3)" : "var(--color-surface-0)",
        border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border-strong)"}`,
        boxShadow: active
          ? "0 0 0 1px var(--color-accent), 0 0 6px rgba(88, 166, 255, 0.35)"
          : "none",
      }}
      aria-pressed={active}
    >
      <span
        className="text-[12px] font-medium"
        style={{ color: "var(--color-text)" }}
      >
        {title}
      </span>
      <span
        className="text-[10.5px] leading-snug"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {hint}
      </span>
    </button>
  );
}
