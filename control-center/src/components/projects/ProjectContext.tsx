// ULTRON Control Center 2.0 — Per-project Context sub-tab
//
// Two panels:
//   - CLAUDE.md editor (top): inline textarea, atomic save via Tauri command.
//   - Mem0 panel (bottom): lists memories filtered by project_id.
//     Add-memory form for tagging new notes with the project.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, RefreshCw, Save } from "./icons";

type Props = {
  projectId: string;
  projectPath: string;
};

type Mem0Memory = {
  id: string;
  memory: string;
  user_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  metadata: Record<string, unknown>;
};

export default function ProjectContext({ projectId, projectPath }: Props) {
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [memories, setMemories] = useState<Mem0Memory[]>([]);
  const [newMemory, setNewMemory] = useState("");
  const [memLoading, setMemLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMd = useCallback(async () => {
    if (!projectPath) return;
    try {
      const md = (await invoke("project_claude_md_load", {
        projectPath,
      })) as string;
      setContent(md);
      setDirty(false);
    } catch (e) {
      setError(String(e));
    }
  }, [projectPath]);

  const saveMd = useCallback(async () => {
    if (!projectPath) return;
    setSaving(true);
    try {
      await invoke("project_claude_md_save", { projectPath, content });
      setDirty(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [projectPath, content]);

  const loadMemories = useCallback(async () => {
    setMemLoading(true);
    try {
      const items = (await invoke("mem0_search", {
        query: "",
        projectId,
        limit: 50,
      })) as Mem0Memory[];
      setMemories(items);
    } catch (e) {
      setError(String(e));
    } finally {
      setMemLoading(false);
    }
  }, [projectId]);

  const addMemory = useCallback(async () => {
    if (!newMemory.trim()) return;
    try {
      await invoke("mem0_add", {
        content: newMemory.trim(),
        projectId,
        metadata: null,
      });
      setNewMemory("");
      await loadMemories();
    } catch (e) {
      setError(String(e));
    }
  }, [newMemory, projectId, loadMemories]);

  useEffect(() => {
    void loadMd();
  }, [loadMd]);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* CLAUDE.md editor */}
      <section className="flex flex-col border-b border-[var(--color-border)]">
        <div className="flex items-center justify-between bg-[var(--color-surface-1)] px-3 py-1 text-xs">
          <span className="font-semibold">CLAUDE.md</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadMd()}
              className="rounded p-1 hover:bg-[var(--color-surface-2)]"
              aria-label="Reload"
              title="Reload"
            >
              <RefreshCw size={11} />
            </button>
            {/* v2.6 (card-v26-fb-007): regenerate CLAUDE.md via Claude. */}
            <button
              onClick={async () => {
                const prompt =
                  "Lee el árbol del proyecto y los 5-10 archivos más importantes (README, package.json / Cargo.toml / pyproject.toml, lib.rs / index.ts / main.py, etc.). Después escribe un CLAUDE.md actualizado:\n\n- Resumen del proyecto en 2-3 líneas\n- Stack técnico\n- Entry points + dónde vive la lógica clave\n- Comandos comunes (build, test, run)\n- Convenciones que un agente nuevo debería saber\n\nMuéstrame el contenido propuesto ANTES de escribir el archivo. Espera mi OK.";
                try {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(prompt);
                  }
                  await invoke("spawn_session", {
                    provider: "claude",
                    cwd: projectPath,
                    prompt,
                    flags: { dangerouslySkipPermissions: false },
                  });
                } catch (e) {
                  console.warn("regenerate spawn_session failed", e);
                }
              }}
              className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[11.5px]"
              title="Spawn a Claude session in this project's cwd with a prompt to rewrite CLAUDE.md"
            >
              Regenerate with AI
            </button>
            {/* v2.6 (card-v26-fb-006): create skill from this project — Claude
                drafts a SKILL.md based on the project's tree + CLAUDE.md and
                drops it at ~/.claude/skills/project-<slug>/SKILL.md (so it
                lands under the "Project" sub-tile in Library/Skills). */}
            <button
              onClick={async () => {
                const slug = projectId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
                const prompt =
                  "Lee este proyecto (árbol, CLAUDE.md si existe, README) y crea un skill nuevo que codifique cómo trabajar aquí.\n\n" +
                  `Ubicación destino: ~/.claude/skills/project-${slug}/SKILL.md\n\n` +
                  "Estructura del skill:\n" +
                  "- Frontmatter YAML: name (kebab-case), description (cuándo activarse, no qué hace).\n" +
                  "- Cuerpo: cómo arrancar el proyecto, convenciones críticas, gotchas conocidos, comandos comunes, qué NO tocar.\n\n" +
                  "Muéstrame el contenido propuesto ANTES de escribir el archivo. Espera mi OK. Si la carpeta destino no existe créala.";
                try {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(prompt);
                  }
                  await invoke("spawn_session", {
                    provider: "claude",
                    cwd: projectPath,
                    prompt,
                    flags: { dangerouslySkipPermissions: false },
                  });
                } catch (e) {
                  console.warn("create-skill spawn_session failed", e);
                }
              }}
              className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[11.5px]"
              title="Spawn a Claude session that drafts a project-specific skill saved under ~/.claude/skills/"
            >
              Create skill from project
            </button>
            <button
              onClick={() => void saveMd()}
              disabled={!dirty || saving}
              className="flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-2 py-0.5 text-[var(--color-accent)] disabled:opacity-40"
            >
              <Save size={11} />
              Save
            </button>
          </div>
        </div>
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
          className="h-48 w-full resize-y bg-[var(--color-surface-0)] p-3 font-mono text-xs"
          placeholder="(no CLAUDE.md yet — type to create one)"
        />
      </section>

      {/* Mem0 panel */}
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between bg-[var(--color-surface-1)] px-3 py-1 text-xs">
          <span className="font-semibold">
            Mem0 memories{" "}
            <span className="text-[var(--color-text-muted)]">({memories.length})</span>
          </span>
          <button
            onClick={() => void loadMemories()}
            disabled={memLoading}
            className="rounded p-1 hover:bg-[var(--color-surface-2)]"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={11} className={memLoading ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs">
          <input
            value={newMemory}
            onChange={(e) => setNewMemory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addMemory();
            }}
            placeholder="Add a memory tagged with this project…"
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
          />
          <button
            onClick={() => void addMemory()}
            disabled={!newMemory.trim()}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          >
            <Plus size={11} />
            Add
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 text-xs">
          {memories.length === 0 ? (
            <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-center text-[var(--color-text-muted)]">
              No memories yet for this project.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {memories.map((m) => (
                <li
                  key={m.id}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2"
                >
                  <p className="whitespace-pre-wrap">{m.memory}</p>
                  {m.created_at && (
                    <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                      {m.created_at}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {error && (
        <div className="border-t border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}
    </div>
  );
}
