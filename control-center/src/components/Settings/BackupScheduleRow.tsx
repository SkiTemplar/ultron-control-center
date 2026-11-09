import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toneColor } from "../dashboard/backupLastRun";
import {
  WEEKDAYS,
  scheduleFormDefaults,
  scheduleLabel,
  scheduleStatus,
  type BackupScheduleInfo,
} from "./backupSchedule";

// Fila «Horario» de Ajustes → Backups. Lee y registra la tarea programada
// (get_backup_schedule / set_backup_schedule); el texto de estado sale de la
// tarea real, nunca del formulario.

const FIELD_STYLE = {
  background: "var(--color-surface-1)",
  color: "var(--color-text)",
  border: "1px solid var(--color-border-strong)",
};

export function BackupScheduleRow({
  onError,
  onSuccess,
}: {
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}) {
  const [schedule, setSchedule] = useState<BackupScheduleInfo | null>(null);
  const [day, setDay] = useState("MON");
  const [time, setTime] = useState("09:00");
  const [busy, setBusy] = useState(false);

  function apply(info: BackupScheduleInfo) {
    setSchedule(info);
    const defaults = scheduleFormDefaults(info);
    setDay(defaults.day);
    setTime(defaults.time);
  }

  useEffect(() => {
    invoke<BackupScheduleInfo>("get_backup_schedule")
      .then(apply)
      .catch((e) => onError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- carga única al montar
  }, []);

  const dirty = useMemo(() => {
    if (!schedule?.task_registered || !schedule.time) return true;
    return day !== schedule.days[0] || time !== schedule.time || schedule.days.length !== 1;
  }, [schedule, day, time]);

  async function save() {
    setBusy(true);
    try {
      const r = await invoke<BackupScheduleInfo>("set_backup_schedule", { day, time });
      apply(r);
      onSuccess(
        r.task_registered && r.time
          ? `Tarea «${r.task_name}» registrada: cada ${scheduleLabel(r.days, r.time)}.`
          : `Se pidió registrar la tarea, pero el Programador de tareas no la devuelve.`,
      );
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const status = scheduleStatus(schedule);
  return (
    <div className="mt-5">
      <label
        className="mb-1.5 block text-[11.5px] font-semibold"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Horario
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Día
        </label>
        <select
          value={day}
          onChange={(e) => setDay(e.target.value)}
          disabled={busy}
          className="rounded px-2 py-1 text-[12px]"
          style={FIELD_STYLE}
        >
          {WEEKDAYS.map((d) => (
            <option key={d.code} value={d.code}>
              {d.label}
            </option>
          ))}
        </select>
        <label className="ml-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Hora
        </label>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          disabled={busy}
          className="rounded px-2 py-1 text-[12px]"
          style={{ ...FIELD_STYLE, fontFamily: "var(--font-mono)" }}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: dirty ? "var(--color-accent)" : "var(--color-surface-1)",
            color: dirty ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
            border: dirty ? "none" : "1px solid var(--color-border-strong)",
          }}
          title="Registra (o sustituye) la tarea programada con este día y hora"
        >
          {busy ? "Guardando…" : "Guardar horario"}
        </button>
      </div>
      <div className="mt-1.5 text-[11.5px]" style={{ color: toneColor(status.tone) }}>
        {status.text}
      </div>
    </div>
  );
}
