import { useEffect, useMemo, useRef, useState } from "react";
import type { Tab } from "./Sidebar";

// Lightweight in-app command palette (Ctrl+K). Surfaces tab navigation
// and a handful of quick actions. Lives outside any tab so it works
// everywhere without leaking state between tabs.

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  shortcut?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onNavigate: (t: Tab) => void;
  extraActions?: PaletteAction[];
};

const TAB_ACTIONS: { id: Tab; label: string; group: string }[] = [
  { id: "dashboard", label: "Go to Dashboard", group: "Navigate" },
  { id: "usage", label: "Go to Usage", group: "Navigate" },
  { id: "notifications", label: "Go to Notifications", group: "Navigate" },
  { id: "changelog", label: "Go to Changelog", group: "Navigate" },
  { id: "system", label: "Go to System", group: "Navigate" },
  { id: "mcps", label: "Go to MCPs", group: "Navigate" },
  { id: "skills", label: "Go to Skills", group: "Navigate" },
  { id: "memory", label: "Go to Memory", group: "Navigate" },
  { id: "sessions", label: "Go to Sessions", group: "Navigate" },
  { id: "projects", label: "Go to Projects", group: "Navigate" },
  { id: "gaming", label: "Go to Gaming", group: "Navigate" },
  { id: "settings", label: "Go to Settings", group: "Navigate" },
];

export function CommandPalette({ open, onClose, onNavigate, extraActions = [] }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Wait a tick so the input actually exists in the DOM.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const actions: PaletteAction[] = useMemo(() => {
    const tabActions: PaletteAction[] = TAB_ACTIONS.map((t) => ({
      id: `tab.${t.id}`,
      label: t.label,
      group: t.group,
      run: () => onNavigate(t.id),
    }));
    return [...tabActions, ...extraActions];
  }, [extraActions, onNavigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.hint ?? "").toLowerCase().includes(q) ||
        a.group.toLowerCase().includes(q),
    );
  }, [actions, query]);

  // Group consecutive items by group label for visual separation.
  const grouped = useMemo(() => {
    const groups: { group: string; items: PaletteAction[] }[] = [];
    for (const item of filtered) {
      const last = groups[groups.length - 1];
      if (last && last.group === item.group) last.items.push(item);
      else groups.push({ group: item.group, items: [item] });
    }
    return groups;
  }, [filtered]);

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  function runAction(a: PaletteAction) {
    onClose();
    // Defer so the close animation completes before any nav happens.
    setTimeout(() => a.run(), 0);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[cursor];
      if (a) runAction(a);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="mt-24 w-[640px] max-w-[90vw] overflow-hidden rounded shadow-2xl"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="border-b px-3 py-2"
          style={{ borderColor: "var(--color-border)" }}
        >
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKey}
            placeholder="Type a command, navigate, or search…"
            className="w-full bg-transparent px-1 py-1 text-[13px] outline-none"
            style={{ color: "var(--color-text)" }}
          />
        </div>
        <div className="max-h-[400px] overflow-auto p-2">
          {grouped.length === 0 && (
            <div
              className="px-3 py-4 text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              No matches.
            </div>
          )}
          {grouped.map((g, gi) => (
            <div key={`${g.group}-${gi}`}>
              <div
                className="mt-2 px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {g.group}
              </div>
              {g.items.map((a) => {
                const globalIdx = filtered.indexOf(a);
                const active = globalIdx === cursor;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onMouseEnter={() => setCursor(globalIdx)}
                    onClick={() => runAction(a)}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12.5px] transition-colors"
                    style={{
                      background: active ? "var(--color-surface-3)" : "transparent",
                      color: active ? "var(--color-text)" : "var(--color-text-secondary)",
                    }}
                  >
                    <span>{a.label}</span>
                    {a.shortcut && (
                      <span
                        className="text-[10.5px]"
                        style={{ color: "var(--color-text-faint)" }}
                      >
                        {a.shortcut}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div
          className="flex items-center justify-between border-t px-3 py-1.5 text-[10.5px]"
          style={{ borderColor: "var(--color-border)", color: "var(--color-text-tertiary)" }}
        >
          <span>↑↓ navigate · Enter run · Esc close</span>
          <span>Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}
