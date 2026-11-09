// Acciones de la paleta Ctrl+K que lanzan mantenimiento y el Rebuild.
//
// El catálogo sale de `list_maintenance_commands` (fuente de verdad en
// `maintenance/commands.rs`). Dos reglas que antes no se cumplían:
//   - una acción marcada `destructive` (borrar %TEMP%, reiniciar el
//     Explorador, restablecer TCP/IP, doctor --fix --yes) pide confirmación;
//   - el resultado se enseña siempre: `run_maintenance_command` devuelve Ok
//     con `success: false` cuando el proceso sale con código distinto de 0,
//     y eso es un fallo para el usuario, no un éxito silencioso.
// El Rebuild sigue el flujo canónico de Settings (`startRebuild`).

import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../../lib/dialog";
import { notify } from "../../lib/notify";
import type { PaletteAction } from "../CommandPalette";
import { REBUILD_STARTED_MESSAGE, startRebuild } from "../Settings/rebuildFlow";
import type { MaintenanceResult } from "../system/diagnostics/types";

/** Espejo de `maintenance::MaintenanceCommand`. */
export interface MaintenanceCommand {
  kind: string;
  label: string;
  description: string;
  group: string;
  destructive: boolean;
}

export type MaintenanceOutcome = "cancelled" | "ok" | "failed";

/** Nombre visible de los grupos de `list_maintenance_commands` en la paleta. */
const MAINTENANCE_GROUP_LABELS: Record<string, string> = {
  skills: "skills",
  system: "sistema",
  pc: "PC",
};

const MAX_MESSAGE_CHARS = 600;
const MAX_TAIL_CHARS = 200;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Mensaje del resultado: éxito con duración o fallo con código y cola de salida. */
export function describeMaintenanceResult(label: string, r: MaintenanceResult): string {
  if (r.success) return `${label}: hecho (${r.elapsed_ms} ms).`;
  const tail = (r.stderr || r.stdout || "").trim().slice(0, MAX_TAIL_CHARS);
  const code = r.exit_code ?? "?";
  return `${label} ha fallado (código ${code}).${tail ? ` ${tail}` : ""}`.slice(0, MAX_MESSAGE_CHARS);
}

/** Confirma si hace falta, lanza el comando y enseña el resultado. */
export async function runMaintenanceFromPalette(cmd: MaintenanceCommand): Promise<MaintenanceOutcome> {
  if (cmd.destructive) {
    const ok = await confirmDialog(`${cmd.label}: ${cmd.description}\n\n¿Lanzarlo ahora?`, {
      title: "Mantenimiento",
      kind: "warning",
      okLabel: "Lanzar",
      cancelLabel: "Cancelar",
    });
    if (!ok) return "cancelled";
  }
  try {
    const r = await invoke<MaintenanceResult>("run_maintenance_command", { kind: cmd.kind });
    notify({
      severity: r.success ? "info" : "warn",
      source: "palette",
      message: describeMaintenanceResult(cmd.label, r),
    });
    return r.success ? "ok" : "failed";
  } catch (err) {
    notify({
      severity: "warn",
      source: "palette",
      message: `${cmd.label} ha fallado: ${errorText(err)}`.slice(0, MAX_MESSAGE_CHARS),
    });
    return "failed";
  }
}

/** Una acción de paleta por comando de mantenimiento. */
export function maintenancePaletteActions(cmds: MaintenanceCommand[]): PaletteAction[] {
  return cmds.map((m) => ({
    id: `maint.${m.kind}`,
    label: m.label,
    description: m.destructive ? `${m.description} Pide confirmación.` : m.description,
    group: `Mantenimiento (${MAINTENANCE_GROUP_LABELS[m.group] ?? m.group})`,
    run: () => void runMaintenanceFromPalette(m),
  }));
}

/** Rebuild desde la paleta o el banner: flujo canónico y resultado visible. */
export async function runRebuildWithFeedback(source: string): Promise<void> {
  try {
    const outcome = await startRebuild();
    if (outcome === "started") {
      notify({ severity: "info", source, message: REBUILD_STARTED_MESSAGE });
    }
  } catch (err) {
    notify({
      severity: "warn",
      source,
      message: `Recompilar ha fallado: ${errorText(err)}`.slice(0, MAX_MESSAGE_CHARS),
    });
  }
}

/** Entrada «Recompilar Control Center» de la paleta. */
export function rebuildPaletteAction(): PaletteAction {
  return {
    id: "sys.rebuild",
    label: "Recompilar Control Center",
    description:
      "Abre una terminal con git pull, npm install y npm run build:local (pide confirmación). " +
      "El binario nuevo entra al reiniciar la app.",
    group: "Sistema",
    run: () => void runRebuildWithFeedback("palette"),
  };
}
