// v2.6 — Spotify-style 3-level "Blocks" navigator for Skills / Agents / Rules.
//
// The user's request: top-level categories that, when clicked, reveal the
// skills underneath — much like Spotify's "explore" view, where clicking a
// category surfaces playlists and then the individual tracks.
//
// Levels:
//   0  →  big tiles per top-level group (origin: Global / Project / plugin
//         names like "ecc", "superpowers", …). Click drills down.
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
  /** Top-level group label — e.g. "Global", "Project", or a plugin name. */
  topGroup: string;
  /** Sub-group label — e.g. category derived from path segments. Pass
   *  `null` if the item has no sub-grouping; the BlocksView will bucket it
   *  under a "General" tile on level 1. */
  subGroup: string | null;
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
  /** Singular noun for the count badge — "skill", "agent", "rule". */
  noun: string;
};

const GENERAL_SUB = "general";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function BlocksView<T>({
  items,
  renderLeaves,
  topGroupAccent,
  emptyLabel,
  noun,
}: BlocksViewProps<T>) {
  // Drill state — `null` means level 0. When `top` is set, we're on level 1
  // (sub-category tiles). When `sub` is also set, level 2 (leaf list).
  const [top, setTop] = useState<string | null>(null);
  const [sub, setSub] = useState<string | null>(null);

  // ---- Aggregations ----

  // Level 0: count per top-level group, sorted alphabetically with "Global"
  // and "Project" pinned to the front (the user's most-used scopes).
  const topGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.topGroup, (counts.get(it.topGroup) ?? 0) + 1);
    const arr = Array.from(counts.entries()).map(([name, count]) => ({
      name,
      count,
    }));
    arr.sort((a, b) => {
      const pin = (n: string): number => {
        if (n === "Global") return 0;
        if (n === "Project") return 1;
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
    const counts = new Map<string, number>();
    for (const it of items) {
      if (it.topGroup !== top) continue;
      const key = it.subGroup ?? GENERAL_SUB;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const arr = Array.from(counts.entries()).map(([name, count]) => ({
      name,
      count,
    }));
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

  // ---- Breadcrumb (shown on level >0) ----

  const breadcrumb = (top !== null || sub !== null) && (
    <nav
      className="mb-4 flex flex-wrap items-center gap-1.5 text-[12px]"
      aria-label="Breadcrumb"
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
        title="Back to all categories"
      >
        <ArrowLeft size={11} />
        All
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
    onClick,
    accent,
    sublabel,
  }: {
    label: string;
    count: number;
    onClick: () => void;
    accent?: string | null;
    sublabel?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-[180px] flex-col justify-between rounded-xl p-5 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
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
      title={`${count} ${noun}${count === 1 ? "" : "s"} in ${label}`}
    >
      <div
        className="flex items-center gap-1.5 text-[11.5px] uppercase tracking-[0.08em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <Folder size={13} />
        {sublabel ?? "Category"}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div
          className="line-clamp-2 text-[26px] font-semibold leading-tight tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          {label}
        </div>
        <div
          className="flex shrink-0 items-baseline gap-1 rounded-md px-2.5 py-1 text-[13px] font-medium tabular-nums"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
        >
          <Sparkle size={12} />
          {count}
        </div>
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
            accent={topGroupAccent ? topGroupAccent(g.name) : null}
            onClick={() => {
              setTop(g.name);
              setSub(null);
            }}
            sublabel="Origin"
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
              label={g.name === GENERAL_SUB ? "Uncategorized" : g.name}
              count={g.count}
              onClick={() => setSub(g.name)}
              sublabel="Subcategory"
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
