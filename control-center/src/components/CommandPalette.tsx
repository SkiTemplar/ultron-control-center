import { useEffect, useMemo, useRef, useState } from "react";
import { SECTIONS, TAB_LABELS, type Tab } from "./Sidebar";
import { useFeatures, type Features } from "../lib/features";

// Lightweight in-app command palette (Ctrl+K). Surfaces tab navigation
// and every system-wide action ULTRON exposes. Lives outside any tab so
// it works everywhere without leaking state between tabs.
//
// v15.3.7: palette expanded from ~20 entries to a full system command
// surface — maintenance commands (fetched dynamically via
// `list_maintenance_commands`), diagnostics (Doctor, Full Diagnostic,
// Pending Items, Codex adversarial review), AI spawn (Claude / Codex),
// Memory rebuild, app lifecycle (Close, Rebuild, Update). Plus a
// fuzzy scorer so users can type "skreg" → "Skill registry rebuild".

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  /** Optional second-line description, shown muted under the label. */
  description?: string;
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

type TabAction = { id: Tab; label: string; group: string };

// Navigation mirrors the sidebar: same order, same labels, same
// available/feature filters (so Finance only shows with VITE_FINANCE=1).
// Library sub-tabs follow Library; the footer entries (Notifications,
// Settings) close the group. Tabs with no sidebar entry (Changelog, Plans)
// stay reachable under "Navegar (ocultas)".
const LIBRARY_SUBTABS: Tab[] = ["skills", "agents", "rules"];
const HIDDEN_TABS: Tab[] = ["changelog", "plans"];

function buildTabActions(features: Features): TabAction[] {
  const isOn = (key?: keyof Features) => !key || features[key] !== false;
  const list: TabAction[] = [];
  for (const item of SECTIONS.flatMap((s) => s.items)) {
    if (!item.available || !isOn(item.featureKey)) continue;
    list.push({ id: item.id, label: `Ir a ${item.label}`, group: "Navegar" });
    if (item.id === "library") {
      for (const sub of LIBRARY_SUBTABS) {
        list.push({ id: sub, label: `${TAB_LABELS.library} · ${TAB_LABELS[sub]}`, group: "Navegar" });
      }
    }
  }
  if (isOn("notifications")) {
    list.push({ id: "notifications", label: `Ir a ${TAB_LABELS.notifications}`, group: "Navegar" });
  }
  list.push({ id: "settings", label: `Ir a ${TAB_LABELS.settings}`, group: "Navegar" });
  for (const id of HIDDEN_TABS) {
    list.push({ id, label: `Ir a ${TAB_LABELS[id]}`, group: "Navegar (ocultas)" });
  }
  return list;
}

// Secondary fields (description, group, hint) only match on a contiguous
// substring: a scattered subsequence over a long sentence matches almost
// any short query ("memo" in "Re-m-ov-e … sh-i-m … o-lder").
function substringScore(text: string, q: string): number {
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  const at = t.indexOf(query);
  if (at < 0) return -1;
  const wordStart = at === 0 || /[\s\-_/(]/.test(t[at - 1]);
  return query.length * 3 + (wordStart ? 3 : 0);
}

// Tiny in-order fuzzy scorer. Returns a positive score when every char of
// `q` appears in `text` in order, with bonuses for consecutive matches
// and word-boundary starts. Negative result means "no match".
function fuzzyScore(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  let ti = 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  let prevWasBoundary = true;
  while (ti < t.length && qi < query.length) {
    const tc = t[ti];
    if (tc === query[qi]) {
      score += 2 + streak; // bonus for consecutive matches
      if (prevWasBoundary) score += 3; // bonus for word-start matches
      streak += 1;
      qi += 1;
    } else {
      streak = 0;
    }
    prevWasBoundary = tc === " " || tc === "-" || tc === "_" || tc === "/";
    ti += 1;
  }
  if (qi < query.length) return -1; // incomplete match
  // Prefer shorter labels when scores are otherwise tied.
  return score - Math.floor(t.length / 40);
}

export function CommandPalette({ open, onClose, onNavigate, extraActions = [] }: Props) {
  const { features } = useFeatures();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Wait a tick so the input actually exists in the DOM.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const actions: PaletteAction[] = useMemo(() => {
    const tabActions: PaletteAction[] = buildTabActions(features).map((t) => ({
      id: `tab.${t.id}`,
      label: t.label,
      group: t.group,
      run: () => onNavigate(t.id),
    }));
    return [...tabActions, ...extraActions];
  }, [extraActions, onNavigate, features]);

  const ranked = useMemo(() => {
    const q = query.trim();
    if (!q) return actions;
    // Score each action against label + description + group + hint, keep
    // any with a non-negative composite score, then sort by score desc.
    const scored = actions
      .map((a) => {
        const labelScore = fuzzyScore(a.label, q);
        const descScore = a.description ? substringScore(a.description, q) * 0.5 : -1;
        const groupScore = substringScore(a.group, q) * 0.4;
        const hintScore = a.hint ? substringScore(a.hint, q) * 0.3 : -1;
        const best = Math.max(labelScore, descScore, groupScore, hintScore);
        return { action: a, score: best };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((s) => s.action);
  }, [actions, query]);

  // One block per group, in order of first appearance. With a query the
  // input is sorted by score, so groups are ranked by their best match and
  // a group's items stay together instead of repeating its heading.
  const grouped = useMemo(() => {
    const groups: { group: string; items: PaletteAction[] }[] = [];
    const byName = new Map<string, PaletteAction[]>();
    for (const item of ranked) {
      const items = byName.get(item.group);
      if (items) items.push(item);
      else {
        const fresh = [item];
        byName.set(item.group, fresh);
        groups.push({ group: item.group, items: fresh });
      }
    }
    return groups;
  }, [ranked]);

  // Flat list in display order: the cursor indexes into this.
  const filtered = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  // Scroll the active item into view as the user arrows through results.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>("[data-active='true']");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [cursor]);

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
        className="mt-24 w-[680px] max-w-[90vw] overflow-hidden rounded shadow-2xl"
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
            placeholder="Escribe un comando, navega o busca…"
            className="w-full bg-transparent px-1 py-1 text-[13px] outline-none"
            style={{ color: "var(--color-text)" }}
          />
        </div>
        <div ref={listRef} className="max-h-[460px] overflow-auto p-2">
          {grouped.length === 0 && (
            <div
              className="px-3 py-4 text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Sin resultados.
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
                    data-active={active ? "true" : "false"}
                    onMouseEnter={() => setCursor(globalIdx)}
                    onClick={() => runAction(a)}
                    className="flex w-full items-start justify-between gap-3 rounded px-2 py-1.5 text-left text-[12.5px] transition-colors"
                    style={{
                      background: active ? "var(--color-surface-3)" : "transparent",
                      color: active ? "var(--color-text)" : "var(--color-text-secondary)",
                    }}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{a.label}</span>
                      {a.description && (
                        <span
                          className="mt-0.5 truncate text-[11.5px]"
                          style={{ color: "var(--color-text-tertiary)" }}
                        >
                          {a.description}
                        </span>
                      )}
                    </span>
                    {a.shortcut && (
                      <span
                        className="shrink-0 text-[10.5px]"
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
          <span>
            ↑↓ moverse · Intro ejecutar · Esc cerrar · {filtered.length} comando
            {filtered.length === 1 ? "" : "s"}
          </span>
          <span>Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}
