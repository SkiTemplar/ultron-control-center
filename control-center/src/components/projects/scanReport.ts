// Parte de «Volver a escanear el disco»: qué raíces se recorrieron y qué se dio
// de alta. Un escaneo sin novedades también lo dice, para no confundirlo con un
// botón que no hace nada.

import type { ProjectInfo } from "../../types";

export type ScanReport = {
  projects: ProjectInfo[];
  added: { id: string; name: string; path: string }[];
  scanned_roots: string[];
  missing_roots: string[];
};

export type ScanAction = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

const MAX_NAMES_SHOWN = 8;

function addedLine(added: ScanReport["added"]): string {
  if (added.length === 0) return "Escaneo terminado: ninguna carpeta nueva.";
  const names = added.slice(0, MAX_NAMES_SHOWN).map((p) => p.name);
  const more = added.length - names.length;
  const suffix = more > 0 ? ` y ${more} más` : "";
  const noun = added.length === 1 ? "proyecto nuevo" : "proyectos nuevos";
  return `Escaneo terminado: ${added.length} ${noun} (${names.join(", ")}${suffix}).`;
}

export function scanResultAction(report: ScanReport): ScanAction {
  const roots = `Raíces recorridas: ${report.scanned_roots.join(", ")}.`;
  return {
    success: true,
    stdout: `${addedLine(report.added)} ${roots}`,
    stderr:
      report.missing_roots.length > 0
        ? `Raíces que no existen en disco: ${report.missing_roots.join(", ")}.`
        : "",
    exit_code: 0,
  };
}
