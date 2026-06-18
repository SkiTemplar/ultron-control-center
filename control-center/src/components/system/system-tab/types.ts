// Types, constants, and small pure utilities shared across System sub-tab modules.

import type { InstalledApp } from "../../../types";

export type SystemSubTab = "diagnostics" | "apps";

export type AppCategory =
  | "Development"
  | "Games"
  | "Media"
  | "Productivity"
  | "System utilities"
  | "Other";

export const CATEGORY_ORDER: AppCategory[] = [
  "Development",
  "Games",
  "Media",
  "Productivity",
  "System utilities",
  "Other",
];

export const CATEGORY_DESCRIPTIONS: Record<AppCategory, string> = {
  Development: "IDEs, language runtimes, CLI tooling, git clients, containers.",
  Games: "Game launchers, titles and game-related peripherals.",
  Media: "Streaming, players, image and video editing.",
  Productivity: "Office suites, note-taking, communication, document readers.",
  "System utilities": "Drivers, runtimes, archivers, OEM helpers.",
  Other: "Everything that didn't match a known category.",
};

export const CONTEXT_HINTS: Record<SystemSubTab, string> = {
  apps:
    'Abre Apps cuando una instalación quedó abandonada, un programa ralentiza el sistema, o quieres saber qué hay instalado antes de liberar espacio.',
  diagnostics:
    'Abre Diagnostics cuando Claude Code no arranca, la terminal no abre, aparecen errores de permisos, o quieres ejecutar fixes del Event Log con un clic.',
};

// localStorage key for the manual / AI override map.
export const OVERRIDES_LS_KEY = "ultron.apps.category_overrides";

export type CategoryOverrides = Record<string, AppCategory>;

// Stable per-app identifier used as the key in the override map. Mirrors the
// React key already used inside CategoryCard so the two never drift.
export function appId(app: InstalledApp): string {
  return `${app.provider}|${app.name}|${app.package_id ?? ""}`;
}

export function loadOverrides(): CategoryOverrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: CategoryOverrides = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && (CATEGORY_ORDER as readonly string[]).includes(v)) {
          out[k] = v as AppCategory;
        }
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveOverrides(map: CategoryOverrides) {
  try {
    localStorage.setItem(OVERRIDES_LS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}
