// kirkardo/areas.mjs — areas de producto y sus pesos (2026-10-28, P3 de
// docs/audits/audit-2026-10-28-kirkardo-criterio.md, §3).
//
// La nota global deja de pesar por numero de checks: es la media ponderada de
// las notas de area (pass/total dentro de cada una). Un area con menos de
// MIN_AREA_CHECKS checks medidos cuenta como "sin medir" (nota 0 y laggard).
// La higiene pesa 0: sigue en el informe y puede salir como laggard
// informativo, pero no compra nota ni gatea. Regla documentada en docs/GOAL.md.

export const MIN_AREA_CHECKS = 5;

export const AREAS = [
  { id: "sessions", name: "Sessions (nucleo, front, e2e, persistencia y binario)", weight: 25, cats: [23] },
  { id: "memory", name: "Memoria (FTS5, resume, write-path, estado vivo)", weight: 20, cats: [1, 19, 20, 21] },
  { id: "hooks", name: "Hooks y seguridad", weight: 12, cats: [9, 17] },
  { id: "delegation", name: "Delegacion multimotor, relevo, AI Router y proveedores", weight: 12, cats: [3, 22] },
  { id: "ui", name: "Control Center UI y cableado", weight: 10, cats: [8, 10, 13, 14] },
  { id: "quality", name: "Calidad, CI y reproducibilidad", weight: 10, cats: [7, 12, 18] },
  { id: "pupus", name: "Pupus (mascota)", weight: 6, cats: [24] },
  { id: "codegraph-skills", name: "CodeGraph, skills y plugins", weight: 5, cats: [2, 4, 11] },
  { id: "hygiene", name: "Higiene (limpieza, docs, observabilidad, tombstones)", weight: 0, cats: [5, 6, 15, 16] },
];

// Checks que puntuan en un area distinta de la de su categoria (el campo
// `area` del propio check gana sobre esta tabla).
export const CHECK_AREA = {
  "14.8": "pupus", // guardarrail de persistencia de Pupus
  "14.9": "pupus", // freno del chat de Pupus
  // Mandamiento 9 (2026-11-01): el repo es publico; una fuga de datos personales
  // tiene que mover el gate, no quedarse en un informativo.
  "6.1": "hooks", // rutas personales en ficheros trackeados
  "6.2": "hooks", // audit_personal_data.py HIGH = 0
  // Existencia o texto (auditoria 2026-11-01): siguen en el informe, pero no
  // compran nota. Solo dan rojo si alguien borra el fichero o la cadena.
  "3.1": "hygiene", // claude en el PATH: preflight del entorno
  "10.1": "hygiene", // literal del invoke de orchestrate_prompt
  "10.3": "hygiene", // texto TODO:wire en lib.rs
  "10.5": "hygiene", // texto TODO en Agents.tsx
  "11.5": "hygiene", // delete_mcp: cadena de llamadas leida como texto
  "12.2": "hygiene", // timeout-minutes en el YAML de CI
  "12.4": "hygiene", // node --check de los hooks: sintaxis, no comportamiento
  "13.1": "hygiene", // literal de build_prompt_plan
  "14.1": "hygiene", // literal de validate_keys
  "14.2": "hygiene", // import de Usage en App.tsx
  "14.5": "hygiene", // existe ZoneEditor.tsx
  "17.1": "hygiene", // node --check de stop-compress-session.js
  "17.2": "hygiene", // existe precompact-preserve-l0.js
  "18.1": "hygiene", // existe bootstrap.ps1
  "18.2": "hygiene", // existe INSTALL.md
  "18.4": "hygiene", // texto de setupFiles en vitest.config.ts
};

/** Area de un check: campo propio, tabla de excepciones o area de su categoria. */
export function areaOf(check, catNum) {
  if (check?.area) return check.area;
  if (CHECK_AREA[check?.id]) return CHECK_AREA[check.id];
  return AREAS.find((a) => a.cats.includes(catNum))?.id ?? "hygiene";
}

/** Peso del area (0 si no existe). */
export function areaWeight(id) {
  return AREAS.find((a) => a.id === id)?.weight ?? 0;
}

// Superficies declaradas sin check automatico (P2: uncovered_surfaces). Cada
// una dice por que no se mide aqui; quitarla de la lista exige su check.
export const UNCOVERED_SURFACES = [
  { surface: "Sessions en vivo (arranque real de la app)", why: "los e2e usan mocks; se verifica en vivo con dev:mcp o release por CDP (manual)" },
  { surface: "Sessions: incidentes del registro (S6)", why: "scripts/sesiones-incidentes.mjs no tiene salida --json todavia" },
  { surface: "Relevo: paridad de la cadena entre mods/ultron-relevo y relevo.rs (R3)", why: "la cadena del mod no es una lista estatica comparable; la cubre relevo.test.ts dentro de 12.8" },
  { surface: "Relevo: detect_usage_limit con mensajes reales (R2)", why: "falta el fixture de mensajes reales de limite en sesiones/fixtures/ y su test de Rust" },
  { surface: "Delegacion: aislamiento del motor falso (D5)", why: "crearia ramas delegate/<id> en el repo vivo; pendiente de un repo fixture temporal" },
  { surface: "Juegos en Projects (J1)", why: "projects::game sin commitear; pendiente de su check cuando entre en HEAD" },
  { surface: "Write-path de cierre: session-end-bitacora con transcript fixture (B1)", why: "pendiente; 1.8 solo mide la antiguedad de la bitacora" },
  { surface: "Lienzo de escritorio (desktop/lienzo-desk)", why: "fuera del medidor por decision lienzo-fuera (2026-10-28)" },
  { surface: "UI visual (mandamiento 8)", why: "requiere los ojos del propietario" },
];
