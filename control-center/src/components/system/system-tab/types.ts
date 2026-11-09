// Types, constants, and small pure utilities shared across System sub-tab modules.

import type { InstalledApp } from "../../../types";

export type SystemSubTab = "diagnostics" | "apps" | "tasks" | "turn_off";

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

/** Nombre visible de cada categoría (el identificador se guarda en localStorage y no cambia). */
export const CATEGORY_LABELS: Record<AppCategory, string> = {
  Development: "Desarrollo",
  Games: "Juegos",
  Media: "Multimedia",
  Productivity: "Productividad",
  "System utilities": "Utilidades del sistema",
  Other: "Otras",
};

export const CATEGORY_DESCRIPTIONS: Record<AppCategory, string> = {
  Development: "IDE, runtimes de lenguajes, herramientas de línea de comandos, clientes de git y contenedores.",
  Games: "Lanzadores de juegos, títulos y periféricos de juego.",
  Media: "Streaming, reproductores y edición de imagen y vídeo.",
  Productivity: "Ofimática, notas, comunicación y lectores de documentos.",
  "System utilities": "Drivers, runtimes, compresores y utilidades del fabricante.",
  Other: "Todo lo que no encaja en una categoría conocida.",
};

export const CONTEXT_HINTS: Record<SystemSubTab, string> = {
  apps:
    "Abre Aplicaciones cuando quede una instalación olvidada, un programa ralentice el sistema o quieras ver qué hay instalado antes de liberar espacio.",
  diagnostics:
    "Abre Diagnóstico cuando Claude Code no arranque, la terminal no se abra, salgan errores de permisos o quieras aplicar en un clic los arreglos del registro de eventos.",
  tasks:
    "Abre Tareas para ver las tareas programadas de ULTRON (backups, diagnóstico diario…): último resultado, próxima ejecución, ejecutar ahora, editar el disparador o borrarlas.",
  turn_off:
    "Programa el apagado de este PC dentro de unas horas. Lo ejecuta Windows (shutdown.exe), así que el plazo se mantiene aunque cierres el Control Center; puedes cancelarlo cuando quieras.",
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
