// Uso de Codex y agy en la pestaña Uso (bloque secundario bajo el de Claude).
// Los datos los calcula `scripts/engine-usage.mjs` (hooks/scripts/lib/
// engine-usage.js) y llegan por `sesiones_engines_usage`; aquí se valida la
// forma en la frontera y se formatea. Sin cuota conocida (agy sin `/usage`) se
// muestra la actividad, nunca un porcentaje.

import type { DeepseekBalanceUsage, DelegationEngineUsage, EnginePlanActivity, EnginePlanUsage, EnginePlanWindow, EnginesPlanUsage } from "../../types";
import { formatTokens } from "../../parse";
import { pct, resetText } from "./uso-format";
import { minutesSince } from "./uso-state";

const STATUSES = new Set(["ok", "none", "error"]);
const SOURCES = new Set(["rollout", "agy-usage", "activity"]);

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toWindow(v: unknown): EnginePlanWindow | null {
  if (!isObj(v) || typeof v.kind !== "string") return null;
  return { kind: v.kind, group: str(v.group), usedPct: num(v.usedPct), resetsAtMs: num(v.resetsAtMs), expired: v.expired === true };
}

function toActivity(v: unknown): EnginePlanActivity | null {
  if (!isObj(v)) return null;
  const turns = num(v.turns);
  const tokens = num(v.tokens);
  return turns === null || tokens === null ? null : { turns, tokens };
}

function toEngine(v: unknown): EnginePlanUsage | null {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.status !== "string" || !STATUSES.has(v.status)) return null;
  const five = isObj(v.activity) ? toActivity(v.activity.fiveHour) : null;
  const week = isObj(v.activity) ? toActivity(v.activity.sevenDay) : null;
  return {
    id: v.id,
    label: str(v.label) ?? v.id,
    status: v.status as EnginePlanUsage["status"],
    source: typeof v.source === "string" && SOURCES.has(v.source) ? (v.source as EnginePlanUsage["source"]) : null,
    readAtMs: num(v.readAtMs),
    plan: str(v.plan),
    windows: Array.isArray(v.windows) ? v.windows.map(toWindow).filter((w): w is EnginePlanWindow => w !== null) : [],
    activity: five && week ? { fiveHour: five, sevenDay: week } : null,
    note: str(v.note),
  };
}

const DS_STATUSES = new Set(["ok", "none", "error"]);

function toDeepseek(v: unknown): DeepseekBalanceUsage | null {
  if (!isObj(v) || typeof v.status !== "string" || !DS_STATUSES.has(v.status)) return null;
  const balances = Array.isArray(v.balances)
    ? v.balances.filter(isObj).flatMap((b) => (typeof b.currency === "string" && typeof b.total === "string" ? [{ currency: b.currency, total: b.total }] : []))
    : [];
  return {
    status: v.status as DeepseekBalanceUsage["status"],
    available: typeof v.available === "boolean" ? v.available : null,
    balances,
    note: str(v.note),
    readAtMs: num(v.readAtMs),
  };
}

function toDelegation(v: unknown): DelegationEngineUsage | null {
  if (!isObj(v) || typeof v.engine !== "string") return null;
  const attempts = num(v.attempts);
  const ok = num(v.ok);
  const successPct = num(v.successPct);
  if (attempts === null || ok === null || successPct === null) return null;
  return { engine: v.engine, attempts, ok, successPct, costUsd: num(v.costUsd) };
}

/** Respuesta del backend validada: descarta motores o ventanas con forma inesperada. */
export function normalizeEngines(raw: unknown): EnginesPlanUsage {
  if (!isObj(raw) || !Array.isArray(raw.engines)) throw new Error("respuesta del uso de motores sin 'engines'");
  return {
    generatedAtMs: num(raw.generatedAtMs) ?? Date.now(),
    engines: raw.engines.map(toEngine).filter((e): e is EnginePlanUsage => e !== null),
    deepseek: toDeepseek(raw.deepseek),
    delegations: Array.isArray(raw.delegations) ? raw.delegations.map(toDelegation).filter((d): d is DelegationEngineUsage => d !== null) : null,
    delegationsError: str(raw.delegationsError),
  };
}

const LABELS: Record<string, string> = { five_hour: "5 h", seven_day: "Semana" };

export const engineWindowLabel = (kind: string): string => LABELS[kind] ?? kind;

/** `Codex · plus · hace 4 min`. */
export function engineHeader(e: EnginePlanUsage, now: number): string {
  const parts = [e.label];
  if (e.plan) parts.push(e.plan);
  if (e.readAtMs !== null) {
    const ago = minutesSince(e.readAtMs, now);
    parts.push(ago === 0 ? "hace menos de 1 min" : ago < 120 ? `hace ${ago} min` : `hace ${Math.round(ago / 60)} h`);
  }
  return parts.join(" · ");
}

/** `6 % · reinicia en 3 h 20 min`; reiniciada tras la lectura, uso desconocido. */
export function engineWindowText(w: EnginePlanWindow, now: number): string {
  if (w.expired || w.usedPct === null) return "reiniciada tras la lectura: uso desconocido";
  return w.resetsAtMs === null ? pct(w.usedPct) : `${pct(w.usedPct)} · ${resetText(w.resetsAtMs, now)}`;
}

/** Ventanas agrupadas por grupo de modelos (uno solo, sin nombre, en Codex). */
export function engineGroups(e: EnginePlanUsage): { group: string | null; windows: EnginePlanWindow[] }[] {
  const order = [...new Set(e.windows.map((w) => w.group))];
  return order.map((group) => ({ group, windows: e.windows.filter((w) => w.group === group) }));
}

const turns = (a: EnginePlanActivity): string => `${a.turns} ${a.turns === 1 ? "turno" : "turnos"} · ${formatTokens(a.tokens)} tokens`;

/** `5 h: 3 turnos · 12k tokens` y `7 días: …`. */
export function activityLines(a: NonNullable<EnginePlanUsage["activity"]>): string[] {
  return [`5 h: ${turns(a.fiveHour)}`, `7 días: ${turns(a.sevenDay)}`];
}

/** Texto cuando el motor no tiene dato. */
export function missingText(e: EnginePlanUsage): string {
  const base = e.status === "error" ? "no se pudo leer" : "sin dato";
  return e.note ? `${base}: ${e.note}` : base;
}

/** `12,40 USD` por moneda; sin saldo o sin dato, el motivo. */
export function deepseekText(b: DeepseekBalanceUsage): string {
  if (b.status === "none") return b.note ?? "sin DEEPSEEK_API_KEY";
  if (b.status === "error") return `no se pudo leer${b.note ? `: ${b.note}` : ""}`;
  const totals = b.balances.map((x) => `${x.total.replace(".", ",")} ${x.currency}`).join(" · ") || "saldo sin desglose";
  return b.available === false ? `${totals} · sin saldo` : totals;
}

const usd = (n: number): string => `${(n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)).replace(".", ",")} USD`;

/** `codex: 4 intentos · 75 % de éxito · 0,12 USD`. */
export function delegationLine(d: DelegationEngineUsage): string {
  const parts = [`${d.attempts} ${d.attempts === 1 ? "intento" : "intentos"}`, `${Math.round(d.successPct)} % de éxito`];
  if (d.costUsd !== null) parts.push(usd(d.costUsd));
  return `${d.engine}: ${parts.join(" · ")}`;
}
