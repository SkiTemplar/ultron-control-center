import type { ScopeFilter } from "./types";

export const SCOPES: { id: ScopeFilter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "global", label: "Global" },
  { id: "project", label: "Proyecto" },
  { id: "plugin", label: "Plugin" },
];

export const NO_CATEGORY = "sin categoría";

// Acento cian: distingue las tarjetas de skills de las de agentes (violeta) y reglas (lima).
export const SKILL_ACCENT = "rgba(56, 189, 248, 0.55)";
export const SKILL_ACCENT_SOFT = "rgba(56, 189, 248, 0.16)";
