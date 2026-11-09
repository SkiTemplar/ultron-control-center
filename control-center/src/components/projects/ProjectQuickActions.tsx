// ProjectQuickActions — acciones rápidas de proyecto reutilizables (V1).
//
// Fuente única para Folder / IDE / AI (spawn_session external CLI)
// + Launch all (cuando hay items lanzables).
//
// V1 redesign: la vista por-proyecto se reduce a estos botones planos + el
// Kanban board. Se eliminaron el botón Terminal (terminal embebido fuera) y los
// botones de densidad full Refactor IA / README IA.
//
// masterplan 3.6 (2026-07-02): Batch salió de esta barra por decisión del
// usuario (ganar espacio para el kanban en ProjectWorkspace). La cola de .bat
// sigue viva (list_batches/execute_batch/batches_list_queue/..., ver
// BatchDropdown) y visible en el header de la lista de proyectos (Projects.tsx
// → <BatchDropdown headerStyle />). No es el despacho de tarjetas por PTY del
// kanban, que se retiró el 2026-10-17. `showBatch` queda como escape hatch
// opt-in para una superficie futura que sí lo necesite ahí; por defecto NO se
// monta.
//
// Botón AI (contrato v2 de ULTRON Sessions, E11): con Claude abre la sesión
// del proyecto en ULTRON Sessions (`sesiones_launch`). Con Codex sigue
// lanzando la CLI externa. Nunca un terminal embebido (pty_spawn).
//
// Botón «Jugar» (2026-10-28): solo en proyectos con `game_engine` (Unreal o
// Unity, detectado por list_projects). Abre el juego sin editor vía
// `project_play_game` y enseña en la tarjeta qué modo usó (build empaquetado,
// UnrealEditor -game o player de Unity); sin build de Unity, el error del backend.
//
// Se monta en: ProjectCard, ProjectRow header, ProjectWorkspace header.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { GameLaunchResult, ProjectInfo, SessionProvider } from "../../types";
import { providerBadge } from "./utils";
import BatchDropdown, { type BatchToast } from "./BatchDropdown";
import {
  CardIconFolder,
  CardIconIde,
  CardIconPlay,
  CardIconSpark,
  CardIconTerminal,
} from "./LauncherIcons";

export type QuickActionsDensity = "compact" | "full";

export interface ProjectQuickActionsProps {
  project: ProjectInfo;
  density?: QuickActionsDensity;
  /** Optional callback fired with a batch result toast (success / failure).
   *  Sin efecto mientras showBatch sea false (default). */
  onBatchResult?: (toast: BatchToast) => void;
  /** Opt-in: monta el BatchDropdown en esta barra. Default: false (masterplan
   *  3.6 — Batch salió de la barra de acciones de proyecto). */
  showBatch?: boolean;
  /** Pinta «Lanzar todo». ProjectRow lo apaga porque tiene el suyo propio, que
   *  respeta el estado de lanzamiento de la lista. Default: true. */
  showLaunchAll?: boolean;
}

// ---------------------------------------------------------------------------
// Inline action button — compartido entre densidades
// ---------------------------------------------------------------------------

interface ActionBtnProps {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
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
        if (!disabled) onClick(e);
      }}
      title={title}
      className="flex items-center justify-center gap-1.5 rounded font-medium transition-colors disabled:opacity-40"
      style={{
        height: compact ? 32 : 36,
        padding: compact ? "0 9px" : "0 12px",
        fontSize: compact ? 12 : 13,
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
  showBatch = false,
  showLaunchAll = true,
}: ProjectQuickActionsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<string | null>(null);

  const provider: SessionProvider =
    (p.default_provider as SessionProvider | null | undefined) ?? "claude";
  const badge = providerBadge(provider);
  const compact = density === "compact";

  async function handleFolder() {
    if (!p.path) return;
    setAppError(null);
    setAppInfo(null);
    try {
      await openPath(p.path);
    } catch (e) {
      setAppError(String(e));
    }
  }

  // Mandamiento 11: nada de no-op silencioso. Cada acción de esta tarjeta
  // enseña su error en la propia tarjeta vía setAppError. Hasta el
  // 2026-09-21 solo lo hacían handleIde y handleOpenApp; las otras cuatro
  // tragaban la excepción con un `catch { /* silencioso */ }`, así que un
  // lanzador mal configurado o un ejecutable movido no daban señal alguna:
  // el botón se encendía, no pasaba nada y no había forma de saber por qué.
  async function handleIde() {
    if (!p.path) return;
    setAppError(null);
    setAppInfo(null);
    try {
      await invoke("open_project_in_ide", { path: p.path, preferredIde: p.ide ?? null });
    } catch (e) {
      setAppError(String(e));
    }
  }

  // Terminal clásica: sesión EXTERNA del CLI vía spawn_session (wt.exe).
  async function handleTerminal() {
    if (busy) return;
    setBusy("ai");
    setAppError(null);
    setAppInfo(null);
    try {
      await invoke("spawn_session", {
        provider,
        cwd: p.path ?? null,
        prompt: null,
        // Flujo interno sobre un proyecto propio: sin decisión explícita de
        // permisos manda el defecto de sessions.rs (resolve_dangerous).
        flags: {},
      });
    } catch (e) {
      setAppError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Claude → ULTRON Sessions: crea la sesión del proyecto y abre o enfoca la ventana.
  async function handleClaudeSessions() {
    if (busy) return;
    setBusy("ai");
    setAppError(null);
    setAppInfo(null);
    try {
      await invoke("sesiones_launch", { projectId: p.id });
    } catch (e) {
      setAppError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Claude abre ULTRON Sessions; Codex va por la CLI externa.
  function handleAi() {
    if (provider === "claude") void handleClaudeSessions();
    else void handleTerminal();
  }

  // "Abrir app" — lanza project.app_command en una terminal nueva (backend
  // revalida id/app_command/path). Sin comando de arranque no se pinta: un
  // botón deshabilitado en todas las tarjetas era ruido (repaso 2026-10-18);
  // el campo se rellena desde «Editar» del proyecto.
  const hasAppCommand = !!(p.app_command && p.app_command.trim());
  async function handleOpenApp() {
    if (busy || !hasAppCommand) return;
    setBusy("app");
    setAppError(null);
    setAppInfo(null);
    try {
      await invoke("project_open_app", { id: p.id });
    } catch (e) {
      setAppError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // «Jugar» — el backend elige el ejecutable a partir de la ruta del registro
  // y lanza el juego desacoplado; aquí solo se enseña el modo o el error.
  async function handlePlayGame() {
    if (busy || !p.game_engine) return;
    setBusy("play");
    setAppError(null);
    setAppInfo(null);
    try {
      const r = await invoke<GameLaunchResult>("project_play_game", { id: p.id });
      setAppInfo(r.message);
    } catch (e) {
      setAppError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleLaunchAll() {
    if (busy) return;
    setBusy("launch_all");
    setAppError(null);
    setAppInfo(null);
    try {
      await invoke("launch_all_items", { projectId: p.id });
    } catch (e) {
      setAppError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleLaunchItem(index: number) {
    if (busy) return;
    setBusy(`item_${index}`);
    setAppError(null);
    setAppInfo(null);
    try {
      await invoke("launch_item", { projectId: p.id, index });
    } catch (e) {
      setAppError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const launchableItems = (p.items ?? []).filter((it) => it.kind !== "folder");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
      {/* Acciones base */}
      <ActionBtn
        onClick={handleFolder}
        disabled={!p.path}
        title={p.path ? `Abrir ${p.path} en Explorer` : "Sin ruta configurada"}
        label="Carpeta"
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
      <span className="inline-flex items-center">
        <ActionBtn
          onClick={handleAi}
          disabled={busy === "ai"}
          title={
            provider === "claude"
              ? "Abrir en ULTRON Sessions"
              : `Iniciar sesión ${badge.label} (CLI externa)`
          }
          label={busy === "ai" ? "…" : badge.label}
          accent={badge.tint}
          Icon={CardIconSpark}
          compact={compact}
        />
      </span>
      {hasAppCommand && (
        <ActionBtn
          onClick={handleOpenApp}
          disabled={busy === "app"}
          title={`Ejecuta en una terminal nueva: ${p.app_command}`}
          label={busy === "app" ? "Lanzando…" : "Abrir app"}
          Icon={CardIconTerminal}
          compact={compact}
        />
      )}

      {p.game_engine && (
        <ActionBtn
          onClick={handlePlayGame}
          disabled={busy === "play"}
          title={
            p.game_engine === "unreal"
              ? "Abre el juego sin editor: build empaquetado si existe; si no, UnrealEditor -game -windowed"
              : "Abre el build de Windows del juego (Builds/); sin build, avisa de que hay que compilar"
          }
          label={busy === "play" ? "Abriendo…" : "Jugar"}
          Icon={CardIconPlay}
          accent="var(--color-success, #3fb950)"
          compact={compact}
        />
      )}

      {/* Ejecutar .bat — fuera por defecto (masterplan 3.6); opt-in con showBatch */}
      {showBatch && <BatchDropdown headerStyle onResult={onBatchResult} />}

      {/* Exe launch — botones por cada ejecutable configurado en el proyecto */}
      {p.executables && p.executables.length > 0 && p.executables.map((e, i) => (
        <ActionBtn
          key={`exe_${i}`}
          onClick={async () => {
            setAppError(null);
            setAppInfo(null);
            try {
              await openPath(e.path);
            } catch (err) {
              setAppError(String(err));
            }
          }}
          title={e.path}
          label={e.name || "Lanzar .exe"}
          accent="var(--color-success, #3fb950)"
          compact={compact}
        />
      ))}

      {/* Launch all — solo con dos o más items lanzables: con uno solo
          repetiría el botón del proveedor de al lado. */}
      {showLaunchAll && launchableItems.length >= 2 && (
        <ActionBtn
          onClick={handleLaunchAll}
          disabled={busy === "launch_all"}
          title={`Lanza en orden los ${launchableItems.length} items del proyecto (IDE, sesiones, ejecutables; las carpetas no cuentan). Se añaden con «+ Añadir elemento» en la vista de filas.`}
          label={busy === "launch_all" ? "Lanzando…" : `Lanzar todo (${launchableItems.length})`}
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
      {/* Error de cualquier acción — en la tarjeta, nunca alert() */}
      {appError && (
        <div
          className="truncate text-[10.5px]"
          style={{ color: "var(--color-danger)" }}
          title={appError}
        >
          {appError}
        </div>
      )}
      {/* Confirmación de «Jugar»: el juego abre fuera de ULTRON, así que se dice qué se lanzó */}
      {!appError && appInfo && (
        <div
          className="truncate text-[10.5px]"
          style={{ color: "var(--color-text-secondary)" }}
          title={appInfo}
          role="status"
        >
          {appInfo}
        </div>
      )}
    </div>
  );
}
