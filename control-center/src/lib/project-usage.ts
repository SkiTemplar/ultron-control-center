// Cliente tipado del comando Tauri `project_usage`, que lanza
// `~/.ultron/scripts/project-usage.mjs <id> --days N --json` y agrega los
// transcripts de Claude Code del proyecto (coste nocional a precio de API).

import { invoke } from "@tauri-apps/api/core";

export interface UsageDay {
  day: string;
  costUsd: number;
  messages: number;
}

export interface UsageModel {
  model: string;
  messages: number;
  costUsd: number;
  priced: boolean;
  sharePct: number;
}

export interface UsageSource {
  messages: number;
  costUsd: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Contexto que cada llamada reenvia de media: lo que mas pesa en el coste. */
  avgContextTokens: number;
}

export interface ProjectUsage {
  ok: true;
  projectId: string;
  projectName: string;
  days: number;
  window: { from: string; to: string };
  dirs: number;
  totals: { costUsd: number; messages: number; sessions: number };
  byDay: UsageDay[];
  byModel: UsageModel[];
  bySource: { main: UsageSource; sub: UsageSource };
  unpricedModels: string[];
  notes: string[];
}

export interface UsageError {
  ok: false;
  error: { code: string; message: string };
}

export async function fetchProjectUsage(projectId: string, days = 30): Promise<ProjectUsage | UsageError> {
  return (await invoke("project_usage", { projectId, days })) as ProjectUsage | UsageError;
}

/** Importe en USD con coma decimal: 1234 -> "1234 $", 12,3 -> "12,3 $", 0,5 -> "0,50 $". */
export function formatUsd(n: number): string {
  const abs = Math.abs(n);
  const text = abs >= 100 ? Math.round(n).toString() : abs >= 10 ? n.toFixed(1) : n.toFixed(2);
  return `${text.replace(".", ",")} $`;
}

/** Tokens en miles: 312000 -> "312K". */
export function formatContext(tokens: number): string {
  return `${Math.round(tokens / 1000)}K`;
}

/** Coste de los ultimos `last` dias de la serie diaria. */
export function sumLastDays(byDay: UsageDay[], last: number): number {
  return byDay.slice(-last).reduce((acc, d) => acc + d.costUsd, 0);
}

/** Subtitulo de la tarjeta: "12 $ en 7 d · 48 $ en 30 d". */
export function usageSubtitle(u: ProjectUsage): string {
  if (u.totals.messages === 0) return "Sin uso registrado";
  return `${formatUsd(sumLastDays(u.byDay, 7))} en 7 d · ${formatUsd(u.totals.costUsd)} en ${u.days} d`;
}

/**
 * Aviso de subagentes caros: solo cuando pesan mucho en el total Y sus llamadas
 * arrastran un contexto largo (lo que dispara el coste). null = nada que decir.
 */
export function subagentHint(u: ProjectUsage): string | null {
  const total = u.totals.costUsd;
  const sub = u.bySource.sub;
  if (total <= 0 || sub.messages === 0) return null;
  const share = (sub.costUsd / total) * 100;
  if (share < 40 || sub.avgContextTokens < 150_000) return null;
  return `Los subagentes son el ${Math.round(share)} % del gasto y cada llamada arrastra ${formatContext(sub.avgContextTokens)} de contexto: los encargos largos cuestan mucho más que varios cortos.`;
}
