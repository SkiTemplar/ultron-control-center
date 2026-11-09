// Horario del backup semanal tal como lo devuelve `get_backup_schedule`
// (crate::backup_status::schedule).
//
// La única fuente de verdad es la tarea registrada en el Programador de
// tareas de Windows: el horario se lee de su disparador. Antes la UI pintaba
// «Próxima copia: sábado a las 09:00» desde backup-config.json mientras la
// tarea real corría el domingo a las 10:00, y consultaba una tarea con otro
// nombre que no existía (hallazgo N1, auditoría 2026-10-23).

import type { BackupTone } from "../dashboard/backupLastRun";

export interface BackupScheduleInfo {
  task_name: string;
  task_registered: boolean;
  task_enabled: boolean;
  /** Días del disparador semanal (`MON`..`SUN`); vacío sin tarea semanal. */
  days: string[];
  /** `HH:MM` del disparador semanal. */
  time: string | null;
  query_error: string | null;
}

export const WEEKDAYS: { code: string; label: string }[] = [
  { code: "MON", label: "lunes" },
  { code: "TUE", label: "martes" },
  { code: "WED", label: "miércoles" },
  { code: "THU", label: "jueves" },
  { code: "FRI", label: "viernes" },
  { code: "SAT", label: "sábado" },
  { code: "SUN", label: "domingo" },
];

export function dayLabel(code: string): string {
  return WEEKDAYS.find((w) => w.code === code)?.label ?? code;
}

/** «domingo a las 10:00», «lunes y jueves a las 03:30». */
export function scheduleLabel(days: string[], time: string): string {
  const labels = days.map(dayLabel);
  const joined =
    labels.length > 1 ? `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}` : labels[0];
  return `${joined} a las ${time}`;
}

/** Línea de estado bajo el formulario: qué hará de verdad la tarea registrada. */
export function scheduleStatus(info: BackupScheduleInfo | null): { tone: BackupTone; text: string } {
  if (!info) return { tone: "neutral", text: "Consultando el Programador de tareas…" };
  if (info.query_error) {
    return { tone: "warn", text: `No se pudo consultar el Programador de tareas: ${info.query_error}` };
  }
  const task = `«${info.task_name}»`;
  if (!info.task_registered) {
    return {
      tone: "danger",
      text: `Sin tarea registrada (${task}): la copia no se ejecuta sola. Guarda un horario para registrarla.`,
    };
  }
  if (info.days.length === 0 || !info.time) {
    return {
      tone: "warn",
      text: `La tarea ${task} está registrada, pero su disparador no es semanal. Guarda un horario para sustituirlo.`,
    };
  }
  const when = scheduleLabel(info.days, info.time);
  if (!info.task_enabled) {
    return { tone: "warn", text: `La tarea ${task} está deshabilitada en el Programador de tareas (${when}).` };
  }
  return { tone: "ok", text: `Próxima copia: cada ${when} (tarea ${task}).` };
}

/** Valores iniciales del formulario: los de la tarea real, o lunes 09:00 si no hay. */
export function scheduleFormDefaults(info: BackupScheduleInfo | null): { day: string; time: string } {
  return { day: info?.days[0] ?? "MON", time: info?.time ?? "09:00" };
}
