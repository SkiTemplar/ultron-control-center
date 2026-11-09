// Historial de delegaciones: filas con desenlace y resumen por motor (§2).

import { describe, expect, it } from "vitest";
import { buildLedgerRows, formatDuration, formatUsd, summarizeLedger } from "./delegationHistory";
import type { LedgerEntry } from "./delegationTypes";

const ENTRIES: LedgerEntry[] = [
  { ts: "2026-10-26T10:05:00Z", id: "d1", final: "merged" },
  {
    ts: "2026-10-26T10:04:00Z", id: "d1", attempt: 2, engine: "agy", tier: "standard",
    outcome: "ok", durationS: 125, costUsd: null, title: "Arreglar test",
  },
  {
    ts: "2026-10-26T10:01:00Z", id: "d1", attempt: 1, engine: "claude-p", tier: "standard",
    outcome: "engine-fail", durationS: 30, costUsd: 0.0015, title: "Arreglar test",
  },
  {
    ts: "2026-10-26T09:00:00Z", id: "d0", attempt: 1, engine: "deepseek", tier: "trivial",
    outcome: "skipped", skipReason: "missing-key",
  },
  {
    ts: "2026-10-26T09:01:00Z", id: "d0", attempt: 2, engine: "claude-p", tier: "trivial",
    outcome: "ok", durationS: 12, costUsd: 0.25, title: "Renombrar",
  },
];

describe("motivo del desenlace", () => {
  it("llega a la fila y distingue un alcance roto de una sospecha", () => {
    const [scope, suspect, plain] = buildLedgerRows([
      { ts: "t", id: "a", attempt: 1, engine: "agy", outcome: "check-fail", reason: "scope" },
      { ts: "t", id: "b", attempt: 1, engine: "agy", outcome: "ok", reason: "isolation-suspect", isolationSuspect: 3 },
      { ts: "t", id: "c", attempt: 1, engine: "agy", outcome: "ok" },
    ]);
    expect([scope.reason, scope.isolationSuspect]).toEqual(["scope", 0]);
    expect([suspect.reason, suspect.isolationSuspect]).toEqual(["isolation-suspect", 3]);
    expect([plain.reason, plain.isolationSuspect]).toEqual([null, 0]);
  });
});

describe("buildLedgerRows", () => {
  it("una fila por intento con el desenlace de su delegación", () => {
    const rows = buildLedgerRows(ENTRIES);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.delegationId === "d1").every((r) => r.final === "merged")).toBe(true);
    expect(rows.find((r) => r.delegationId === "d0")?.final).toBeNull();
  });

  it("hereda el título de otra línea de la misma delegación y el coste solo si es número", () => {
    const rows = buildLedgerRows(ENTRIES);
    const skipped = rows.find((r) => r.outcome === "skipped");
    expect(skipped?.title).toBe("Renombrar");
    expect(skipped?.skipReason).toBe("missing-key");
    expect(rows.find((r) => r.engine === "agy")?.costUsd).toBeNull();
  });

  it("las líneas de desenlace no generan filas", () => {
    expect(buildLedgerRows([{ ts: "x", id: "d9", final: "discarded" }])).toEqual([]);
  });
});

describe("summarizeLedger", () => {
  it("cuenta intentos sin los saltados, % de éxito y suma el coste", () => {
    const byEngine = Object.fromEntries(summarizeLedger(ENTRIES).map((s) => [s.engine, s]));
    expect(byEngine["claude-p"]).toMatchObject({ attempts: 2, ok: 1, successPct: 50, skipped: 0 });
    expect(byEngine["claude-p"].costUsd).toBeCloseTo(0.2515);
    expect(byEngine.agy).toMatchObject({ attempts: 1, ok: 1, successPct: 100, costUsd: null });
    expect(byEngine.deepseek).toMatchObject({ attempts: 0, skipped: 1, successPct: null });
  });

  it("vacío sin entradas", () => {
    expect(summarizeLedger([])).toEqual([]);
  });
});

describe("formatos", () => {
  it("formatUsd", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0015)).toBe("$0.0015");
    expect(formatUsd(1.5)).toBe("$1.50");
  });

  it("formatDuration", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(125)).toBe("2 min 5 s");
  });
});
