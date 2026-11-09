// Consumption pace of a plan window: compares the share of quota used with the
// share of the window already elapsed. Same rule as hooks/scripts/lib/usage-pace.js
// (statusline and the usage-pace-guard hook): over pace when used > elapsed,
// with a usage floor so the first minutes of a window do not raise alarms.
//
// The weekly window can weigh its hours with the user's usage schedule
// (usageSchedule.ts, port of hooks/scripts/lib/usage-schedule.js): the elapsed
// share becomes the share of EXPECTED use so far. The 5 h window is always linear.

import { weightedElapsedPct, type UsageSchedule } from "./usageSchedule";

export const MIN_USED_PCT = 15;

// Both windows raise the reduce-usage alert with the same pace rule. The absolute
// 25 % cap on the 5 h window was retired on 2026-10-26 (plan downgrade).

const WINDOW_MS = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
} as const;

export type PlanWindowKey = keyof typeof WINDOW_MS;

export interface PlanPace {
  /** Share of the window already elapsed: linear, or expected use when `scheduled`. */
  elapsedPct: number;
  /** Share of TIME elapsed, whatever the schedule says. */
  linearElapsedPct: number;
  /** `elapsedPct` was weighted with the usage schedule (weekly window only). */
  scheduled: boolean;
  projectedPct: number;
  over: boolean;
  alert: boolean;
}

export function planPace(
  key: PlanWindowKey,
  usedPct: number,
  resetsAt: string | null,
  now: number = Date.now(),
  schedule: UsageSchedule | null = null,
): PlanPace | null {
  if (!resetsAt || !Number.isFinite(usedPct)) return null;
  const reset = new Date(resetsAt).getTime();
  if (Number.isNaN(reset)) return null;
  const duration = WINDOW_MS[key];
  const remaining = Math.min(duration, Math.max(0, reset - now));
  const linearElapsedPct = ((duration - remaining) / duration) * 100;
  let elapsedPct = linearElapsedPct;
  let scheduled = false;
  if (key === "seven_day" && schedule) {
    const weighted = weightedElapsedPct(reset - duration, now, reset, schedule);
    if (weighted !== null) {
      elapsedPct = weighted;
      scheduled = true;
    }
  }
  const projectedPct = elapsedPct > 0 ? (usedPct / elapsedPct) * 100 : usedPct > 0 ? Infinity : 0;
  const over = usedPct >= MIN_USED_PCT && usedPct < 100 && usedPct > elapsedPct;
  return { elapsedPct, linearElapsedPct, scheduled, projectedPct, over, alert: over };
}
