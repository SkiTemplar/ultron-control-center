import { useEffect, useMemo, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  CreateProjectResult,
  LauncherItem,
  LauncherItemKind,
  ProjectActionResult,
  ProjectInfo,
  ProjectSubTab,
  SessionProvider,
  KanbanBoard,
  PtySessionSummary,
} from "../types";
import { useProjectsTabs } from "../state/ProjectsTabsContext";

// ---------------------------------------------------------------------------
// Launcher item rendering helpers
// ---------------------------------------------------------------------------

/** Labels written by the backwards-compat synthesiser in projects.rs
 *  (`load_items_for` / `list_projects_inner`). When an item carries one of
 *  these, the user never picked a name — we treat it as built-in and render
 *  the icon-only chip. Anything else is "custom". */
const SYNTHETIC_LABELS = new Set<string>([
  "Open folder",
  "New Claude session",
  "Claude session",
  "Codex session",
]);

/** True when the item should render as an icon-only built-in chip. We treat
 *  any item whose kind is a known launcher type AND whose label is either
 *  empty or one of the synthesised defaults as built-in. Custom items are
 *  those the user explicitly named. */
function isBuiltinItem(item: LauncherItem): boolean {
  // v15.2.37 fix: "gemini" was missing from this list, so setting
  // default_provider=gemini retargetted the chip kind correctly but the
  // row then rendered it as a custom (text-only) item — no GeminiMark.
  const knownKind =
    item.kind === "folder" ||
    item.kind === "claude" ||
    item.kind === "codex" ||
    item.kind === "gemini" ||
    item.kind === "session" ||
    item.kind === "ide" ||
    item.kind === "exe";
  if (!knownKind) return false;
  const label = (item.label ?? "").trim();
  if (!label) return true;
  return SYNTHETIC_LABELS.has(label);
}

/** Tooltip text for a built-in chip — full kind + target path. */
function builtinTooltip(item: LauncherItem): string {
  switch (item.kind) {
    case "folder":
      return `Open folder: ${item.path ?? ""}`;
    case "claude":
      return `Start Claude session in ${item.cwd ?? "cwd"}`;
    case "codex":
      return `Start Codex session in ${item.cwd ?? "cwd"}`;
    case "gemini":
      return `Start Gemini session in ${item.cwd ?? "cwd"}`;
    case "session": {
      const p = (item.provider ?? "claude").toString();
      const pName = p === "codex" ? "Codex" : p === "gemini" ? "Gemini" : "Claude";
      return `Start ${pName} session in ${item.cwd ?? "cwd"}`;
    }
    case "ide":
      return `Open in preferred IDE: ${item.path ?? "(project path)"}`;
    case "exe": {
      const args =
        item.args && item.args.length > 0 ? " " + item.args.join(" ") : "";
      return `Launch: ${item.path ?? ""}${args}`;
    }
    default:
      return item.kind;
  }
}

/** Display name for custom items — explicit label, else fall back to the
 *  basename of the path/cwd so long Windows paths stay readable. */
function customItemName(item: LauncherItem): string {
  const label = (item.label ?? "").trim();
  if (label) return label;
  const src = item.path ?? item.cwd ?? "";
  if (!src) return item.kind;
  return src.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() ?? src;
}

// ---------------------------------------------------------------------------
// Inline icons (no lucide-react dependency — keeps the bundle small).
// 14×14 stroked paths matching the Lucide visual language.
// ---------------------------------------------------------------------------

function FolderIcon() {
  // Lucide `Folder` path.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function PlayIcon() {
  // Lucide `Play` (filled triangle, matches "executable" semantic).
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

/** "C" mark for Claude — Anthropic-style orange tile, monospace cap. */
function ClaudeMark() {
  return (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] items-center justify-center rounded-[3px] text-[11px] font-bold leading-none"
      style={{
        background: "#cc785c",
        color: "#fafaf7",
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
      }}
    >
      C
    </span>
  );
}

/** Spiral mark for Codex — OpenAI greyscale tile. */
function CodexMark() {
  return (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] items-center justify-center rounded-[3px] text-[11px] font-bold leading-none"
      style={{
        background: "#10a37f",
        color: "#fafaf7",
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
      }}
    >
      X
    </span>
  );
}

/** Star mark for Gemini — Google blue tile. Used only by the default-provider
 *  selector (no `gemini` launcher kind exists in this PR; the dispatcher is
 *  untouched). */
function GeminiMark() {
  return (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] items-center justify-center rounded-[3px] text-[11px] font-bold leading-none"
      style={{
        background: "#4285f4",
        color: "#fafaf7",
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
      }}
    >
      G
    </span>
  );
}

/** Icon picked from the item for built-in chips. v15.4.19: handles the
 *  `session` kind (added in v15.4.11) by inspecting `item.provider` so the
 *  ClaudeMark / CodexMark / GeminiMark still render after the refactor.
 *  Previously a "session" chip with provider=claude rendered as PlayIcon. */
function BuiltinIcon({ item }: { item: LauncherItem }) {
  const k = item.kind;
  if (k === "folder") return <FolderIcon />;
  if (k === "claude") return <ClaudeMark />;
  if (k === "codex") return <CodexMark />;
  if (k === "gemini") return <GeminiMark />;
  if (k === "session") {
    const p = item.provider ?? "claude";
    if (p === "codex") return <CodexMark />;
    if (p === "gemini") return <GeminiMark />;
    return <ClaudeMark />;
  }
  if (k === "ide") return <FolderIcon />;
  return <PlayIcon />;
}

/** Map a default-provider value to the launcher-item `kind` it would match.
 *  The chip-highlight logic uses this to decide which item (if any) on the
 *  row should render with the "default" border + glow. */
function providerToKind(p: SessionProvider): string {
  return p; // 1:1 today; kept as a helper so future renames stay local.
}

// ---------------------------------------------------------------------------
// Status styling
// ---------------------------------------------------------------------------

// v2.5: StatusKey type alias removed — status filter was dropped per user.

function statusBadge(s: string | null): { color: string; bg: string; label: string } {
  switch (s) {
    case "active":
      return {
        color: "var(--color-success)",
        bg: "rgba(63, 185, 80, 0.08)",
        label: "active",
      };
    case "auto-detected":
      return {
        color: "var(--color-text-secondary)",
        bg: "var(--color-surface-3)",
        label: "auto",
      };
    case "manual":
      return {
        color: "var(--color-warn)",
        bg: "rgba(210, 153, 34, 0.08)",
        label: "manual",
      };
    case "archived":
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: "archived",
      };
    default:
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: s ?? "—",
      };
  }
}

// ---------------------------------------------------------------------------
// Card (new in this redesign — the home grid renders these by default)
// ---------------------------------------------------------------------------

/** Compact stats line for the new card layout. `pending` is the count of
 *  kanban cards NOT in any column whose name starts with "done"; `sessions`
 *  is the count of running PTY sessions for the project. */
type CardStats = {
  pending: number | null;
  sessions: number | null;
};

/** SVG icon set for the new card actions — kept inline for bundle size, same
 *  convention as the legacy FolderIcon/PlayIcon helpers above. */
function CardIconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function CardIconIde() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function CardIconSpark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M5.6 5.6l2.1 2.1" />
      <path d="M16.3 16.3l2.1 2.1" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
      <path d="M5.6 18.4l2.1-2.1" />
      <path d="M16.3 7.7l2.1-2.1" />
    </svg>
  );
}
function CardIconTerminal() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

/** Pretty provider name + accent for the per-card "AI" button. */
function providerBadge(p: SessionProvider): { label: string; tint: string } {
  switch (p) {
    case "codex":
      return { label: "Codex", tint: "#10a37f" };
    case "gemini":
      return { label: "Gemini", tint: "#4285f4" };
    case "claude":
    default:
      return { label: "Claude", tint: "#cc785c" };
  }
}

/** New home-grid card. Click anywhere outside the four action buttons (and
 *  the status row) opens the project workspace. Each action button is a
 *  proper click target with its own stopPropagation. */
function ProjectCard({
  p,
  stats,
  onOpenWorkspace,
  onOpenFolder,
  onOpenIde,
  onOpenAi,
  onOpenTerminal,
  onEdit,
  onDelete,
}: {
  p: ProjectInfo;
  stats: CardStats | null;
  onOpenWorkspace: () => void;
  onOpenFolder: () => void;
  onOpenIde: () => void;
  onOpenAi: () => void;
  onOpenTerminal: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const b = statusBadge(p.status);
  const provider: SessionProvider =
    (p.default_provider as SessionProvider | null | undefined) ?? "claude";
  const badge = providerBadge(provider);

  // Action button: 36px tall, icon + label, tooltip from `title`. Stops
  // propagation so the card-level click doesn't fire.
  const ActionButton = ({
    onClick,
    title,
    label,
    Icon,
    accent,
    disabled,
  }: {
    onClick: () => void;
    title: string;
    label: string;
    Icon: () => ReactElement;
    accent?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      title={title}
      className="group/btn flex h-9 flex-1 items-center justify-center gap-1.5 rounded text-[11.5px] font-medium transition-colors disabled:opacity-40"
      style={{
        background: "var(--color-surface-1)",
        color: accent ?? "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--color-surface-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--color-surface-1)";
      }}
    >
      <Icon />
      <span className="hidden md:inline">{label}</span>
    </button>
  );

  // Stop nested clicks on the badge area too so editing/removing doesn't
  // accidentally open the workspace.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenWorkspace}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenWorkspace();
        }
      }}
      className="proj-card group relative flex cursor-pointer flex-col gap-3 rounded-lg p-4 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        minHeight: 168,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--color-border-strong)";
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow =
          "0 4px 12px rgba(0,0,0,0.18)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--color-border)";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      {/* Header row: status pill + name + edit/delete (top-right) */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="rounded px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide"
              style={{ background: b.bg, color: b.color }}
            >
              {b.label}
            </span>
            {p.language && (
              <span className="text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                {p.language}
              </span>
            )}
            <span
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-px text-[9.5px] font-medium"
              style={{
                background: "var(--color-surface-1)",
                color: badge.tint,
                border: `1px solid ${badge.tint}33`,
              }}
              title={`Default AI provider: ${badge.label}`}
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: badge.tint }}
              />
              {badge.label}
            </span>
          </div>
          <div
            className="mt-2 truncate text-[14px] font-semibold leading-tight"
            style={{ color: "var(--color-text)" }}
            title={p.name ?? p.id}
          >
            {p.name ?? p.id}
          </div>
          {p.path && (
            <div
              className="mt-0.5 truncate text-[10.5px]"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-tertiary)",
              }}
              title={p.path}
            >
              {p.path}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={stop}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
            title="Edit project metadata"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.32)",
            }}
            title="Remove from registry (no files touched)"
          >
            ×
          </button>
        </div>
      </div>

      {/* Tag chips */}
      {p.tags.length > 0 && (
        <div className="flex flex-wrap gap-1" onClick={stop}>
          {p.tags.slice(0, 6).map((t) => (
            <span
              key={t}
              className="rounded px-1.5 py-px text-[9.5px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
            >
              {t}
            </span>
          ))}
          {p.tags.length > 6 && (
            <span className="text-[9.5px]" style={{ color: "var(--color-text-faint)" }}>
              +{p.tags.length - 6}
            </span>
          )}
        </div>
      )}

      {/* Action buttons — 4 prominent targets */}
      <div className="mt-auto flex items-center gap-1.5">
        <ActionButton
          onClick={onOpenFolder}
          disabled={!p.path}
          title={p.path ? `Open ${p.path} in Explorer` : "No path configured"}
          label="Folder"
          Icon={CardIconFolder}
        />
        <ActionButton
          onClick={onOpenIde}
          disabled={!p.path}
          title={
            p.path
              ? `Open in ${p.ide ?? "preferred IDE"}`
              : "No path configured"
          }
          label="IDE"
          Icon={CardIconIde}
        />
        <ActionButton
          onClick={onOpenAi}
          title={`Spawn ${badge.label} session in CC terminal`}
          label={badge.label}
          accent={badge.tint}
          Icon={CardIconSpark}
        />
        <ActionButton
          onClick={onOpenTerminal}
          title="Open project workspace on the Terminal tab"
          label="Terminal"
          Icon={CardIconTerminal}
        />
      </div>

      {/* Status row */}
      <div
        className="flex items-center justify-between border-t pt-2 text-[10.5px]"
        style={{
          borderColor: "var(--color-border)",
          color: "var(--color-text-tertiary)",
        }}
      >
        <div className="flex items-center gap-3">
          <span
            title="Pending kanban cards (everything outside Done / Complete)"
          >
            <span className="tabular-nums" style={{ color: "var(--color-text-secondary)" }}>
              {stats?.pending ?? "—"}
            </span>{" "}
            pending
          </span>
          <span title="Active terminals running for this project right now">
            <span
              className="tabular-nums"
              style={{
                color:
                  stats && stats.sessions && stats.sessions > 0
                    ? "var(--color-success)"
                    : "var(--color-text-secondary)",
              }}
            >
              {stats?.sessions ?? "—"}
            </span>{" "}
            live
          </span>
        </div>
        {p.last_active && (
          <span className="tabular-nums" style={{ color: "var(--color-text-faint)" }}>
            {p.last_active}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row (legacy list mode — kept for the "List" view toggle)
// ---------------------------------------------------------------------------

function Row({
  p,
  selected,
  onClick,
  onOpen,
  opening,
  onEdit,
  onDelete,
  onLaunchAll,
  onLaunchItem,
  onAddItem,
  onRemoveItem,
  onSetDefaultProvider,
  busyItem,
  launchingAll,
}: {
  p: ProjectInfo;
  selected: boolean;
  onClick: () => void;
  onOpen: () => void;
  opening: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onLaunchAll: () => void;
  onLaunchItem: (index: number) => void;
  onAddItem: () => void;
  onRemoveItem: (index: number) => void;
  onSetDefaultProvider: (provider: SessionProvider) => void;
  busyItem: number | null;
  launchingAll: boolean;
}) {
  const b = statusBadge(p.status);
  const items = p.items ?? [];
  // Backend normalises this on load, so the ?? is belt-and-braces for the
  // optimistic case where the UI just mutated the value before reloading.
  const defaultProvider: SessionProvider =
    (p.default_provider as SessionProvider | null | undefined) ?? "claude";
  const defaultKind = providerToKind(defaultProvider);
  return (
    <div
      className="flex flex-col gap-2 rounded p-3 transition-colors"
      style={{
        background: selected ? "var(--color-surface-3)" : "var(--color-surface-2)",
        border: `1px solid ${selected ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      <div className="flex items-baseline gap-3">
        <button
          type="button"
          onClick={onClick}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-baseline gap-2">
            <span
              className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
              style={{ background: b.bg, color: b.color, minWidth: 56, textAlign: "center" }}
            >
              {b.label}
            </span>
            <span className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
              {p.name ?? p.id}
            </span>
            {p.language && (
              <span
                className="text-[11px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                · {p.language}
              </span>
            )}
          </div>
          {p.path && (
            <div
              className="mt-1 truncate text-[10.5px]"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-tertiary)",
              }}
              title={p.path}
            >
              {p.path}
            </div>
          )}
          {p.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {p.tags.slice(0, 5).map((t) => (
                <span
                  key={t}
                  className="rounded px-1 py-px text-[9.5px]"
                  style={{
                    background: "var(--color-surface-1)",
                    color: "var(--color-text-tertiary)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </button>
        <div className="flex flex-col items-end gap-1">
          {p.last_active && (
            <span
              className="text-[10.5px] tabular-nums"
              style={{ color: "var(--color-text-faint)" }}
            >
              {p.last_active}
            </span>
          )}
          <div className="proj-action-group flex flex-wrap items-center justify-end gap-1">
            <button
              type="button"
              onClick={onEdit}
              className="rounded px-2 py-1 text-[10.5px] transition-colors"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
              title="Edit project metadata"
            >
              Edit
            </button>
            {p.path && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    // When the project has a preferred IDE set (Edit modal
                    // dropdown) we pass it through so the backend tries
                    // that CLI first; otherwise it auto-detects in the
                    // usual order (code → cursor → code-insiders → explorer).
                    await invoke("open_project_in_ide", {
                      path: p.path,
                      preferredIde: p.ide ?? null,
                    });
                  } catch (e) {
                    console.error("open in IDE failed", e);
                  }
                }}
                className="rounded px-2 py-1 text-[10.5px] transition-colors"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title={
                  p.ide
                    ? `Open ${p.path} in ${p.ide} (preferred for this project)`
                    : `Open ${p.path} in your default IDE (VS Code if installed, else file explorer)`
                }
              >
                IDE
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              className="rounded px-2 py-1 text-[10.5px] transition-colors"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-danger)",
                border: "1px solid rgba(248, 81, 73, 0.32)",
              }}
              title="Remove from registry (no files touched)"
            >
              ×
            </button>
            {(() => {
              // Folder chips are excluded from "Launch all" — the user
              // wanted Explorer NOT to open alongside the IDE. We only
              // count provider/exe chips towards the badge so the number
              // matches what actually fires. We hide the button entirely
              // when there is nothing meaningful to batch (≤1 launchable
              // AND no preferred IDE — clicking the single chip is just
              // as fast).
              const launchable = items.filter((it) => it.kind !== "folder").length;
              const hasIde = !!p.ide && !!p.path;
              if (launchable < 2 && !hasIde) return null;
              if (launchable < 1) return null;
              const ideHint = p.ide ? ` + ${p.ide}` : "";
              return (
                <button
                  type="button"
                  onClick={onLaunchAll}
                  disabled={launchingAll}
                  className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                  title={
                    `Fires ${launchable} item${launchable === 1 ? "" : "s"} (providers/exe only — folder chips skipped)` +
                    (p.ide
                      ? ` and opens the project in ${p.ide}.`
                      : ". Set a preferred IDE in Edit to also open it here.")
                  }
                >
                  {(() => {
                    if (launchingAll) return "Launching…";
                    // v15.4.12 — relabel cuando solo hay 1 launchable.
                    // "Launch all (1 + rider)" confunde — el "all"
                    // promete multi cuando hay un solo item.
                    if (launchable === 0) return `Launch ${p.ide}`;
                    if (launchable === 1) {
                      return p.ide
                        ? `Launch + ${p.ide}`
                        : `Launch`;
                    }
                    return `Launch all (${launchable}${ideHint})`;
                  })()}
                </button>
              );
            })()}
            {/* Legacy "Open" button — only when there are no launcher items
                AND the project still has a `path`. Once the user adds items
                the new model takes over completely. */}
            {items.length === 0 && p.path && (
              <button
                type="button"
                onClick={onOpen}
                disabled={opening}
                className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                title={`Open ${p.id} (legacy)`}
              >
                {opening ? "Opening…" : "Open"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Launcher items — two visual flavours sit on the same row:
            built-in (folder/claude/codex/exe with no user-set name) →
              28×28 icon-only square; the icon is the click target.
            custom (user gave it a name) → wider name-card with the user's
              label centered, surface-2 fill; whole card is the click target.
          A small × in the corner of each chip removes it. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((it, i) => {
          const builtin = isBuiltinItem(it);
          const busy = busyItem === i;
          if (builtin) {
            const tip = builtinTooltip(it);
            // True when this chip matches the project's default provider — we
            // give it an accent border + soft glow so the user spots the
            // "main launch" path at a glance. Folder/exe chips are never the
            // default (the radio is provider-only).
            const isDefault =
              (it.kind === "claude" || it.kind === "codex" || it.kind === "gemini") &&
              it.kind === defaultKind;
            const tipFull = isDefault ? `${tip} — default provider` : tip;
            return (
              <div key={i} className="relative inline-flex">
                <button
                  type="button"
                  onClick={() => onLaunchItem(i)}
                  disabled={busy}
                  className="flex h-7 w-7 items-center justify-center rounded transition-colors disabled:opacity-40"
                  style={{
                    background: "var(--color-surface-1)",
                    color: "var(--color-text)",
                    border: `1px solid ${isDefault ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                    boxShadow: isDefault
                      ? "0 0 0 1px var(--color-accent), 0 0 6px rgba(88, 166, 255, 0.35)"
                      : "none",
                  }}
                  title={tipFull}
                  aria-label={tipFull}
                >
                  {busy ? (
                    <span className="text-[10px]">…</span>
                  ) : (
                    <BuiltinIcon item={it} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveItem(i)}
                  className="absolute -right-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] leading-none opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-danger)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                  title="Remove this item"
                  aria-label="Remove item"
                >
                  ×
                </button>
              </div>
            );
          }
          // Custom item: name-only card, larger target, whole card clickable.
          const name = customItemName(it);
          const tip =
            it.path ?? it.cwd
              ? `${name} — ${it.path ?? it.cwd}${it.args && it.args.length > 0 ? " " + it.args.join(" ") : ""}`
              : name;
          return (
            <div key={i} className="relative inline-flex">
              <button
                type="button"
                onClick={() => onLaunchItem(i)}
                disabled={busy}
                className="flex h-7 items-center rounded px-3 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  maxWidth: 220,
                }}
                title={tip}
                aria-label={tip}
              >
                <span className="truncate">{busy ? "…" : name}</span>
              </button>
              <button
                type="button"
                onClick={() => onRemoveItem(i)}
                className="absolute -right-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] leading-none opacity-0 transition-opacity hover:opacity-100"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-danger)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title="Remove this item"
                aria-label="Remove item"
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAddItem}
          className="flex h-7 items-center rounded px-2 text-[11px]"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px dashed var(--color-border-strong)",
          }}
          title="Add a new launcher item to this project"
        >
          + Add item
        </button>
        {/* Inline default-provider selector — 3 segmented radio buttons,
            persisted via set_default_provider on click. We render it on the
            same row as the chips so the relationship between "selected
            default" and "highlighted chip" is visually obvious. */}
        <div
          className="ml-auto flex items-center gap-1 rounded px-1 py-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
          }}
          title="Default provider — the chip with this provider is the main launch path"
          aria-label="Default provider selector"
        >
          <span
            className="px-1 text-[9.5px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            default
          </span>
          {(["claude", "codex", "gemini"] as SessionProvider[]).map((prov) => {
            const active = prov === defaultProvider;
            return (
              <button
                key={prov}
                type="button"
                onClick={() => {
                  if (!active) onSetDefaultProvider(prov);
                }}
                className="flex h-5 items-center justify-center rounded px-1.5 text-[10px] font-medium capitalize transition-colors"
                style={{
                  background: active ? "var(--color-accent)" : "transparent",
                  color: active
                    ? "var(--color-accent-text)"
                    : "var(--color-text-secondary)",
                  border: `1px solid ${active ? "var(--color-accent)" : "transparent"}`,
                }}
                aria-pressed={active}
                title={`Set ${prov} as the default provider for this project`}
              >
                {prov}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type SortBy = "recent" | "alpha" | "type";

/** Hierarchy mode for the project grid. `flat` is the legacy "single flat
 *  list of cards". `tree` groups by the common-ancestor folder of `path` so
 *  projects under e.g. `C:/Users/USER/CARRERA/ASIGNATURAS/PROGRAM_B/*` collapse
 *  into a CARRERA / ASIGNATURAS / PROGRAM_B nested node — USER asked for this
 *  after the flat list of carrera asignatura grew unwieldy. */
type HierarchyMode = "flat" | "tree";

/** Internal tree node used by the Tree-mode render. Folders nest by path
 *  segment; leaves carry the project itself. */
type FolderNode = {
  segment: string;      // single path segment ("CARRERA", "PROGRAM_B", …) or full path for the root
  fullPath: string;     // accumulated path used for the React key + tooltip
  children: FolderNode[];
  projects: ProjectInfo[];
};

/** Split a path into normalised segments (handles \ and /). Empty segments
 *  are dropped, drive letters preserved as their own segment. */
function splitPath(p: string): string[] {
  return p
    .replace(/\\+/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build a folder tree from a list of projects, grouping by the common
 *  ancestor path. Projects without a path land under a synthetic "(no path)"
 *  root so they don't disappear when Tree mode is on. */
function buildFolderTree(items: ProjectInfo[]): FolderNode {
  const root: FolderNode = {
    segment: "",
    fullPath: "",
    children: [],
    projects: [],
  };
  for (const p of items) {
    if (!p.path) {
      // Group path-less entries under a synthetic bucket.
      let bucket = root.children.find((c) => c.segment === "(no path)");
      if (!bucket) {
        bucket = {
          segment: "(no path)",
          fullPath: "(no path)",
          children: [],
          projects: [],
        };
        root.children.push(bucket);
      }
      bucket.projects.push(p);
      continue;
    }
    const segments = splitPath(p.path);
    // Leaf segment is the project folder itself — keep it on the parent node,
    // not as its own folder node, so the card sits next to its siblings.
    const parentSegments = segments.slice(0, Math.max(0, segments.length - 1));
    let node = root;
    let acc = "";
    for (const seg of parentSegments) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = node.children.find((c) => c.segment === seg);
      if (!child) {
        child = {
          segment: seg,
          fullPath: acc,
          children: [],
          projects: [],
        };
        node.children.push(child);
      }
      node = child;
    }
    node.projects.push(p);
  }
  // Collapse linear chains (a node with one child and no projects) into a
  // single segment so deeply-nested mono-paths render as "A/B/C" instead of
  // three nested collapsibles. Mirrors the way file managers compress paths.
  collapseLinearChains(root);
  // Sort children alphabetically for predictable rendering.
  sortTree(root);
  return root;
}

function collapseLinearChains(node: FolderNode) {
  for (const child of node.children) {
    while (child.children.length === 1 && child.projects.length === 0) {
      const only = child.children[0];
      child.segment = `${child.segment}/${only.segment}`;
      child.fullPath = only.fullPath;
      child.children = only.children;
      child.projects = only.projects;
    }
    collapseLinearChains(child);
  }
}

function sortTree(node: FolderNode) {
  node.children.sort((a, b) => a.segment.localeCompare(b.segment));
  node.projects.sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id),
  );
  for (const c of node.children) sortTree(c);
}

// Parse the `last_active` string (ISO timestamp or a relative label like
// "2h ago") into a sortable number. Higher = more recent. Unknown → 0 so
// undated projects sink to the bottom.
function lastActiveScore(p: ProjectInfo): number {
  if (!p.last_active) return 0;
  const t = Date.parse(p.last_active);
  if (!Number.isNaN(t)) return t;
  // Fallback: ranks ISO-ish strings lexicographically.
  return p.last_active.charCodeAt(0);
}

// v15.4.11 — 3 kinds primarios + exe como advanced. Sesión consolida
// claude/codex/gemini detrás de un sub-selector provider.
const ITEM_KINDS: { value: LauncherItemKind; label: string; hint: string }[] = [
  { value: "folder", label: "Folder", hint: "Open the folder in Windows Explorer" },
  { value: "ide", label: "IDE", hint: "Open the project in the preferred IDE (VS Code / Cursor / Rider / CLion / etc.)" },
  { value: "session", label: "AI session", hint: "Start a new Claude / Codex / Gemini session (selector below)" },
  { value: "exe", label: "Executable (advanced)", hint: "Spawn an .exe / .lnk / .bat with optional arguments" },
];

// ---------------------------------------------------------------------------
// Folder tree view (Tree hierarchy mode)
// ---------------------------------------------------------------------------

type FolderTreeViewProps = {
  node: FolderNode;
  depth: number;
  viewMode: ViewMode;
  collapsed: Set<string>;
  onToggleFolder: (fullPath: string) => void;
  stats: Record<string, CardStats>;
  openInWorkspace: (id: string, name: string, subTab?: ProjectSubTab) => void;
  cardOpenFolder: (p: ProjectInfo) => void | Promise<void>;
  cardOpenIde: (p: ProjectInfo) => void | Promise<void>;
  cardOpenAi: (p: ProjectInfo) => void | Promise<void>;
  cardOpenTerminal: (p: ProjectInfo) => void;
  startEdit: (p: ProjectInfo) => void;
  setPendingDelete: (p: ProjectInfo) => void;
  selected: string | null;
  setSelected: (id: string) => void;
  opening: string | null;
  openLegacy: (id: string) => void | Promise<void>;
  launchAll: (id: string) => void | Promise<void>;
  launchItem: (id: string, i: number) => void | Promise<void>;
  openAddItem: (p: ProjectInfo) => void;
  removeItem: (id: string, i: number) => void | Promise<void>;
  setDefaultProvider: (id: string, prov: SessionProvider) => void | Promise<void>;
  busyItem: Record<string, number | null>;
  launchingAll: Record<string, boolean>;
};

function FolderTreeView(props: FolderTreeViewProps): ReactElement {
  const { node, depth, viewMode, collapsed, onToggleFolder, stats } = props;

  // Render this node's direct projects as cards/rows, then recurse into
  // children. Root node has no header — it just lays out children.
  const isRoot = depth === 0;
  const isCollapsed = !isRoot && collapsed.has(node.fullPath);
  const totalUnderHere = countProjects(node);

  const renderProjects = (items: ProjectInfo[]) =>
    viewMode === "cards" ? (
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
        }}
      >
        {items.map((p) => (
          <ProjectCard
            key={p.id}
            p={p}
            stats={stats[p.id] ?? null}
            onOpenWorkspace={() => props.openInWorkspace(p.id, p.name ?? p.id)}
            onOpenFolder={() => void props.cardOpenFolder(p)}
            onOpenIde={() => void props.cardOpenIde(p)}
            onOpenAi={() => void props.cardOpenAi(p)}
            onOpenTerminal={() => props.cardOpenTerminal(p)}
            onEdit={() => props.startEdit(p)}
            onDelete={() => props.setPendingDelete(p)}
          />
        ))}
      </div>
    ) : (
      <div className="space-y-2">
        {items.map((p) => (
          <Row
            key={p.id}
            p={p}
            selected={props.selected === p.id}
            onClick={() => props.setSelected(p.id)}
            onOpen={() => void props.openLegacy(p.id)}
            opening={props.opening === p.id}
            onEdit={() => props.startEdit(p)}
            onDelete={() => props.setPendingDelete(p)}
            onLaunchAll={() => void props.launchAll(p.id)}
            onLaunchItem={(i) => void props.launchItem(p.id, i)}
            onAddItem={() => props.openAddItem(p)}
            onRemoveItem={(i) => void props.removeItem(p.id, i)}
            onSetDefaultProvider={(prov) =>
              void props.setDefaultProvider(p.id, prov)
            }
            busyItem={props.busyItem[p.id] ?? null}
            launchingAll={!!props.launchingAll[p.id]}
          />
        ))}
      </div>
    );

  return (
    <div
      className={isRoot ? "space-y-4" : "space-y-2"}
      style={isRoot ? {} : { marginLeft: depth === 1 ? 0 : 12 }}
    >
      {!isRoot && (
        <button
          type="button"
          onClick={() => onToggleFolder(node.fullPath)}
          className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-[var(--color-surface-2)]"
          title={node.fullPath}
        >
          <span
            aria-hidden
            className="inline-block w-3 text-center font-mono text-[10px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {isCollapsed ? "▶" : "▼"}
          </span>
          <span
            className="font-mono text-[11.5px] font-semibold uppercase tracking-[0.04em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {node.segment}
          </span>
          <span
            className="text-[10px] tabular-nums"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {totalUnderHere}
          </span>
          <span
            className="h-px flex-1"
            style={{ background: "var(--color-border)" }}
          />
        </button>
      )}
      {!isCollapsed && (
        <div className="space-y-4">
          {node.projects.length > 0 && renderProjects(node.projects)}
          {node.children.map((child) => (
            <FolderTreeView
              key={child.fullPath || child.segment}
              {...props}
              node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function countProjects(node: FolderNode): number {
  return (
    node.projects.length +
    node.children.reduce((acc, c) => acc + countProjects(c), 0)
  );
}

type ProjectsProps = {
  onOpenProject?: (project: { id: string; name: string }) => void;
};

type ViewMode = "cards" | "list";

export function Projects({ onOpenProject }: ProjectsProps = {}) {
  // The new card grid is the default; the legacy list view stays available
  // behind a toggle for users with very dense screens or muscle memory.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem("projects.viewMode");
      return v === "list" ? "list" : "cards";
    } catch {
      return "cards";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("projects.viewMode", viewMode);
    } catch {
      /* ignore quota errors */
    }
  }, [viewMode]);

  // Subscribe to the per-project tabs context so the card action buttons can
  // deep-link into the workspace and force the right sub-tab on first mount.
  // ProjectsPane (App.tsx) wraps us in ProjectsTabsProvider so this is safe.
  const tabsCtx = useProjectsTabs();
  const openInWorkspace = (
    id: string,
    name: string,
    subTab?: ProjectSubTab,
  ) => {
    if (onOpenProject && !subTab) {
      onOpenProject({ id, name });
      return;
    }
    tabsCtx.open({ id, title: name, initialSubTab: subTab });
  };

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("recent");
  // v2.x — folder hierarchy toggle. Default Tree per user request: dropping
  // status/language/group-by filters in favour of file-structure grouping.
  const [hierarchy, setHierarchy] = useState<HierarchyMode>(() => {
    try {
      const v = localStorage.getItem("projects.hierarchy");
      return v === "flat" ? "flat" : "tree";
    } catch {
      return "tree";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("projects.hierarchy", hierarchy);
    } catch {
      /* ignore */
    }
  }, [hierarchy]);
  // Collapsed-folder state for Tree mode — keyed by fullPath. We default to
  // EXPANDED so the user sees their projects on first paint; collapsing is
  // opt-in via the chevron.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastAction, setLastAction] = useState<ProjectActionResult | null>(null);

  // Per-row busy markers — keyed by project id so multiple rows can be
  // launching concurrently without stepping on each other.
  const [busyItem, setBusyItem] = useState<Record<string, number | null>>({});
  const [launchingAll, setLaunchingAll] = useState<Record<string, boolean>>({});

  // New/edit project wizard state — same form for both flows; `editingId`
  // distinguishes create vs update.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [wName, setWName] = useState("");
  const [wPath, setWPath] = useState("");
  const [wTags, setWTags] = useState("");
  /** Preferred IDE for this project. Empty string = "no preference" (the
   *  backend stores "" and the loader normalises that back to None).
   *  Allowed values match the backend `VALID_IDES` allowlist. */
  const [wIde, setWIde] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Add-item modal state.
  const [itemTarget, setItemTarget] = useState<ProjectInfo | null>(null);
  // v15.4.11 — default `folder` (kind más común y siempre seguro).
  const [iKind, setIKind] = useState<LauncherItemKind>("folder");
  const [iPath, setIPath] = useState("");
  const [iCwd, setICwd] = useState("");
  const [iArgs, setIArgs] = useState("");
  const [iLabel, setILabel] = useState("");
  // v15.4.11 — provider sub-selector cuando iKind === "session".
  const [iProvider, setIProvider] = useState<SessionProvider>("claude");
  const [itemSaving, setItemSaving] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);

  // Per-project stats for the card status row. Loaded lazily after the main
  // projects list resolves; failures are silent (cards just show "—").
  const [stats, setStats] = useState<Record<string, CardStats>>({});

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("list_projects")) as ProjectInfo[];
      setProjects(r);
      setError(null);
      // Kick off background stats fetch — don't block the list render.
      void refreshStats(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  /** Fan-out kanban_load + pty_list per project. Tolerant of individual
   *  failures: any project whose backend call errors out is left with
   *  `null` stats so the UI degrades to "—" instead of breaking the grid. */
  async function refreshStats(list: ProjectInfo[]) {
    const next: Record<string, CardStats> = {};
    await Promise.all(
      list.map(async (p) => {
        const entry: CardStats = { pending: null, sessions: null };
        try {
          const b = (await invoke("kanban_load", {
            projectId: p.id,
          })) as KanbanBoard;
          const doneColIds = new Set(
            b.columns
              .filter((c) => /done|complete/i.test(c.name))
              .map((c) => c.id),
          );
          entry.pending = b.cards.filter(
            (c) => !doneColIds.has(c.column_id),
          ).length;
        } catch {
          /* leave null */
        }
        try {
          const s = (await invoke("pty_list", {
            projectId: p.id,
          })) as PtySessionSummary[];
          entry.sessions = s.filter((x) => x.status.kind === "running").length;
        } catch {
          /* leave null */
        }
        next[p.id] = entry;
      }),
    );
    setStats(next);
  }

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      const r = (await invoke("scan_projects")) as ProjectInfo[];
      setProjects(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function openLegacy(id: string) {
    if (onOpenProject) {
      const p = projects.find((x) => x.id === id);
      onOpenProject({ id, name: p?.name ?? id });
      return;
    }
    setOpening(id);
    setLastAction(null);
    try {
      const r = (await invoke("open_project", { id })) as ProjectActionResult;
      setLastAction(r);
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setOpening(null);
    }
  }

  /** Card action: open the project's folder in Explorer. Uses launch_item if
   *  a `folder` chip exists (preserves the user's chosen path), else falls
   *  back to spawning explorer.exe on `p.path` directly. */
  async function cardOpenFolder(p: ProjectInfo) {
    setLastAction(null);
    try {
      const items = p.items ?? [];
      const folderIdx = items.findIndex((it) => it.kind === "folder");
      if (folderIdx !== -1) {
        await invoke("launch_item", { projectId: p.id, index: folderIdx });
        return;
      }
      if (!p.path) {
        setLastAction({
          success: false,
          stdout: "",
          stderr: "No path configured for this project",
          exit_code: null,
        });
        return;
      }
      // No folder chip and no synthesis happened → just open the project
      // via the legacy openLegacy hook, which reveals the path in Explorer.
      await openLegacy(p.id);
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: `open folder: ${String(e)}`,
        exit_code: null,
      });
    }
  }

  /** Card action: open the project path in the user's preferred IDE. */
  async function cardOpenIde(p: ProjectInfo) {
    if (!p.path) return;
    try {
      await invoke("open_project_in_ide", {
        path: p.path,
        preferredIde: p.ide ?? null,
      });
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: `open IDE: ${String(e)}`,
        exit_code: null,
      });
    }
  }

  /** Card action: spawn an AI PTY session inside the Control Center and
   *  switch to the project workspace on the Terminal sub-tab. The PTY is
   *  created with the project's default_provider; cwd defaults to the
   *  project path (or "." if the project has no path). */
  async function cardOpenAi(p: ProjectInfo) {
    const provider: SessionProvider =
      (p.default_provider as SessionProvider | null | undefined) ?? "claude";
    try {
      await invoke("pty_spawn", {
        projectId: p.id,
        cardId: null,
        provider,
        agent: null,
        cwd: p.path ?? ".",
        prompt: null,
      });
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: `spawn ${provider}: ${String(e)}`,
        exit_code: null,
      });
    }
    // Refresh the live-session counter on the home grid before navigating.
    void refreshStats(projects);
    openInWorkspace(p.id, p.name ?? p.id, "terminal");
  }

  /** Card action: open the project workspace with the Terminal sub-tab
   *  pre-selected. Does NOT spawn a PTY — the user gets the empty-state
   *  prompt with "+ New session" buttons if no PTY exists yet. */
  function cardOpenTerminal(p: ProjectInfo) {
    openInWorkspace(p.id, p.name ?? p.id, "terminal");
  }

  async function launchItem(projectId: string, index: number) {
    setBusyItem((m) => ({ ...m, [projectId]: index }));
    setLastAction(null);
    try {
      await invoke("launch_item", { projectId, index });
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: `launch_item: ${String(e)}`,
        exit_code: null,
      });
    } finally {
      setBusyItem((m) => ({ ...m, [projectId]: null }));
    }
  }

  async function launchAll(projectId: string) {
    setLaunchingAll((m) => ({ ...m, [projectId]: true }));
    setLastAction(null);
    try {
      const launched = (await invoke("launch_all_items", { projectId })) as number;
      const project = projects.find((p) => p.id === projectId);
      // Folder items are skipped by the backend (see
      // launch_all_items_inner). Mirror that filter here so the
      // "X/Y launched" warning compares apples to apples — otherwise the
      // user sees a spurious "1/2 launched" for a Folder+Claude project.
      const total = (project?.items ?? []).filter((it) => it.kind !== "folder").length;
      if (launched < total) {
        setLastAction({
          success: false,
          stdout: "",
          stderr: `Only ${launched}/${total} items launched — check terminal logs`,
          exit_code: null,
        });
      }
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: `launch_all_items: ${String(e)}`,
        exit_code: null,
      });
    } finally {
      setLaunchingAll((m) => ({ ...m, [projectId]: false }));
    }
  }

  useEffect(() => {
    load();
  }, []);

  function resetWizard() {
    setWName("");
    setWPath("");
    setWTags("");
    setWIde("");
    setEditingId(null);
    setCreateError(null);
  }

  function startEdit(p: ProjectInfo) {
    setEditingId(p.id);
    setWName(p.name ?? "");
    setWPath(p.path ?? "");
    setWTags(p.tags.join(", "));
    setWIde(p.ide ?? "");
    setCreateError(null);
    setWizardOpen(true);
  }

  async function saveProject() {
    setCreating(true);
    setCreateError(null);
    try {
      const tagList = wTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      // Treat the empty string from the dropdown's "(none)" option as a
      // genuine clear intent — pass "" so the backend overwrites the field
      // (the loader will normalise it back to None on read). Passing `null`
      // would mean "leave alone" because of the Option<String> patch
      // semantics on update_project_inner.
      const idePayload = wIde === "" ? "" : wIde;
      if (editingId) {
        await invoke("update_project", {
          id: editingId,
          name: wName || null,
          path: wPath || null,
          ide: idePayload,
          language: null,
          tags: tagList,
        });
        resetWizard();
        setWizardOpen(false);
        await load();
      } else {
        const r = (await invoke("create_project", {
          name: wName,
          // Empty path is allowed — the project becomes a pure launch group.
          path: wPath,
          ide: idePayload || null,
          language: null,
          tags: tagList.length > 0 ? tagList : null,
        })) as CreateProjectResult;
        if (r.success) {
          resetWizard();
          setWizardOpen(false);
          await load();
        } else {
          setCreateError(r.message);
        }
      }
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  }

  function openAddItem(p: ProjectInfo) {
    setItemTarget(p);
    setIKind("folder");
    setIPath("");
    setICwd("");
    setIArgs("");
    setILabel("");
    setItemError(null);
  }

  async function pickItemFile() {
    try {
      const path = await openDialog({
        directory: false,
        multiple: false,
        title: "Pick an executable, shortcut or batch file",
      });
      if (typeof path === "string" && path) setIPath(path);
    } catch {}
  }

  async function pickItemFolder() {
    try {
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a folder",
      });
      if (typeof path === "string" && path) {
        if (iKind === "folder") setIPath(path);
        else setICwd(path);
      }
    } catch {}
  }

  async function saveItem() {
    if (!itemTarget) return;
    setItemSaving(true);
    setItemError(null);
    try {
      const trimmed = (s: string) => (s.trim() ? s.trim() : null);
      // Split args on whitespace, honouring simple double-quoted segments so
      // `--launch-product="league of"` and `--name "with spaces"` both work.
      const args: string[] = [];
      if (iKind === "exe" && iArgs.trim()) {
        const re = /"([^"]*)"|(\S+)/g;
        let m;
        while ((m = re.exec(iArgs)) !== null) {
          args.push(m[1] !== undefined ? m[1] : m[2]);
        }
      }
      // v15.4.11 — el shape depende del kind:
      //   folder/exe → path
      //   session    → cwd + provider
      //   ide        → path del proyecto se infiere; opcionalmente
      //                el usuario puede pasar un path explícito
      //   claude/codex/gemini (legacy) → cwd
      const needsPath = iKind === "exe" || iKind === "folder" || iKind === "ide";
      const needsCwd =
        iKind === "session" ||
        iKind === "claude" ||
        iKind === "codex" ||
        iKind === "gemini";
      const item: LauncherItem = {
        kind: iKind,
        // For 'ide' items, the path input is OPTIONAL — when left blank we
        // fall back to the parent project's path so the backend can launch
        // the IDE on the project root. Without this fallback, an empty
        // input was saved as "" and `launch_item` errored at runtime
        // (gemini review v15.4.16).
        path: needsPath
          ? trimmed(iPath) || (iKind === "ide" ? itemTarget?.path ?? null : null)
          : null,
        cwd: needsCwd ? trimmed(iCwd) : null,
        args: args.length > 0 ? args : null,
        label: trimmed(iLabel),
        provider: iKind === "session" ? iProvider : null,
      };
      await invoke("add_launcher_item", {
        projectId: itemTarget.id,
        item,
      });
      setItemTarget(null);
      await load();
    } catch (e) {
      setItemError(String(e));
    } finally {
      setItemSaving(false);
    }
  }

  async function removeItem(projectId: string, index: number) {
    try {
      await invoke("remove_launcher_item", { projectId, index });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function setDefaultProvider(
    projectId: string,
    provider: SessionProvider,
  ) {
    // Optimistic update so the highlight (and the first AI-chip icon)
    // move instantly. Mirror the backend retarget rule in
    // set_default_provider_inner: if the project does not already have
    // a chip for the new provider, mutate the first claude/codex/gemini
    // chip to the new kind. If the invoke fails we surface the error and
    // roll back via reload.
    const providers: SessionProvider[] = ["claude", "codex", "gemini"];
    setProjects((prev) =>
      prev.map((proj) => {
        if (proj.id !== projectId) return proj;
        const items = proj.items ?? null;
        let nextItems = items;
        if (items && items.length > 0) {
          const hasTarget = items.some((it) => it.kind === provider);
          if (!hasTarget) {
            let mutated = false;
            nextItems = items.map((it) => {
              if (!mutated && providers.includes(it.kind as SessionProvider)) {
                mutated = true;
                return { ...it, kind: provider };
              }
              return it;
            });
          }
        }
        return { ...proj, default_provider: provider, items: nextItems };
      }),
    );
    try {
      await invoke("set_default_provider", { projectId, provider });
    } catch (e) {
      setError(String(e));
      await load();
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await invoke("delete_project", { id: pendingDelete.id });
      setPendingDelete(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function pickWizardPath() {
    try {
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Project folder",
      });
      if (typeof path === "string" && path) setWPath(path);
    } catch {}
  }

  // v2.x — status/language/group-by filters dropped per user feedback.
  // The folder hierarchy toggle (Flat ↔ Tree) below replaces "Group by".

  // Filtered + searched
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = projects
      .filter((p) => {
        if (!q) return true;
        const hay = [
          p.id,
          p.name ?? "",
          p.path ?? "",
          p.language ?? "",
          ...(p.tags ?? []),
          ...((p.items ?? []).map(
            (it) => `${it.kind} ${it.path ?? ""} ${it.cwd ?? ""} ${it.label ?? ""}`,
          )),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });

    // Apply sort. We always copy the array (don't mutate the source) so
    // re-renders with a new sort key see fresh order.
    const sorted = [...matched];
    if (sortBy === "recent") {
      sorted.sort((a, b) => lastActiveScore(b) - lastActiveScore(a));
    } else if (sortBy === "alpha") {
      sorted.sort((a, b) =>
        (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, {
          sensitivity: "base",
        }),
      );
    } else if (sortBy === "type") {
      sorted.sort((a, b) => {
        const aType = (a.language ?? a.type_ ?? "").toLowerCase();
        const bType = (b.language ?? b.type_ ?? "").toLowerCase();
        const t = aType.localeCompare(bType);
        if (t !== 0) return t;
        return (a.name ?? a.id).localeCompare(b.name ?? b.id);
      });
    }
    return sorted;
  }, [projects, query, sortBy]);

  /** Folder tree built from `filtered` — only consumed when hierarchy === "tree". */
  const folderTree = useMemo(() => buildFolderTree(filtered), [filtered]);

  function toggleFolder(fullPath: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  }

  return (
    <div className="cc-page projects-page px-10 py-8">
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Projects</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            {projects.length} registered · {filtered.length} shown
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (wizardOpen) {
                setWizardOpen(false);
                resetWizard();
              } else {
                resetWizard();
                setWizardOpen(true);
              }
            }}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            + New project
          </button>
          <button
            type="button"
            onClick={scan}
            disabled={scanning}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Walks the filesystem looking for new projects (uv run scan_projects.py + projects.json rewrite). Slower; run it only after you have added folders on disk."
          >
            {scanning ? "Scanning…" : "Rescan disk"}
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Re-reads projects.json without touching the disk. Useful if you have edited projects in another tool."
          >
            {loading ? "Loading…" : "Refresh list"}
          </button>
        </div>
      </header>

      {/* New project wizard */}
      {wizardOpen && (
        <div
          className="mb-5 rounded p-4"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          <div className="mb-3 text-[12px] font-medium" style={{ color: "var(--color-text)" }}>
            {editingId ? `Edit project: ${editingId}` : "New project"}
          </div>
          <div className="grid grid-cols-2 gap-3">
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
                  onClick={pickWizardPath}
                  className="rounded px-2 py-1 text-[11px]"
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
                title="The IDE that opens when you press Launch all or the IDE button. Leave empty to auto-detect (VS Code → Cursor → Insiders → Explorer)."
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
            <div>
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
              onClick={saveProject}
              disabled={creating || !wName.trim()}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              {creating
                ? editingId
                  ? "Saving…"
                  : "Creating…"
                : editingId
                  ? "Save"
                  : "Create"}
            </button>
            <button
              type="button"
              onClick={() => { setWizardOpen(false); resetWizard(); }}
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
          <p
            className="mt-3 text-[11px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            After creating the project, use "+ Add item" on the row to attach
            launcher items (executables, folders, Claude/Codex sessions).
          </p>
        </div>
      )}

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Search + filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search id, name, path, language, tag, item…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
            minWidth: 280,
          }}
        />
        <label
          className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Sort
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="rounded px-2 py-1 text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
            }}
            title="Order projects by recency, name or detected language/type"
          >
            <option value="recent">Most recent</option>
            <option value="alpha">Alphabetical</option>
            <option value="type">By type</option>
          </select>
        </label>
        {/* View-mode segmented toggle — cards (default) vs legacy list */}
        <div
          className="flex items-center gap-px overflow-hidden rounded"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Layout: cards (default) or legacy dense list"
          aria-label="View mode"
        >
          {(["cards", "list"] as ViewMode[]).map((m) => {
            const active = viewMode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setViewMode(m)}
                className="px-2 py-1 text-[11px] font-medium capitalize transition-colors"
                style={{
                  background: active
                    ? "var(--color-accent)"
                    : "transparent",
                  color: active
                    ? "var(--color-accent-text)"
                    : "var(--color-text-secondary)",
                }}
                aria-pressed={active}
              >
                {m}
              </button>
            );
          })}
        </div>
      </div>

      {/* Hierarchy toggle — Flat (classic grid) vs Tree (folder breakdown).
          v2.x: replaces status/language/group-by filter rows the user found
          useless. Tree groups by the common-ancestor path of each project,
          collapsing linear chains so deeply-nested mono-paths render compactly. */}
      <div className="mb-4 flex items-center gap-1.5">
        <span
          className="w-16 text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Layout
        </span>
        {(["tree", "flat"] as HierarchyMode[]).map((m) => {
          const active = hierarchy === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setHierarchy(m)}
              className="rounded px-2 py-0.5 text-[11px] transition-colors"
              style={{
                background: active ? "var(--color-surface-3)" : "transparent",
                color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
                border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
              }}
              title={
                m === "tree"
                  ? "Group projects by their common parent folder (e.g. CARRERA/ASIGNATURAS/PROGRAM_B)"
                  : "Flat grid — show every project at the same level"
              }
            >
              {m}
            </button>
          );
        })}
      </div>

      {lastAction && !lastAction.success && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {lastAction.stderr || lastAction.stdout || `exit ${lastAction.exit_code}`}
        </div>
      )}

      {loading && projects.length === 0 && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </div>
      )}

      {!loading && filtered.length === 0 && projects.length > 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          No projects match the current filters.
        </div>
      )}

      <div className="space-y-6">
        {hierarchy === "tree" ? (
          <FolderTreeView
            node={folderTree}
            depth={0}
            viewMode={viewMode}
            collapsed={collapsedFolders}
            onToggleFolder={toggleFolder}
            stats={stats}
            openInWorkspace={openInWorkspace}
            cardOpenFolder={cardOpenFolder}
            cardOpenIde={cardOpenIde}
            cardOpenAi={cardOpenAi}
            cardOpenTerminal={cardOpenTerminal}
            startEdit={startEdit}
            setPendingDelete={setPendingDelete}
            selected={selected}
            setSelected={setSelected}
            opening={opening}
            openLegacy={openLegacy}
            launchAll={launchAll}
            launchItem={launchItem}
            openAddItem={openAddItem}
            removeItem={removeItem}
            setDefaultProvider={setDefaultProvider}
            busyItem={busyItem}
            launchingAll={launchingAll}
          />
        ) : viewMode === "cards" ? (
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            }}
          >
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                p={p}
                stats={stats[p.id] ?? null}
                onOpenWorkspace={() => openInWorkspace(p.id, p.name ?? p.id)}
                onOpenFolder={() => void cardOpenFolder(p)}
                onOpenIde={() => void cardOpenIde(p)}
                onOpenAi={() => void cardOpenAi(p)}
                onOpenTerminal={() => cardOpenTerminal(p)}
                onEdit={() => startEdit(p)}
                onDelete={() => setPendingDelete(p)}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((p) => (
              <Row
                key={p.id}
                p={p}
                selected={selected === p.id}
                onClick={() => setSelected(p.id)}
                onOpen={() => openLegacy(p.id)}
                opening={opening === p.id}
                onEdit={() => startEdit(p)}
                onDelete={() => setPendingDelete(p)}
                onLaunchAll={() => launchAll(p.id)}
                onLaunchItem={(i) => launchItem(p.id, i)}
                onAddItem={() => openAddItem(p)}
                onRemoveItem={(i) => removeItem(p.id, i)}
                onSetDefaultProvider={(prov) =>
                  setDefaultProvider(p.id, prov)
                }
                busyItem={busyItem[p.id] ?? null}
                launchingAll={!!launchingAll[p.id]}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add launcher item modal */}
      {itemTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => !itemSaving && setItemTarget(null)}
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
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Pick a kind and supply its path. The item appears as a chip on
              the project row; clicking "Launch all" fires every item in order.
            </p>
            <div className="mt-3 space-y-3">
              <div>
                <label
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
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

              {(iKind === "exe" || iKind === "folder") && (
                <div>
                  <label
                    className="text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Path
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      value={iPath}
                      onChange={(e) => setIPath(e.target.value)}
                      placeholder={
                        iKind === "exe"
                          ? "C:/Program Files/MyGame/MyGame.exe"
                          : "~/.ultron/control-center"
                      }
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
                      onClick={iKind === "exe" ? pickItemFile : pickItemFolder}
                      className="rounded px-2 py-1 text-[11px]"
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

              {/* v15.4.11 — provider sub-selector cuando kind=session */}
              {iKind === "session" && (
                <div>
                  <label
                    className="text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Provider
                  </label>
                  <select
                    value={iProvider}
                    onChange={(e) =>
                      setIProvider(e.target.value as SessionProvider)
                    }
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

              {(iKind === "claude" ||
                iKind === "codex" ||
                iKind === "gemini" ||
                iKind === "session") && (
                <div>
                  <label
                    className="text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Cwd
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      value={iCwd}
                      onChange={(e) => setICwd(e.target.value)}
                      placeholder={
                        itemTarget?.path ?? "~/.ultron"
                      }
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
                      onClick={pickItemFolder}
                      className="rounded px-2 py-1 text-[11px]"
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

              {/* v15.4.11 — IDE kind: usa el path del proyecto. El input
                  permite override pero defaultea al project.path. */}
              {iKind === "ide" && (
                <div>
                  <label
                    className="text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Project path
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      value={iPath || itemTarget?.path || ""}
                      onChange={(e) => setIPath(e.target.value)}
                      placeholder={itemTarget?.path ?? "~/..."}
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
                      onClick={pickItemFolder}
                      className="rounded px-2 py-1 text-[11px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      Pick
                    </button>
                  </div>
                  <p
                    className="mt-1 text-[10.5px]"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    Opens the directory in the project's preferred IDE
                    (configurable under Edit project). Auto-detects if none
                    is set explicitly.
                  </p>
                </div>
              )}

              {iKind === "exe" && (
                <div>
                  <label
                    className="text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Args (optional, space-separated; use double-quotes for spaces)
                  </label>
                  <input
                    type="text"
                    value={iArgs}
                    onChange={(e) => setIArgs(e.target.value)}
                    placeholder='--windowed --no-launcher'
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

              <div>
                <label
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
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
              <p
                className="mt-2 text-[11.5px]"
                style={{ color: "var(--color-danger)" }}
              >
                {itemError}
              </p>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setItemTarget(null)}
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
                onClick={saveItem}
                disabled={
                  itemSaving ||
                  ((iKind === "exe" || iKind === "folder") && !iPath.trim()) ||
                  (iKind === "ide" &&
                    !iPath.trim() &&
                    !itemTarget?.path) ||
                  ((iKind === "claude" ||
                    iKind === "codex" ||
                    iKind === "gemini" ||
                    iKind === "session") &&
                    !iCwd.trim() &&
                    !itemTarget?.path)
                }
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {itemSaving ? "Saving…" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => !deleteBusy && setPendingDelete(null)}
        >
          <div
            className="w-full max-w-[420px] rounded p-5"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[14px] font-semibold">Delete from registry</h3>
            <p
              className="mt-2 text-[12.5px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Remove <b>{pendingDelete.name ?? pendingDelete.id}</b> from
              projects.json? No files on disk are touched — only the registry
              entry is removed.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleteBusy}
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
                onClick={confirmDelete}
                disabled={deleteBusy}
                className="rounded px-3 py-1.5 text-[12px] font-medium"
                style={{
                  background: "var(--color-danger)",
                  color: "#fff",
                }}
              >
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
