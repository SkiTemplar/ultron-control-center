// Diagnostics — fix history persistence helpers

import { invoke } from "@tauri-apps/api/core";
import type { FixHistoryEntry } from "./types";

export const FIX_HISTORY_LS_KEY = "ultron.diagnostics.fix_history";
export const FIX_HISTORY_MAX = 50;

export async function appendFixHistory(entry: FixHistoryEntry): Promise<void> {
  try {
    await invoke<void>("notes_save_global", {
      name: "__fix-history-append__",
      content: JSON.stringify(entry),
    });
  } catch {
    // History is best-effort — never block the fix from running
  }
}

// Since we can't call a dedicated JSONL append command, we persist history
// in localStorage as a capped ring buffer (last 50 entries). The backend
// write above is a no-op placeholder until a real JSONL command exists.

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
