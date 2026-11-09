import { describe, expect, it } from "vitest";
import {
  formatContext,
  formatUsd,
  subagentHint,
  sumLastDays,
  usageSubtitle,
  type ProjectUsage,
  type UsageSource,
} from "./project-usage";

const src = (over: Partial<UsageSource> = {}): UsageSource => ({
  messages: 0,
  costUsd: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  avgContextTokens: 0,
  ...over,
});

function usage(over: Partial<ProjectUsage> = {}): ProjectUsage {
  const byDay = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-09-${String(i + 1).padStart(2, "0")}`,
    costUsd: i >= 23 ? 1 : 0, // solo los ultimos 7 dias tienen gasto
    messages: i >= 23 ? 10 : 0,
  }));
  return {
    ok: true,
    projectId: "demo",
    projectName: "Demo",
    days: 30,
    window: { from: "2026-09-01", to: "2026-09-30" },
    dirs: 1,
    totals: { costUsd: 7, messages: 70, sessions: 3 },
    byDay,
    byModel: [],
    bySource: { main: src({ messages: 70, costUsd: 7 }), sub: src() },
    unpricedModels: [],
    notes: [],
    ...over,
  };
}

describe("formatUsd", () => {
  it("usa coma decimal y menos decimales cuanto mayor es el importe", () => {
    expect(formatUsd(0.5)).toBe("0,50 $");
    expect(formatUsd(12.34)).toBe("12,3 $");
    expect(formatUsd(1234.6)).toBe("1235 $");
    expect(formatUsd(0)).toBe("0,00 $");
  });
});

describe("formatContext", () => {
  it("redondea a miles", () => {
    expect(formatContext(312_400)).toBe("312K");
    expect(formatContext(0)).toBe("0K");
  });
});

describe("sumLastDays / usageSubtitle", () => {
  it("suma solo la cola de la serie", () => {
    const u = usage();
    expect(sumLastDays(u.byDay, 7)).toBe(7);
    expect(sumLastDays(u.byDay, 3)).toBe(3);
    expect(sumLastDays(u.byDay, 30)).toBe(7);
  });
  it("resume 7 dias y la ventana completa", () => {
    expect(usageSubtitle(usage())).toBe("7,00 $ en 7 d · 7,00 $ en 30 d");
  });
  it("dice que no hay uso en vez de enseñar ceros", () => {
    expect(usageSubtitle(usage({ totals: { costUsd: 0, messages: 0, sessions: 0 } }))).toBe("Sin uso registrado");
  });
});

describe("subagentHint", () => {
  it("avisa con subagentes caros y contexto largo", () => {
    const hint = subagentHint(
      usage({
        totals: { costUsd: 100, messages: 100, sessions: 5 },
        bySource: { main: src({ messages: 20, costUsd: 30 }), sub: src({ messages: 80, costUsd: 70, avgContextTokens: 320_000 }) },
      }),
    );
    expect(hint).toContain("70 %");
    expect(hint).toContain("320K");
  });
  it("calla si los subagentes pesan poco", () => {
    expect(
      subagentHint(
        usage({
          totals: { costUsd: 100, messages: 100, sessions: 5 },
          bySource: { main: src({ costUsd: 80 }), sub: src({ messages: 10, costUsd: 20, avgContextTokens: 400_000 }) },
        }),
      ),
    ).toBeNull();
  });
  it("calla si el contexto es corto aunque pesen mucho", () => {
    expect(
      subagentHint(
        usage({
          totals: { costUsd: 100, messages: 100, sessions: 5 },
          bySource: { main: src({ costUsd: 20 }), sub: src({ messages: 80, costUsd: 80, avgContextTokens: 60_000 }) },
        }),
      ),
    ).toBeNull();
  });
  it("calla sin subagentes ni gasto", () => {
    expect(subagentHint(usage())).toBeNull();
    expect(subagentHint(usage({ totals: { costUsd: 0, messages: 0, sessions: 0 } }))).toBeNull();
  });
});
