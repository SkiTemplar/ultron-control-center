import type { SevKey, DateFilter } from "./types";
import { parseDismissed, serializeDismissed, type Dismissed } from "./dismissed";

// v2: {huella: hiddenAt}. La v1 era una lista de huellas sin fecha que mezclaba
// lo ocultado con el ojo y lo ya borrado del disco (Delete / Clear all), sin
// forma de distinguirlos: se descarta para que ninguna alerta que haya vuelto
// a dispararse siga escondida. Lo peor que pasa es tener que ocultar otra vez.
const DISMISSED_KEY = "ultron.cc.dismissed_fingerprints.v2";
const DISMISSED_KEY_V1 = "ultron.cc.dismissed_fingerprints.v1";

export function loadDismissed(): Map<string, number> {
  try {
    localStorage.removeItem(DISMISSED_KEY_V1);
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? parseDismissed(JSON.parse(raw)) : new Map();
  } catch {
    return new Map();
  }
}
export function saveDismissed(d: Dismissed) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(serializeDismissed(d)));
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
