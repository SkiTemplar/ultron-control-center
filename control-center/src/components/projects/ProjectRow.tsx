// ProjectRow — legacy dense list row for a single project (list-view mode).
// Extracted from Projects.tsx (3594 L) as part of the P1 split refactor.

import { useRef, useState } from "react";
import type { ProjectInfo, SessionProvider } from "../../types";
import { statusBadge, isBuiltinItem, builtinTooltip, customItemName, providerToKind, projectAccent, accentWash } from "./utils";
import { BuiltinIcon } from "./LauncherIcons";
import { ProjectQuickActions } from "./ProjectQuickActions";
import { useDismissable } from "../useDismissable";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissable(menuRef, menuOpen, () => setMenuOpen(false));

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
      {/* flex-wrap: when the name and the actions do not fit side by side
          (narrow windows) the action group drops to its own line instead of
          squeezing the name into four lines. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <button type="button" onClick={onClick} className="min-w-[240px] flex-1 text-left">
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
              style={{ background: b.bg, color: b.color, minWidth: 56, textAlign: "center" }}
            >
              {b.label}
            </span>
            <span
              className="min-w-0 truncate text-[13px] font-medium"
              style={{ color: "var(--color-text)" }}
              title={p.name ?? p.id}
            >
              {p.name ?? p.id}
            </span>
            {p.language && (
              <span className="shrink-0 whitespace-nowrap text-[11.5px]" style={{ color: "var(--color-text-faint)" }}>
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

        <div className="ml-auto flex flex-col items-end gap-1">
          {p.last_active && (
            <span className="text-[10.5px] tabular-nums" style={{ color: "var(--color-text-faint)" }}>
              {p.last_active}
            </span>
          )}
          <div className="proj-action-group flex flex-wrap items-center justify-end gap-1">
            {/* Quick actions: Folder / IDE / AI / Terminal / Launch all */}
            <ProjectQuickActions density="compact" project={p} showBatch={false} showLaunchAll={false} />
            {(() => {
              // Un solo item lanzable ya tiene su chip y el botón del proveedor:
              // «Lanzar todo» solo aparece cuando agrupa dos o más.
              const launchable = items.filter((it) => it.kind !== "folder").length;
              if (launchable < 2) return null;
              const ideHint = p.ide ? ` + ${p.ide}` : "";
              return (
                <button
                  type="button"
                  onClick={onLaunchAll}
                  disabled={launchingAll}
                  className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                  style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
                  title={`Lanza ${launchable} elemento${launchable === 1 ? "" : "s"} (solo proveedores y ejecutables; las carpetas se omiten)`}
                >
                  {launchingAll ? "Lanzando…" : `Lanzar todo (${launchable}${ideHint})`}
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
                title={`Abrir ${p.id} (modo antiguo)`}
              >
                {opening ? "Abriendo…" : "Abrir"}
              </button>
            )}
            {/* Edit / remove live in a "···" menu: they are not launch actions
                and were competing with them for the row width. */}
            <div ref={menuRef} className="relative" onMouseLeave={() => setMenuOpen(false)}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-7 items-center rounded px-2 text-[13px] leading-none transition-colors"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Más acciones del proyecto"
                title="Más acciones del proyecto"
              >
                ···
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-20 w-48 rounded-md py-1 shadow-lg"
                  style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border-strong)" }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onEdit(); }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-3)]"
                    style={{ color: "var(--color-text)" }}
                    title="Editar los datos del proyecto"
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onDelete(); }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface-3)]"
                    style={{ color: "var(--color-danger)" }}
                    title="Quitar del registro (no toca ningún fichero)"
                  >
                    Quitar del registro
                  </button>
                </div>
              )}
            </div>
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
            const tipFull = isDefault ? `${tip} (proveedor por defecto)` : tip;
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
                  title="Quitar este elemento"
                  aria-label="Quitar elemento"
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
                title="Quitar este elemento"
                aria-label="Quitar elemento"
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
          title="Añadir un lanzador nuevo a este proyecto"
        >
          + Añadir elemento
        </button>

        {/* Inline default-provider selector */}
        <div
          className="ml-auto flex items-center gap-1 rounded px-1 py-0.5"
          style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
          title="Proveedor por defecto: el chip de este proveedor es el lanzador principal"
          aria-label="Selector del proveedor por defecto"
        >
          <span
            className="px-1 text-[9.5px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            por defecto
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
                title={`Usar ${prov} como proveedor por defecto de este proyecto`}
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
