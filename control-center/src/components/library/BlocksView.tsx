// v2.6 — Spotify-style 3-level "Blocks" navigator for Skills / Agents / Rules.
//
// The user's request: top-level categories that, when clicked, reveal the
// skills underneath — much like Spotify's "explore" view, where clicking a
// category surfaces playlists and then the individual tracks.
//
// Levels:
//   0  →  tiles per top-level group (origin: Global / Project / plugin
//         names like "ecc", "superpowers", …). Click drills down. Skipped
//         when the whole dataset fits on one screen (FLAT_BELOW items).
//   1  →  tiles per sub-category derived from the path segments below the
//         top-level (e.g. for the "ecc" plugin: "agent", "tooling", …).
//   2  →  flat list of leaves (skills / agents / rules). Renders via a
//         caller-provided leaf renderer so the existing card UI is reused.
//
// The component is generic over the leaf type T and stays purely presentational
// — the parent passes already-filtered items + group functions and gets
// onSelect callbacks back. Drill state lives in component state (per the
// user's preference: "no localStorage, feels cleaner") so a tab switch
// resets to level 0.

import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Folder, Sparkle } from "./icons";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type BlocksItem<T> = {
  /** Stable key used by React lists. */
  key: string;
  /** Grupo superior visible: «Global», «Proyecto» o el nombre de un plugin. */
  topGroup: string;
  /** Sub-group label — e.g. category derived from path segments. Pass
   *  `null` if the item has no sub-grouping; the BlocksView will bucket it
   *  under a "General" tile on level 1. */
  subGroup: string | null;
  /** Display name shown in the tile preview (first names of each group). */
  label?: string;
  /** Original entry — opaque to BlocksView, forwarded back via onSelect. */
  data: T;
};

type BlocksViewProps<T> = {
  items: BlocksItem<T>[];
  /** Renders the actual leaf list on level 2. Receives the items in the
   *  currently drilled-down bucket. Caller decides the card layout. */
  renderLeaves: (leaves: BlocksItem<T>[]) => ReactNode;
  /** Optional accent tint per top-level group. Defaults to a neutral surface. */
  topGroupAccent?: (group: string) => string | null;
  /** Friendly label shown when the dataset is empty. */
  emptyLabel: string;
  /** Nombre en singular para el recuento: «skill», «agente», «regla». */
  noun: string;
  /** Caption of the level-0 tiles: what the top group means for this
   *  dataset («Origen», «Evento», «Carpeta»…). Por defecto, «Origen». */
  topSublabel?: string;
};

const GENERAL_SUB = "general";
/** Below this many items the level-0 tiles cost a click for nothing: the
 *  whole list fits on one screen, so it is rendered directly. */
const FLAT_BELOW = 12;
/** Names previewed under each tile title. */
const PREVIEW_NAMES = 3;

type GroupSummary = { name: string; count: number; preview: string[] };

/** Counts items per group key and keeps the first names as a preview. */
function summarize<T>(
  items: BlocksItem<T>[],
  keyOf: (it: BlocksItem<T>) => string,
): GroupSummary[] {
  const groups = new Map<string, GroupSummary>();
  for (const it of items) {
    const name = keyOf(it);
    const g = groups.get(name) ?? { name, count: 0, preview: [] };
    const preview =
      it.label && g.preview.length < PREVIEW_NAMES ? [...g.preview, it.label] : g.preview;
    groups.set(name, { name, count: g.count + 1, preview });
  }
  return Array.from(groups.values());
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function BlocksView<T>({
  items,
  renderLeaves,
  topGroupAccent,
  emptyLabel,
  noun,
  topSublabel = "Origen",
}: BlocksViewProps<T>) {
  // Drill state — `null` means level 0. When `top` is set, we're on level 1
  // (sub-category tiles). When `sub` is also set, level 2 (leaf list).
  const [top, setTop] = useState<string | null>(null);
  const [sub, setSub] = useState<string | null>(null);

  // ---- Aggregations ----

  // Nivel 0: recuento por grupo superior, en orden alfabético con «Global»
  // y «Proyecto» fijados delante (los ámbitos más usados).
  const topGroups = useMemo(() => {
    const arr = summarize(items, (it) => it.topGroup);
    arr.sort((a, b) => {
      const pin = (n: string): number => {
        if (n === "Global") return 0;
        if (n === "Proyecto") return 1;
        return 2;
      };
      const p = pin(a.name) - pin(b.name);
      if (p !== 0) return p;
      return a.name.localeCompare(b.name);
    });
    return arr;
  }, [items]);

  // Level 1: sub-categories within the currently-drilled top group.
  const subGroups = useMemo(() => {
    if (!top) return [];
    const arr = summarize(
      items.filter((it) => it.topGroup === top),
      (it) => it.subGroup ?? GENERAL_SUB,
    );
    arr.sort((a, b) => {
      if (a.name === GENERAL_SUB) return 1;
      if (b.name === GENERAL_SUB) return -1;
      return a.name.localeCompare(b.name);
    });
    return arr;
  }, [items, top]);

  // Level 2: leaves in the currently-drilled bucket. We always render every
  // item under the top group when sub === null (level 1 "All inside this
  // group" link) OR strictly within the sub when set.
  const leaves = useMemo(() => {
    if (!top) return [];
    return items.filter((it) => {
      if (it.topGroup !== top) return false;
      if (sub === null) return true;
      const cmp = it.subGroup ?? GENERAL_SUB;
      return cmp === sub;
    });
  }, [items, top, sub]);

  // ---- Empty state ----

  if (items.length === 0) {
    return (
      <div
        className="rounded-md p-6 text-center text-[12.5px]"
        style={{
          background: "var(--color-surface-2)",
          border: "1px dashed var(--color-border-strong)",
          color: "var(--color-text-tertiary)",
        }}
      >
        {emptyLabel}
      </div>
    );
  }

  // Small dataset: no drill-down, the list itself is the view.
  if (items.length < FLAT_BELOW) return <>{renderLeaves(items)}</>;

  // ---- Breadcrumb (shown on level >0) ----

  const breadcrumb = (top !== null || sub !== null) && (
    <nav
      className="mb-4 flex flex-wrap items-center gap-1.5 text-[12px]"
      aria-label="Ruta de navegación"
    >
      <button
        type="button"
        onClick={() => {
          setTop(null);
          setSub(null);
        }}
        className="inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors"
        style={{
          background: "var(--color-surface-2)",
          color: "var(--color-text-secondary)",
          border: "1px solid var(--color-border)",
        }}
        title="Volver a todas las categorías"
      >
        <ArrowLeft size={11} />
        Todo
      </button>
      {top && (
        <>
          <span style={{ color: "var(--color-text-faint)" }}>›</span>
          <button
            type="button"
            onClick={() => setSub(null)}
            className="rounded px-2 py-0.5 transition-colors"
            style={{
              background: sub === null ? "var(--color-surface-3)" : "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {top}
          </button>
        </>
      )}
      {sub && (
        <>
          <span style={{ color: "var(--color-text-faint)" }}>›</span>
          <span
            className="rounded px-2 py-0.5"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {sub}
          </span>
        </>
      )}
    </nav>
  );

  // ---- Tile renderer ----

  const Tile = ({
    label,
    count,
    preview,
    onClick,
    accent,
    sublabel,
  }: {
    label: string;
    count: number;
    preview: string[];
    onClick: () => void;
    accent?: string | null;
    sublabel?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-24 min-w-0 flex-col justify-between rounded-xl px-4 py-3 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      style={{
        background: "var(--color-surface-2)",
        border: `1px solid ${accent ?? "var(--color-border)"}`,
        // The accent ribbon is a soft tint on the top edge — mimics
        // Spotify's category gradient without going neon.
        boxShadow: accent
          ? `inset 0 3px 0 ${accent}`
          : "inset 0 3px 0 var(--color-border)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor =
          accent ?? "var(--color-border-strong)";
        e.currentTarget.style.transform = "translateY(-3px)";
        e.currentTarget.style.boxShadow = `${
          accent ? `inset 0 3px 0 ${accent}, ` : ""
        }0 6px 20px rgba(0,0,0,0.28)`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = accent ?? "var(--color-border)";
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = accent
          ? `inset 0 3px 0 ${accent}`
          : "inset 0 3px 0 var(--color-border)";
      }}
      title={`${count} ${noun}${count === 1 ? "" : "s"} en ${label}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div
          className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <Folder size={12} />
          {sublabel ?? "Categoría"}
        </div>
        <div
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium tabular-nums"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
        >
          <Sparkle size={11} />
          {count}
        </div>
      </div>
      <div
        className="truncate text-[19px] font-semibold leading-tight tracking-tight"
        style={{ color: "var(--color-text)" }}
      >
        {label}
      </div>
      <div
        className="truncate text-[11px]"
        style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}
      >
        {preview.join(" · ")}
        {count > preview.length && preview.length > 0 ? " …" : ""}
      </div>
    </button>
  );

  // ---- Render ----

  // Level 0: top-group tiles.
  if (top === null) {
    return (
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
      >
        {topGroups.map((g) => (
          <Tile
            key={g.name}
            label={g.name}
            count={g.count}
            preview={g.preview}
            accent={topGroupAccent ? topGroupAccent(g.name) : null}
            onClick={() => {
              setTop(g.name);
              setSub(null);
            }}
            sublabel={topSublabel}
          />
        ))}
      </div>
    );
  }

  // Level 1: sub-category tiles inside the chosen top group.
  if (sub === null) {
    // Special case: only one sub-category (or only General) → skip straight
    // to the leaf list so the user isn't forced through an empty branch.
    const onlyGeneral =
      subGroups.length === 1 && subGroups[0].name === GENERAL_SUB;
    if (onlyGeneral) {
      return (
        <div>
          {breadcrumb}
          {renderLeaves(leaves)}
        </div>
      );
    }
    return (
      <div>
        {breadcrumb}
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          }}
        >
          {subGroups.map((g) => (
            <Tile
              key={g.name}
              label={g.name === GENERAL_SUB ? "Sin categoría" : g.name}
              count={g.count}
              preview={g.preview}
              onClick={() => setSub(g.name)}
              sublabel="Subcategoría"
            />
          ))}
        </div>
      </div>
    );
  }

  // Level 2: leaf list.
  return (
    <div>
      {breadcrumb}
      {leaves.length === 0 ? (
        <p
          className="text-xs"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {emptyLabel}
        </p>
      ) : (
        renderLeaves(leaves)
      )}
    </div>
  );
}

export default BlocksView;
