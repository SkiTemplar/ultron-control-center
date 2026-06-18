import { DEFAULT_PRESETS, PRESETS_KEY, WORKSPACE_KEY } from "./constants";
import type { Presets } from "./types";

// ---------------------------------------------------------------------------
// Presets persistence
// ---------------------------------------------------------------------------

export function loadPresets(): Presets {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return DEFAULT_PRESETS;
    const p = JSON.parse(raw) as Partial<Presets>;
    return { ...DEFAULT_PRESETS, ...p };
  } catch {
    return DEFAULT_PRESETS;
  }
}

export function savePresets(p: Presets) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
  } catch {}
}

// ---------------------------------------------------------------------------
// CWD persistence
// ---------------------------------------------------------------------------

export function loadCwd(): string {
  try {
    return localStorage.getItem(WORKSPACE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCwd(v: string) {
  try {
    if (v) localStorage.setItem(WORKSPACE_KEY, v);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {}
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatRel(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

export function deriveWorkspaceName(cwd: string): string {
  const cleaned = cwd.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  if (idx < 0) return cleaned || cwd;
  const tail = cleaned.slice(idx + 1);
  return tail || cleaned;
}
