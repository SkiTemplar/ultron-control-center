// ProjectQuickActions — acciones rápidas de proyecto reutilizables.
//
// Fuente única para Folder / IDE / AI (spawn) / Terminal / items[] / Launch all
// + 2 acciones IA (suggest_refactor, generate_readme via button-prompts catalog).
//
// Se monta en: ProjectCard, ProjectRow header, ProjectWorkspace header,
// y ActiveProjectCard (density="full").

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { ProjectInfo, SessionProvider } from "../../types";
import { providerBadge } from "./utils";
import { getPrompt } from "../../lib/button-prompts";
import {
  CardIconFolder,
  CardIconIde,
  CardIconSpark,
  CardIconTerminal,
} from "./LauncherIcons";

export type QuickActionsDensity = "compact" | "full";

export interface ProjectQuickActionsProps {
  project: ProjectInfo;
  density?: QuickActionsDensity;
  /** Llamado cuando se pide abrir el Terminal del workspace (sub-tab). */
  onOpenTerminal?: () => void;
}

// ---------------------------------------------------------------------------
// Inline action button — compartido entre densidades
// ---------------------------------------------------------------------------

interface ActionBtnProps {
  onClick: () => void;
  title: string;
  label: string;
  Icon?: () => React.ReactElement;
  accent?: string;
  disabled?: boolean;
  compact?: boolean;
}

function ActionBtn({
  onClick,
  title,
  label,
  Icon,
  accent,
  disabled = false,
  compact = false,
}: ActionBtnProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      title={title}
      className="flex items-center justify-center gap-1.5 rounded font-medium transition-colors disabled:opacity-40"
      style={{
        height: compact ? 28 : 34,
        padding: compact ? "0 8px" : "0 10px",
        fontSize: compact ? 11 : 12,
        background: "var(--color-surface-1)",
        color: accent ?? "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
        flex: "0 0 auto",
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = "var(--color-surface-3)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "var(--color-surface-1)";
      }}
    >
      {Icon && <Icon />}
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// ProjectQuickActions
// ---------------------------------------------------------------------------

export function ProjectQuickActions({
  project: p,
  density = "compact",
  onOpenTerminal,
}: ProjectQuickActionsProps) {
  const [busy, setBusy] = useState<string | null>(null);

  const provider: SessionProvider =
    (p.default_provider as SessionProvider | null | undefined) ?? "claude";
  const badge = providerBadge(provider);
  const compact = density === "compact";

  async function handleFolder() {
    if (!p.path) return;
    try { await openPath(p.path); } catch { /* silencioso */ }
  }

  async function handleIde() {
    if (!p.path) return;
    try { await invoke("open_project_in_ide", { path: p.path, preferredIde: p.ide ?? null }); } catch { /* silencioso */ }
  }

  async function handleAi() {
    if (busy) return;
    setBusy("ai");
    try {
      await invoke("pty_spawn", {
        projectId: p.id,
        cardId: null,
        provider,
        agent: null,
        cwd: p.path ?? ".",
        prompt: null,
      });
    } catch { /* silencioso */ } finally {
      setBusy(null);
    }
  }

  async function handleTerminal() {
    // Si existe callback para abrir el sub-tab del workspace, úsalo.
    // Si no, spawneamos con provider "claude" sin prompt como fallback.
    if (onOpenTerminal) {
      onOpenTerminal();
      return;
    }
    if (busy) return;
    setBusy("terminal");
    try {
      await invoke("spawn_session", {
        provider: "claude",
        cwd: p.path ?? null,
        prompt: null,
        flags: { dangerouslySkipPermissions: false },
      });
    } catch { /* silencioso */ } finally {
      setBusy(null);
    }
  }

  async function handleLaunchAll() {
    if (busy) return;
    setBusy("launch_all");
    try { await invoke("launch_all_items", { projectId: p.id }); } catch { /* silencioso */ } finally {
      setBusy(null);
    }
  }

  async function handleLaunchItem(index: number) {
    if (busy) return;
    setBusy(`item_${index}`);
    try { await invoke("launch_item", { projectId: p.id, index }); } catch { /* silencioso */ } finally {
      setBusy(null);
    }
  }

  async function handleAiPrompt(key: string) {
    if (busy || !p.path) return;
    setBusy(key);
    try {
      const prompt = await getPrompt(key, {
        project_path: p.path,
        project_name: p.name ?? p.id,
      });
      await invoke("spawn_session", {
        provider: "claude",
        cwd: p.path,
        prompt,
        flags: { dangerouslySkipPermissions: false },
      });
    } catch {
      // Si la key no existe en el catalog, spawnea con prompt hardcoded mínimo
      try {
        const fallbackPrompt = key === "projects.suggest_refactor"
          ? `Analiza el código en ${p.path ?? "."} y sugiere refactorizaciones prioritarias.`
          : `Genera un README.md completo para el proyecto ${p.name ?? p.id} en ${p.path ?? "."}.`;
        await invoke("spawn_session", {
          provider: "claude",
          cwd: p.path ?? null,
          prompt: fallbackPrompt,
          flags: { dangerouslySkipPermissions: false },
        });
      } catch { /* silencioso */ }
    } finally {
      setBusy(null);
    }
  }

  const launchableItems = (p.items ?? []).filter((it) => it.kind !== "folder");

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Acciones base */}
      <ActionBtn
        onClick={handleFolder}
        disabled={!p.path}
        title={p.path ? `Abrir ${p.path} en Explorer` : "Sin ruta configurada"}
        label="Folder"
        Icon={CardIconFolder}
        compact={compact}
      />
      <ActionBtn
        onClick={handleIde}
        disabled={!p.path}
        title={p.path ? `Abrir en ${p.ide ?? "IDE preferido"}` : "Sin ruta configurada"}
        label="IDE"
        Icon={CardIconIde}
        compact={compact}
      />
      <ActionBtn
        onClick={handleAi}
        disabled={busy === "ai"}
        title={`Iniciar sesión ${badge.label} en terminal CC`}
        label={busy === "ai" ? "…" : badge.label}
        accent={badge.tint}
        Icon={CardIconSpark}
        compact={compact}
      />
      <ActionBtn
        onClick={handleTerminal}
        disabled={busy === "terminal"}
        title="Abrir terminal del proyecto"
        label={busy === "terminal" ? "…" : "Terminal"}
        Icon={CardIconTerminal}
        compact={compact}
      />

      {/* Launch all — solo cuando hay items lanzables */}
      {launchableItems.length >= 1 && (
        <ActionBtn
          onClick={handleLaunchAll}
          disabled={busy === "launch_all"}
          title={`Lanzar ${launchableItems.length} item(s) del proyecto`}
          label={busy === "launch_all" ? "Lanzando…" : `Launch all (${launchableItems.length})`}
          compact={compact}
        />
      )}

      {/* Items individuales — solo en modo full */}
      {!compact && (p.items ?? []).map((it, i) => {
        const itemLabel = (it.label ?? "").trim() || it.kind;
        return (
          <ActionBtn
            key={i}
            onClick={() => void handleLaunchItem(i)}
            disabled={busy === `item_${i}`}
            title={`Lanzar: ${itemLabel}`}
            label={busy === `item_${i}` ? "…" : itemLabel}
            compact={false}
          />
        );
      })}

      {/* Acciones IA — solo en modo full */}
      {!compact && p.path && (
        <>
          <ActionBtn
            onClick={() => void handleAiPrompt("projects.suggest_refactor")}
            disabled={busy === "projects.suggest_refactor"}
            title="Solicitar sugerencias de refactor con Claude"
            label={busy === "projects.suggest_refactor" ? "…" : "Refactor IA"}
            accent="var(--color-warn)"
            compact={false}
          />
          <ActionBtn
            onClick={() => void handleAiPrompt("projects.generate_readme")}
            disabled={busy === "projects.generate_readme"}
            title="Generar README con Claude"
            label={busy === "projects.generate_readme" ? "…" : "README IA"}
            accent="var(--color-success)"
            compact={false}
          />
        </>
      )}
    </div>
  );
}
