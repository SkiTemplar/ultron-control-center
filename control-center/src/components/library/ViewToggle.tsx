// v2.6 — 3-way "Grid / Tree / Blocks" view-mode toggle used by the Library
// sub-tabs (Skills, Agents, Rules). Persists to localStorage under a
// per-tab key so each sub-tab remembers its own preference. Default is
// "blocks" — USER asked for a Spotify-style hub on first paint.

import { useEffect, useState } from "react";
import { Boxes, Grid, ListTree } from "./icons";

export type LibraryViewMode = "grid" | "tree" | "blocks";

const MODES: { id: LibraryViewMode; label: string; Icon: typeof Grid }[] = [
  { id: "blocks", label: "Blocks", Icon: Boxes },
  { id: "grid", label: "Grid", Icon: Grid },
  { id: "tree", label: "Tree", Icon: ListTree },
];

/** Hook: read/write the view mode in localStorage under `library.<key>.view`.
 *  Defaults to "blocks" (new in v2.6). Safe against quota / disabled storage. */
export function useLibraryViewMode(
  key: string,
  fallback: LibraryViewMode = "blocks",
): [LibraryViewMode, (m: LibraryViewMode) => void] {
  const storageKey = `library.${key}.view`;
  const [mode, setMode] = useState<LibraryViewMode>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v === "grid" || v === "tree" || v === "blocks") return v;
    } catch {
      /* ignore */
    }
    return fallback;
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, mode);
    } catch {
      /* ignore */
    }
  }, [storageKey, mode]);
  return [mode, setMode];
}

type Props = {
  mode: LibraryViewMode;
  onChange: (m: LibraryViewMode) => void;
};

export function ViewToggle({ mode, onChange }: Props) {
  return (
    <div
      className="flex items-center gap-px overflow-hidden rounded"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border-strong)",
      }}
      role="radiogroup"
      aria-label="View mode"
    >
      {MODES.map(({ id, label, Icon }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium capitalize transition-colors"
            style={{
              background: active ? "var(--color-accent)" : "transparent",
              color: active
                ? "var(--color-accent-text)"
                : "var(--color-text-secondary)",
            }}
            title={`Switch to ${label} view`}
          >
            <Icon size={11} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default ViewToggle;
