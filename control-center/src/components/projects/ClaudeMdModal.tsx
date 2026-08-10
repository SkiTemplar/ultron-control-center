// ULTRON Control Center — Editor de CLAUDE.md por proyecto (modal).
//
// Wiring 2026-08-11 (audit 08-09 #39): project_claude_md_load/save y
// project_create_claude_md existían desde v2.9.x sin registrar ni consumir —
// pieza central del onboarding de proyecto según los comentarios del backend.
// Se abre desde la card "CLAUDE.md" de ProjectWorkspace (fila Codigo), mismo
// patrón overlay que RepoModal.
//
// Backend (commands/projects/projects.rs):
//   - project_claude_md_load({ projectPath })  -> String ("" si no existe;
//     resuelve .claude/CLAUDE.md primero, CLAUDE.md de raíz después)
//   - project_claude_md_save({ projectPath, content }) -> () (atómico tmp+rename)
//   - project_create_claude_md({ projectPath, projectName }) -> String (stub;
//     error si ya existe)

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Save, BookOpen } from "./icons";

interface ClaudeMdModalProps {
  projectPath: string;
  projectName: string;
  onClose: () => void;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unexpected error";
}

export function ClaudeMdModal({ projectPath, projectName, onClose }: ClaudeMdModalProps) {
  const [content, setContent] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const dirty = content !== original;
  const isEmpty = !loading && original === "" && content === "";

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const text = (await invoke("project_claude_md_load", { projectPath })) as string;
      setContent(text);
      setOriginal(text);
    } catch (e) {
      setMsg(`Load failed: ${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // ESC cierra (sin descartar silenciosamente: avisa si hay cambios).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !dirty) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, onClose]);

  const save = useCallback(async () => {
    setSaving(true);
    setMsg(null);
    try {
      await invoke("project_claude_md_save", { projectPath, content });
      setOriginal(content);
      setMsg("Guardado.");
    } catch (e) {
      setMsg(`Save failed: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }, [projectPath, content]);

  const createStub = useCallback(async () => {
    setCreating(true);
    setMsg(null);
    try {
      const stub = (await invoke("project_create_claude_md", {
        projectPath,
        projectName,
      })) as string;
      setContent(stub);
      setOriginal(stub);
      setMsg("Stub creado — edítalo y guarda.");
    } catch (e) {
      setMsg(`Create failed: ${errMsg(e)}`);
    } finally {
      setCreating(false);
    }
  }, [projectPath, projectName]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={() => {
        if (!dirty) onClose();
      }}
    >
      <div
        className="flex h-[80vh] w-[820px] max-w-[92vw] flex-col rounded"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex shrink-0 items-center justify-between border-b px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen size={15} />
            <span className="truncate text-[13.5px] font-semibold" style={{ color: "var(--color-text)" }}>
              CLAUDE.md — {projectName}
            </span>
            {dirty && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  border: "1px solid var(--color-border-strong)",
                  color: "var(--color-warn, #ca8a04)",
                }}
              >
                sin guardar
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving || loading}
              className="flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
            >
              <Save size={12} />
              {saving ? "Guardando…" : "Guardar"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1.5"
              style={{ color: "var(--color-text-tertiary)" }}
              title={dirty ? "Hay cambios sin guardar" : "Cerrar (Esc)"}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 p-3">
          {loading ? (
            <div className="p-4 text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              Cargando CLAUDE.md…
            </div>
          ) : isEmpty ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 text-center"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <p className="max-w-[420px] text-[12.5px]">
                Este proyecto no tiene CLAUDE.md. Es el archivo que Claude Code carga en cada
                sesión con las instrucciones del proyecto.
              </p>
              <button
                type="button"
                onClick={() => void createStub()}
                disabled={creating}
                className="rounded px-3.5 py-2 text-[12.5px] font-medium disabled:opacity-50"
                style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
              >
                {creating ? "Creando…" : "Crear stub inicial"}
              </button>
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              className="h-full w-full resize-none rounded p-3 font-mono text-[12px] leading-relaxed outline-none"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-[11px]"
          style={{ borderColor: "var(--color-border)", color: "var(--color-text-tertiary)" }}
        >
          <span>{msg ?? `${content.length} chars`}</span>
          <span>Resolución: .claude/CLAUDE.md → CLAUDE.md (raíz) · escritura atómica</span>
        </div>
      </div>
    </div>
  );
}
