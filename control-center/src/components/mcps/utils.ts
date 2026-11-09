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

/** Formatea ms como antigüedad relativa: "ahora mismo", "hace 5 min", "hace 20 h", "hace 3 d". */
export function formatAge(ms: number): string {
  if (ms < 60_000) return "ahora mismo";
  if (ms < 3_600_000) return `hace ${Math.floor(ms / 60_000)} min`;
  if (ms < 86_400_000) return `hace ${Math.floor(ms / 3_600_000)} h`;
  return `hace ${Math.floor(ms / 86_400_000)} d`;
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
  // "user-claudejson" era el origen antiguo del mismo ámbito (H14).
  if (o === "user" || o === "user-claudejson") return { kind: "user", label: "user" };
  if (o === "settings") return { kind: "settings", label: "settings.json" };
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
    case "settings":
      return { bg: "rgba(210, 153, 34, 0.15)", fg: "#d29922" };
    default:
      return { bg: "var(--color-surface-3)", fg: "var(--color-text-secondary)" };
  }
}

/** Nombre visible del tipo de origen (el `kind` interno no se traduce). */
export function originKindLabel(kind: McpOriginKind): string {
  switch (kind) {
    case "user":
      return "usuario";
    case "project":
      return "proyecto";
    case "plugin":
      return "plugin";
    case "settings":
      return "settings.json";
    default:
      return "desconocido";
  }
}

export function statusLabel(s: McpStatus, expectedOffline: boolean, stale: boolean): string {
  // Sin dato de salud (o dato caducado): "sin comprobar", para no chocar con
  // el chip "no reconocido", que habla del servidor y no de su salud.
  if (stale) return "sin comprobar";
  if (s === "ok") return "conectado";
  if (s === "degraded") return expectedOffline ? "desconectado" : "degradado";
  if (s === "missing") return "no encontrado";
  if (s === "unknown") return "sin comprobar";
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

// `type` explícito, como lo escribe `claude mcp add`: una entrada con `url`
// y sin `type` no es un servidor HTTP válido para Claude Code.
export function editableToConfig(m: EditableMcp): Record<string, unknown> {
  if (m.transport === "http" || m.transport === "sse") {
    return { type: m.transport, url: m.url.trim() };
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
    type: "stdio",
    command: m.command.trim(),
    args,
  };
  if (Object.keys(env).length > 0) out.env = env;
  return out;
}

// `existing`: edición de una entrada que ya existe. Su nombre no se cambia
// y puede venir de `claude mcp add` con mayúsculas, así que la regla de
// nombres solo se aplica a las altas.
export function validateEditable(m: EditableMcp, existing = false): string | null {
  if (!existing && !NAME_RE.test(m.name)) {
    return "El nombre debe cumplir ^[a-z0-9][a-z0-9_-]{1,60}$ (minúsculas, dígitos, _ o -).";
  }
  if (m.transport === "stdio") {
    if (!m.command.trim()) return "El comando es obligatorio con transporte stdio.";
  } else {
    if (!m.url.trim()) return "La URL es obligatoria con transporte http/sse.";
    try {
      new URL(m.url.trim());
    } catch {
      return "La URL no es válida.";
    }
  }
  return null;
}
