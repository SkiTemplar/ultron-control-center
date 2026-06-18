import type { SevKey, DateFilter } from "./types";

const DISMISSED_KEY = "ultron.cc.dismissed_fingerprints.v1";

export function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}
export function saveDismissed(d: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(d)));
  } catch {}
}

const SEV_KEY = "ultron.cc.sev_filters.v1";
const DATE_KEY = "ultron.cc.date_filter.v1";

export function loadSevFilters(): Set<SevKey> {
  try {
    const raw = localStorage.getItem(SEV_KEY);
    if (!raw) return new Set(["info", "warn", "critical"]);
    return new Set(JSON.parse(raw));
  } catch {
    return new Set(["info", "warn", "critical"]);
  }
}
export function saveSevFilters(s: Set<SevKey>) {
  try { localStorage.setItem(SEV_KEY, JSON.stringify(Array.from(s))); } catch {}
}

export function loadDateFilter(): DateFilter {
  try {
    const raw = localStorage.getItem(DATE_KEY) as DateFilter | null;
    if (raw && ["1h", "24h", "7d", "all"].includes(raw)) return raw;
  } catch {}
  return "all";
}
export function saveDateFilter(d: DateFilter) {
  try { localStorage.setItem(DATE_KEY, d); } catch {}
}
