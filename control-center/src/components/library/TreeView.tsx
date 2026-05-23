// v2.3 — Generic 3-level tree (Origin → Group → Leaf) used by Skills + Agents.
//
// Click on a node expands it; click on a leaf calls `onSelect`. A search
// query passed in `query` auto-expands every matching branch so results
// stay visible.

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "./icons";

export type TreeLeaf<T> = {
  key: string;
  label: string;
  data: T;
};

export type TreeGroup<T> = {
  name: string;
  leaves: TreeLeaf<T>[];
};

export type TreeOrigin<T> = {
  id: string;
  label: string;
  groups: TreeGroup<T>[];
};

type Props<T> = {
  origins: TreeOrigin<T>[];
  selectedKey: string | null;
  onSelect: (item: TreeLeaf<T>) => void;
  query?: string;
  /** Optional renderer for the leaf label (icon + custom badges). */
  renderLeaf?: (leaf: TreeLeaf<T>) => React.ReactNode;
};

export function TreeView<T>({
  origins,
  selectedKey,
  onSelect,
  query,
  renderLeaf,
}: Props<T>) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // When a search query is active, auto-expand every group that contains
  // at least one matching leaf so the user can see what survived the
  // filter. We never collapse explicitly-toggled nodes here — we just
  // OR the user state with the search-driven state.
  const autoExpand = useMemo(() => {
    if (!query?.trim()) return {} as Record<string, boolean>;
    const out: Record<string, boolean> = {};
    for (const o of origins) {
      if (o.groups.length > 0) {
        out[`o:${o.id}`] = true;
        for (const g of o.groups) {
          if (g.leaves.length > 0) {
            out[`g:${o.id}/${g.name}`] = true;
          }
        }
      }
    }
    return out;
  }, [origins, query]);

  // Default: top-level origins are open, groups are closed (unless
  // search expanded them). Toggle keeps the user override sticky.
  const isOpen = (key: string, defaultOpen: boolean): boolean => {
    if (expanded[key] !== undefined) return expanded[key];
    if (autoExpand[key]) return true;
    return defaultOpen;
  };

  const toggle = (key: string, defaultOpen: boolean) =>
    setExpanded((prev) => ({
      ...prev,
      [key]: !(prev[key] !== undefined ? prev[key] : autoExpand[key] || defaultOpen),
    }));

  // Reset expansion when the origins identity changes (refresh).
  useEffect(() => {
    setExpanded({});
  }, [origins]);

  if (origins.every((o) => o.groups.length === 0)) {
    return (
      <p
        className="p-3 text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Sin elementos para el filtro actual.
      </p>
    );
  }

  return (
    <ul className="p-1 text-sm">
      {origins.map((origin) => {
        const oKey = `o:${origin.id}`;
        const oOpen = isOpen(oKey, true);
        if (origin.groups.length === 0) return null;
        return (
          <li key={origin.id} className="select-none">
            <button
              type="button"
              onClick={() => toggle(oKey, true)}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] uppercase tracking-wide"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {oOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Folder size={12} />
              <span className="truncate">{origin.label}</span>
            </button>
            {oOpen && (
              <ul
                className="ml-2 border-l pl-2"
                style={{ borderColor: "var(--color-border)" }}
              >
                {origin.groups.map((group) => {
                  const gKey = `g:${origin.id}/${group.name}`;
                  const gOpen = isOpen(gKey, false);
                  return (
                    <li key={group.name}>
                      <button
                        type="button"
                        onClick={() => toggle(gKey, false)}
                        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px]"
                        style={{ color: "var(--color-text)" }}
                      >
                        {gOpen ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )}
                        <span className="truncate font-medium">
                          {group.name}
                        </span>
                        <span
                          className="ml-auto text-[10.5px]"
                          style={{
                            color: "var(--color-text-tertiary)",
                          }}
                        >
                          {group.leaves.length}
                        </span>
                      </button>
                      {gOpen && (
                        <ul
                          className="ml-3 border-l pl-2"
                          style={{ borderColor: "var(--color-border)" }}
                        >
                          {group.leaves.map((leaf) => {
                            const isActive = selectedKey === leaf.key;
                            return (
                              <li key={leaf.key}>
                                <button
                                  type="button"
                                  onClick={() => onSelect(leaf)}
                                  className="block w-full truncate rounded px-2 py-1 text-left text-[12px]"
                                  style={{
                                    background: isActive
                                      ? "var(--color-surface-4)"
                                      : "transparent",
                                    color: isActive
                                      ? "var(--color-text)"
                                      : "var(--color-text-secondary)",
                                    border: `1px solid ${
                                      isActive
                                        ? "var(--color-border-strong)"
                                        : "transparent"
                                    }`,
                                  }}
                                >
                                  {renderLeaf ? renderLeaf(leaf) : leaf.label}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default TreeView;
