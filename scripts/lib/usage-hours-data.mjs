// usage-hours-data.mjs — carga del gasto por día y hora para usage-hours y usage-outlook:
// solo semanas completas con transcripts y dentro de la retención de Claude Code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dailyHourlyCost } from './usage-transcripts.mjs';
import { fromFirstActivity, relativePace, weekTotals } from './usage-hours.mjs';

/** Días que Claude Code conserva un transcript sin tocar (`cleanupPeriodDays`, 30 por defecto). */
export function retentionDays() {
  const file = process.env.ULTRON_CLAUDE_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')).cleanupPeriodDays;
    return Number.isInteger(v) && v > 0 ? v : 30;
  } catch {
    return 30;
  }
}

/**
 * Semanas completas recientes (como mucho `weeks`, y no más de las que caben en la
 * retención: más allá los transcripts ya están borrados en parte).
 * { days, cost, totalCost, retention, windowWeeks }.
 */
export function loadRecentDays({ weeks = 8, now = Date.now() } = {}) {
  const retention = retentionDays();
  const windowWeeks = Math.min(weeks, Math.floor(retention / 7));
  const raw = dailyHourlyCost({ days: windowWeeks * 7, now });
  const withData = fromFirstActivity(raw.days, raw.cost);
  const days = withData.slice(withData.length % 7);
  const totalCost = days.reduce((acc, d) => acc + raw.cost.get(d).reduce((a, b) => a + b, 0), 0);
  return { days, cost: raw.cost, totalCost, retention, windowWeeks };
}

/** Ritmo de los últimos 7 días frente a tu media reciente; `null` con menos de dos semanas. */
export function recentPace(opts) {
  const data = loadRecentDays(opts);
  return data.days.length >= 14 ? relativePace(weekTotals(data.days, data.cost)) : null;
}
