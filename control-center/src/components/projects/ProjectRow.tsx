// ProjectRow — legacy dense list row for a single project (list-view mode).
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import type { ProjectInfo, SessionProvider } from "../../types";
import { statusBadge, isBuiltinItem, builtinTooltip, customItemName, providerToKind, projectAccent, accentWash } from "./utils";
import { BuiltinIcon } from "./LauncherIcons";
import { ProjectQuickActions } from "./ProjectQuickActions";

export interface ProjectRowProps {
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
}

export function ProjectRow({
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
}: ProjectRowProps) {
  const b = statusBadge(p.status);
  const items = p.items ?? [];
  const defaultProvider: SessionProvider =
    (p.default_provider as SessionProvider | null | undefined) ?? "claude";
  const defaultKind = providerToKind(defaultProvider);
  const accent = projectAccent(p.color);
  const surface = selected ? "var(--color-surface-3)" : "var(--color-surface-2)";

  return (
    <div
      className="relative flex flex-col gap-2 overflow-hidden rounded p-3 transition-colors"
      style={{
        background: accent ? accentWash(accent, surface) : surface,
        border: `1px solid ${selected ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      {accent && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 h-full"
          style={{ width: 3, background: accent }}
        />
      )}
      <div className="flex items-baseline gap-3">
        <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
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
              <span className="text-[11.5px]" style={{ color: "var(--color-text-faint)" }}>
                · {p.language}
              </span>
            )}
          </div>
          {p.path && (
            <div
              className="mt-1 truncate text-[10.5px]"
              style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}
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
            <span className="text-[10.5px] tabular-nums" style={{ color: "var(--color-text-faint)" }}>
              {p.last_active}
            </span>
          )}
          <div className="proj-action-group flex flex-wrap items-center justify-end gap-1">
            {/* Quick actions: Folder / IDE / AI / Terminal / Launch all */}
            <ProjectQuickActions density="compact" project={p} showBatch={false} />
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
                  className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                  style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
                  title={`Fires ${launchable} item${launchable === 1 ? "" : "s"} (providers/exe only — folder chips skipped)`}
                >
                  {launchingAll
                    ? "Launching…"
                    : launchable === 0
                    ? `Launch ${p.ide}`
                    : launchable === 1
                    ? p.ide ? `Launch + ${p.ide}` : "Launch"
                    : `Launch all (${launchable}${ideHint})`}
                </button>
              );
            })()}
            {items.length === 0 && p.path && (
              <button
                type="button"
                onClick={onOpen}
                disabled={opening}
                className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
                title={`Open ${p.id} (legacy)`}
              >
                {opening ? "Opening…" : "Open"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Launcher item chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((it, i) => {
          const builtin = isBuiltinItem(it);
          const busy = busyItem === i;
          if (builtin) {
            const tip = builtinTooltip(it);
            const isDefault =
              (it.kind === "claude" || it.kind === "codex") &&
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
                  {busy ? <span className="text-[10px]">…</span> : <BuiltinIcon item={it} />}
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
          className="flex h-7 items-center rounded px-2 text-[11.5px]"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px dashed var(--color-border-strong)",
          }}
          title="Add a new launcher item to this project"
        >
          + Add item
        </button>

        {/* Inline default-provider selector */}
        <div
          className="ml-auto flex items-center gap-1 rounded px-1 py-0.5"
          style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
          title="Default provider — the chip with this provider is the main launch path"
          aria-label="Default provider selector"
        >
          <span
            className="px-1 text-[9.5px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            default
          </span>
          {(["claude", "codex"] as SessionProvider[]).map((prov) => {
            const active = prov === defaultProvider;
            return (
              <button
                key={prov}
                type="button"
                onClick={() => { if (!active) onSetDefaultProvider(prov); }}
                className="flex h-5 items-center justify-center rounded px-1.5 text-[10px] font-medium capitalize transition-colors"
                style={{
                  background: active ? "var(--color-accent)" : "transparent",
                  color: active ? "var(--color-accent-text)" : "var(--color-text-secondary)",
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
