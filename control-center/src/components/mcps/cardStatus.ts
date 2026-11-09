// Qué enseña la tarjeta de un MCP sobre su salud y su procedencia. Lógica
// pura (sin React) para poder probarla con fechas fijas.

import type { McpStatus } from "../../types";
import { formatAgeMs } from "../../lib/relative-time";
import type { McpOriginKind } from "./types";
import { STALE_THRESHOLD_MS, statusLabel } from "./utils";

export interface McpHealthLine {
  /** Texto de la etiqueta de estado (junto al punto de color). */
  statusText: string;
  /** «comprobado hace 2 h» junto al transporte; null si ya va en statusText o no hay fecha. */
  checkedText: string | null;
  /** Dato ausente o caducado: punto y etiqueta en color neutro. */
  stale: boolean;
}

/**
 * Una sola verdad por tarjeta. Antes salían a la vez «SIN COMPROBAR» y
 * «comprobado 2026-07-20 12:01»: la etiqueta decía que nunca se comprobó y la
 * fecha que sí. Ahora:
 * - sin fecha (o ilegible): «sin comprobar»;
 * - fecha caducada (> STALE_THRESHOLD_MS): «comprobado hace 3 meses», sin
 *   afirmar un estado que ya no se sabe si sigue siendo cierto;
 * - fecha reciente: el estado («conectado»…) y aparte «comprobado hace 2 h».
 */
export function mcpHealthLine(
  status: McpStatus,
  expectedOffline: boolean,
  lastChecked: string | null | undefined,
  now: number = Date.now(),
): McpHealthLine {
  const ts = lastChecked ? new Date(lastChecked).getTime() : NaN;
  // `status: "unknown"` = este servidor no salió en la última pasada (p. ej.
  // un .mcp.json sin aprobar, que no se ejecuta): la fecha es de la pasada,
  // no suya, así que tampoco cuenta como comprobado.
  if (Number.isNaN(ts) || status === "unknown") {
    return { statusText: "sin comprobar", checkedText: null, stale: true };
  }
  const age = now - ts;
  const checked = `comprobado ${formatAgeMs(age)}`;
  if (age > STALE_THRESHOLD_MS) {
    return { statusText: checked, checkedText: null, stale: true };
  }
  return {
    statusText: statusLabel(status, expectedOffline, false),
    checkedText: checked,
    stale: false,
  };
}

/**
 * Si se pinta la insignia «no reconocido».
 *
 * `unknown` lo calcula el backend (`is_unknown_mcp` en
 * src-tauri/src/mcps/types_io.rs) y solo significa «el nombre no está en el
 * catálogo curado de MCP conocidos» (github, context7, playwright…). No es un
 * estado de confianza: la aprobación de servidores la decide
 * src-tauri/src/mcps/confianza.rs y no alimenta este campo. Casi cualquier MCP
 * propio (codegraph, ultron-desktop…) queda fuera del catálogo, así que la
 * insignia salía en todas las tarjetas y no distinguía nada.
 *
 * Solo aporta cuando el servidor no lo ha escrito el usuario: un `.mcp.json`
 * que llega con un repositorio (origen «proyecto») o un origen desconocido.
 * Los de ámbito de usuario, plugin o settings.json los puso el propio usuario.
 */
export function shouldShowUnknownBadge(
  unknown: boolean | undefined,
  originKind: McpOriginKind,
): boolean {
  if (!unknown) return false;
  return originKind === "project" || originKind === "unknown";
}
