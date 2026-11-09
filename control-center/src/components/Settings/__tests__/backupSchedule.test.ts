// La fila «Horario» de Ajustes → Backups enseña el horario de la tarea
// registrada, no el de backup-config.json (hallazgo N1, 2026-10-23).

import { describe, it, expect } from "vitest";
import {
  scheduleFormDefaults,
  scheduleLabel,
  scheduleStatus,
  type BackupScheduleInfo,
} from "../backupSchedule";

/** Lo que devuelve get_backup_schedule con la tarea real de esta máquina. */
const REAL: BackupScheduleInfo = {
  task_name: "ULTRON Weekly Backup",
  task_registered: true,
  task_enabled: true,
  days: ["SUN"],
  time: "10:00",
  query_error: null,
};

describe("scheduleStatus", () => {
  it("enseña el horario real de la tarea registrada", () => {
    const s = scheduleStatus(REAL);
    expect(s.tone).toBe("ok");
    expect(s.text).toBe("Próxima copia: cada domingo a las 10:00 (tarea «ULTRON Weekly Backup»).");
  });

  it("sin tarea dice «sin tarea registrada» y no inventa un horario (caso negativo)", () => {
    const s = scheduleStatus({ ...REAL, task_registered: false, task_enabled: false, days: [], time: null });
    expect(s.tone).toBe("danger");
    expect(s.text).toMatch(/Sin tarea registrada/);
    expect(s.text).not.toMatch(/Próxima copia/);
  });

  it("una tarea deshabilitada no se anuncia como próxima copia", () => {
    const s = scheduleStatus({ ...REAL, task_enabled: false });
    expect(s.tone).toBe("warn");
    expect(s.text).toMatch(/deshabilitada/);
  });

  it("un disparador que no es semanal se avisa", () => {
    expect(scheduleStatus({ ...REAL, days: [], time: null }).text).toMatch(/no es semanal/);
  });

  it("un fallo al consultar se enseña", () => {
    expect(scheduleStatus({ ...REAL, query_error: "no se pudo lanzar schtasks" }).tone).toBe("warn");
  });
});

describe("scheduleLabel y scheduleFormDefaults", () => {
  it("varios días se enumeran", () => {
    expect(scheduleLabel(["MON", "THU"], "03:30")).toBe("lunes y jueves a las 03:30");
  });

  it("el formulario arranca con el horario real; sin tarea, lunes 09:00", () => {
    expect(scheduleFormDefaults(REAL)).toEqual({ day: "SUN", time: "10:00" });
    expect(scheduleFormDefaults(null)).toEqual({ day: "MON", time: "09:00" });
  });
});
