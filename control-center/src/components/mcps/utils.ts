import type { McpStatus } from "../../types";
import type { EditableMcp, McpOriginKind, Transport } from "./types";

export const HIDE_KEY = "ultron.cc.hidden_mcps.v1";
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,60}$/;

// Tiempo máximo desde last_checked antes de considerar el estado como "stale"
// y sustituir el badge coloreado por un indicador neutro.
// El cache en disco (~/.ultron/.tmp/mcp-health.json) puede tener días de
// antigüedad: mostrar ese estado como "connected" sería falso.
export const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 horas

/** Devuelve la antigüedad en ms de un timestamp ISO. null si no parseable. */
export function ageMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Date.now() - d.getTime();
}

/** True si el timestamp supera STALE_THRESHOLD_MS o no existe. */
export function isStaleTimestamp(iso: string | null | undefined): boolean {
  const age = ageMs(iso);
  return age === null || age > STALE_THRESHOLD_MS;
}

/** Formatea ms en "Xh Ym" (o "Xd" para más de 24h). */
export function formatAge(ms: number): string {
  if (ms < 60_000) return "hace un momento";
  if (ms < 3_600_000) return `hace ${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `hace ${Math.floor(ms / 3_600_000)}h`;
  return `hace ${Math.floor(ms / 86_400_000)}d`;
}

export function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveHidden(s: Set<string>) {
  try {
    localStorage.setItem(HIDE_KEY, JSON.stringify(Array.from(s)));
  } catch {}
}

export function statusColor(s: McpStatus, expectedOffline: boolean, stale: boolean): string {
  // Si el cache está desactualizado, usamos un color neutro independientemente
  // del estado almacenado — presentar "ok" con verde basado en datos de hace
  // días sería engañoso.
  if (stale) return "var(--color-text-faint)";
  if (s === "ok") return "var(--color-success)";
  if (s === "degraded" || s === "missing") {
    return expectedOffline ? "var(--color-text-tertiary)" : "var(--color-warn)";
  }
  return "var(--color-text-faint)";
}

export function parseOrigin(o: string | undefined): { kind: McpOriginKind; label: string } {
  if (!o) return { kind: "unknown", label: "?" };
  if (o === "user") return { kind: "user", label: "user" };
  if (o.startsWith("project:")) {
    return { kind: "project", label: o.slice("project:".length) || "project" };
  }
  if (o.startsWith("plugin:")) {
    return { kind: "plugin", label: o.slice("plugin:".length) || "plugin" };
  }
  return { kind: "unknown", label: o };
}

export function originBadgeColor(kind: McpOriginKind): { bg: string; fg: string } {
  switch (kind) {
    case "user":
      return { bg: "rgba(56, 139, 253, 0.12)", fg: "var(--color-accent, #58a6ff)" };
    case "project":
      return { bg: "rgba(63, 185, 80, 0.12)", fg: "var(--color-success)" };
    case "plugin":
      return { bg: "rgba(163, 113, 247, 0.12)", fg: "#a371f7" };
    default:
      return { bg: "var(--color-surface-3)", fg: "var(--color-text-secondary)" };
  }
}

export function statusLabel(s: McpStatus, expectedOffline: boolean, stale: boolean): string {
  if (stale) return "desconocido";
  if (s === "ok") return "connected";
  if (s === "degraded") return expectedOffline ? "offline" : "degraded";
  if (s === "missing") return "missing";
  if (s === "unknown") return "unknown";
  return s;
}

export function blankMcp(): EditableMcp {
  return {
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    envRows: [],
    url: "",
  };
}

export function configToEditable(name: string, cfg: Record<string, unknown>): EditableMcp {
  const transportRaw = (cfg.type as string) ?? "";
  const url = (cfg.url as string) ?? "";
  let transport: Transport;
  if (transportRaw === "sse") transport = "sse";
  else if (url) transport = "http";
  else transport = "stdio";

  const args = Array.isArray(cfg.args) ? (cfg.args as string[]) : [];
  const env = (cfg.env && typeof cfg.env === "object" ? cfg.env : {}) as Record<
    string,
    string
  >;

  return {
    name,
    transport,
    command: (cfg.command as string) ?? "",
    argsText: args.join("\n"),
    envRows: Object.entries(env).map(([k, v]) => ({ key: k, value: String(v) })),
    url,
  };
}

export function editableToConfig(m: EditableMcp): Record<string, unknown> {
  if (m.transport === "http" || m.transport === "sse") {
    const out: Record<string, unknown> = { url: m.url.trim() };
    if (m.transport === "sse") out.type = "sse";
    return out;
  }
  const args = m.argsText
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const env: Record<string, string> = {};
  for (const r of m.envRows) {
    const k = r.key.trim();
    if (k) env[k] = r.value;
  }
  const out: Record<string, unknown> = {
    command: m.command.trim(),
    args,
  };
  if (Object.keys(env).length > 0) out.env = env;
  return out;
}

export function validateEditable(m: EditableMcp): string | null {
  if (!NAME_RE.test(m.name)) {
    return "Name must match ^[a-z0-9][a-z0-9_-]{1,60}$ (lowercase, digits, _ or -).";
  }
  if (m.transport === "stdio") {
    if (!m.command.trim()) return "Command is required for stdio transport.";
  } else {
    if (!m.url.trim()) return "URL is required for http/sse transport.";
    try {
      new URL(m.url.trim());
    } catch {
      return "URL is not a valid URL.";
    }
  }
  return null;
}
