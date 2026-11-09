// Formato del ritmo de uso: mismas reglas y textos que el mod ultron-uso
// (`mods/ultron-uso/hooks/format.ts`); si cambia uno, cambia el otro. Los
// datos llegan del mismo puente (`sesiones_usage_pace`).

import type { UsoWindow } from "../../types";

const LABELS: Record<string, string> = { five_hour: "5 horas", seven_day: "Semanal" };

export const pct = (n: number): string => `${Math.round(n)} %`;

/** `reinicia en 3 h 12 min` o `reinicia el sábado, 22:52` (relativo a `now`). */
export function resetText(ms: number, now: number): string {
  const mins = Math.round((ms - now) / 60000);
  if (mins <= 0) return "reinicio inminente";
  if (mins < 60) return `reinicia en ${mins} min`;
  if (mins < 60 * 24) return `reinicia en ${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `reinicia el ${new Date(ms).toLocaleDateString("es-ES", { weekday: "long", hour: "2-digit", minute: "2-digit" })}`;
}

export const windowLabel = (kind: string): string =>
  LABELS[kind] ?? Object.entries(LABELS).find(([k]) => kind.startsWith(k))?.[1] ?? kind;

export const isWeek = (w: UsoWindow): boolean => w.kind.startsWith("seven_day");

/** Rojo si llega al límite antes del reset; ámbar si va justo. */
export function tone(w: UsoWindow): "err" | "warn" | "" {
  if (w.runsOutLabel !== null) return "err";
  return w.projectedPct !== null && w.projectedPct > 90 ? "warn" : "";
}

/** `uso 55 % · tiempo 54 %`, y en la semanal `· relativo 63 %` (tiempo según el horario). */
export function usageLine(w: UsoWindow): string {
  const base = `uso ${pct(w.used)} · tiempo ${pct(w.linearElapsedPct)}`;
  return isWeek(w) && w.isScheduled ? `${base} · relativo ${pct(w.elapsedPct)}` : base;
}

/** Ritmo (100 % = llegar al reset justo en el límite) y hora estimada del límite. */
export function limitLine(w: UsoWindow): string {
  const rate = w.projectedPct === null ? "—" : pct(w.projectedPct);
  return `ritmo ${rate} · límite ${w.runsOutLabel ?? "no llega"}`;
}

const dec = (n: number): string => n.toFixed(1).replace(".", ",");

/** Ventanas de 5 h llenas que quedan en la semana. */
export function fiveHourLines(w: UsoWindow, weekInFiveHourPct: number | null): string[] {
  if (weekInFiveHourPct === null) return [];
  const left = (Math.max(0, 100 - w.used) * weekInFiveHourPct) / 100;
  return [`ventanas 5 h: quedan ${dec(left / 100)} de ${dec(weekInFiveHourPct / 100)} (${pct(left)})`];
}
