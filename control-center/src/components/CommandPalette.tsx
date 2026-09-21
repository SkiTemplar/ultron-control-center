import { useEffect, useMemo, useRef, useState } from "react";
import type { Tab } from "./Sidebar";

// Lightweight in-app command palette (Ctrl+K). Surfaces tab navigation
// and every system-wide action mar.ia exposes. Lives outside any tab so
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

// Palette enumerates every tab known to the Tab union, including the
// secondary ones the sidebar keeps under "More".
//
// En castellano desde el 2026-09-22: la app entera responde en español y la
// paleta seguia en ingles ("Go to Usage", "Go to Sessions"...), que es lo que
// uno teclea para buscarlas. El id de la accion NO cambia — es lo que guardan
// los atajos — solo la etiqueta que se lee y por la que se busca.
const TAB_ACTIONS: { id: Tab; label: string; group: string }[] = [
  { id: "usage", label: "Ir a Consumo", group: "Ir a" },
  { id: "notifications", label: "Ir a Avisos", group: "Ir a" },
  { id: "system", label: "Ir a Sistema", group: "Ir a" },
  { id: "mcps", label: "Ir a MCPs", group: "Ir a" },
  { id: "library", label: "Ir a Biblioteca", group: "Ir a" },
  { id: "skills", label: "Biblioteca · Skills", group: "Ir a" },
  { id: "agents", label: "Biblioteca · Agentes", group: "Ir a" },
  { id: "rules", label: "Biblioteca · Reglas", group: "Ir a" },
  { id: "chat", label: "Ir al Chat (relevo de proveedores)", group: "Ir a" },
  { id: "conversations", label: "Ir a Conversaciones", group: "Ir a" },
  { id: "sessions", label: "Ir a Sesiones", group: "Ir a" },
  { id: "projects", label: "Ir a Proyectos", group: "Ir a" },
  { id: "memory", label: "Ir a Memoria", group: "Ir a" },
  { id: "settings", label: "Ir a Ajustes", group: "Ir a" },
];

/**
 * Minúsculas y sin tildes. Con la paleta en castellano hace falta: nadie
 * escribe «conversación» con tilde para buscar, y el comparador de abajo va
 * carácter a carácter, así que sin esto «conversacion» no encontraba nada
 * (2026-09-22). La ñ entra en el mismo saco: en una caja de búsqueda «anadir»
 * tiene que encontrar «añadir».
 */
function sinTildes(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Tiny in-order fuzzy scorer. Returns a positive score when every char of
// `q` appears in `text` in order, with bonuses for consecutive matches
// and word-boundary starts. Negative result means "no match".
//
// Exportado para poder probarlo con las etiquetas de verdad: es lo que decide
// si escribir "cam" encuentra "Chat · abrir el panel de cambios".
export function fuzzyScore(text: string, q: string): number {
  if (!q) return 1;
  const t = sinTildes(text);
  const query = sinTildes(q);
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
    const tabActions: PaletteAction[] = TAB_ACTIONS.map((t) => ({
      id: `tab.${t.id}`,
      label: t.label,
      group: t.group,
      run: () => onNavigate(t.id),
    }));
    return [...tabActions, ...extraActions];
  }, [extraActions, onNavigate]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return actions;
    // Score each action against label + description + group + hint, keep
    // any with a non-negative composite score, then sort by score desc.
    const scored = actions
      .map((a) => {
        const labelScore = fuzzyScore(a.label, q);
        const descScore = a.description ? fuzzyScore(a.description, q) * 0.5 : -1;
        const groupScore = fuzzyScore(a.group, q) * 0.4;
        const hintScore = a.hint ? fuzzyScore(a.hint, q) * 0.3 : -1;
        const best = Math.max(labelScore, descScore, groupScore, hintScore);
        return { action: a, score: best };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((s) => s.action);
  }, [actions, query]);

  // Group consecutive items by group label for visual separation. When
  // the user has typed a query, the list is already sorted by score so
  // grouping reflects relevance order rather than the original taxonomy.
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
            placeholder="escribe una orden, o el nombre de una pantalla…"
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
              no hay nada con eso.
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
            ↑↓ moverse · Enter ejecutar · Esc cerrar · {filtered.length} orden
            {filtered.length === 1 ? "" : "es"}
          </span>
          <span>Ctrl+K</span>
        </div>
      </div>
    </div>
  );
}
