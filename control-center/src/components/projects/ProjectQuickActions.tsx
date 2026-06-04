// ProjectQuickActions — acciones rápidas de proyecto reutilizables (V1).
//
// Fuente única para Folder / IDE / AI (spawn_session external CLI) / Run Batch
// + Launch all (cuando hay items lanzables).
//
// V1 redesign: la vista por-proyecto se reduce a estos botones planos + el
// Kanban board. Se eliminaron el botón Terminal (terminal embebido fuera) y los
// botones de densidad full Refactor IA / README IA.
//
// El botón AI lanza una sesión EXTERNA del CLI vía `spawn_session` (wt.exe),
// NO un terminal embebido (pty_spawn).
//
// Se monta en: ProjectCard, ProjectRow header, ProjectWorkspace header.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { ProjectInfo, SessionProvider } from "../../types";
import { providerBadge } from "./utils";
import BatchDropdown, { type BatchToast } from "./BatchDropdown";
import {
  CardIconFolder,
  CardIconIde,
  CardIconSpark,
} from "./LauncherIcons";

export type QuickActionsDensity = "compact" | "full";

export interface ProjectQuickActionsProps {
  project: ProjectInfo;
  density?: QuickActionsDensity;
  /** Optional callback fired with a batch result toast (success / failure).
   *  When omitted, BatchDropdown swallows the result silently. */
  onBatchResult?: (toast: BatchToast) => void;
  /** Si es false, oculta el BatchDropdown. Default: true.
   *  Útil en ProjectCard/ProjectRow donde el Batch ya no pertenece al home. */
  showBatch?: boolean;
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
  onBatchResult,
  showBatch = true,
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

  // AI button → external CLI session via spawn_session (wt.exe wrapper).
  async function handleAi() {
    if (busy) return;
    setBusy("ai");
    try {
      await invoke("spawn_session", {
        provider,
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
        title={`Iniciar sesión ${badge.label} (CLI externa)`}
        label={busy === "ai" ? "…" : badge.label}
        accent={badge.tint}
        Icon={CardIconSpark}
        compact={compact}
      />

      {/* Run Batch — se oculta en ProjectCard/ProjectRow (showBatch=false) */}
      {showBatch && <BatchDropdown headerStyle onResult={onBatchResult} />}

      {/* Exe launch — botones por cada ejecutable configurado en el proyecto */}
      {p.executables && p.executables.length > 0 && p.executables.map((e, i) => (
        <ActionBtn
          key={`exe_${i}`}
          onClick={async () => {
            try { await openPath(e.path); } catch { /* silencioso */ }
          }}
          title={e.path}
          label={e.name || "Launch .exe"}
          accent="var(--color-success, #3fb950)"
          compact={compact}
        />
      ))}

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
    </div>
  );
}
