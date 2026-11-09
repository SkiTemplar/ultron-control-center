// Diagnostics — fix history persistence helpers

import type { FixHistoryEntry } from "./types";

export const FIX_HISTORY_LS_KEY = "ultron.diagnostics.fix_history";
export const FIX_HISTORY_MAX = 50;

// El historial se guarda en localStorage como un anillo con las últimas 50
// entradas. No hay comando de backend: `appendFixHistory` llamaba a
// `notes_save_global` con argumentos erróneos, fallaba siempre y lo callaba.

export function loadFixHistory(): FixHistoryEntry[] {
  try {
    const raw = localStorage.getItem(FIX_HISTORY_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as FixHistoryEntry[];
    return [];
  } catch {
    return [];
  }
}

export function saveFixHistory(entries: FixHistoryEntry[]): void {
  try {
    localStorage.setItem(FIX_HISTORY_LS_KEY, JSON.stringify(entries.slice(0, FIX_HISTORY_MAX)));
  } catch {
    // ignore
  }
}

export function pushFixHistory(entry: FixHistoryEntry): FixHistoryEntry[] {
  const prev = loadFixHistory();
  const next = [entry, ...prev].slice(0, FIX_HISTORY_MAX);
  saveFixHistory(next);
  return next;
}
