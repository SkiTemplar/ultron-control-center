// Ayudas puras de la tarjeta de Workflow: runId de la llamada, estado de la
// notificación final, tiempos, progreso y el reducer de runs.

import { describe, expect, it } from "vitest";
import { demoRun } from "../mock/workflow-demo";
import { initialState, reducer } from "../reducer";
import type { ChatMessage } from "../types";
import { activePhase, effectiveStatus, elapsedMs, formatElapsed, notifiedStatus, runIdFromWorkflowTool, runProgress } from "../workflows";

function notification(toolUseId: string, status: string, kind: ChatMessage["kind"] = "taskNotification"): ChatMessage {
  const text = `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`;
  return { uuid: `n-${toolUseId}-${status}`, role: "user", timestamp: "2026-10-16T09:00:00Z", agentId: null, kind, blocks: [{ kind: "text", text }] };
}

describe("runIdFromWorkflowTool", () => {
  it("lee el Run ID del resultado de la llamada", () => {
    expect(runIdFromWorkflowTool({}, "Workflow launched in background.\nRun ID: wf_ab12-3cd\nTo resume…")).toBe("wf_ab12-3cd");
  });
  it("sin Run ID en el texto ni resumeFromRunId, null", () => {
    expect(runIdFromWorkflowTool({ scriptPath: "x.js" }, "Workflow launched in background.")).toBeNull();
    expect(runIdFromWorkflowTool(null, undefined)).toBeNull();
  });
  it("un Run ID de más de 77 caracteres no se trunca: no hay runId", () => {
    const long = `wf_${"a".repeat(80)}`;
    expect(runIdFromWorkflowTool({}, `Run ID: ${long}\nTo resume…`)).toBeNull();
    expect(runIdFromWorkflowTool({}, `Run ID: wf_${"a".repeat(77)}\n`)).toBe(`wf_${"a".repeat(77)}`);
  });
  it("al reanudar usa resumeFromRunId, y solo si es un runId válido", () => {
    expect(runIdFromWorkflowTool({ resumeFromRunId: "wf_old-001" }, undefined)).toBe("wf_old-001");
    expect(runIdFromWorkflowTool({ resumeFromRunId: "../../etc" }, undefined)).toBeNull();
  });
});

describe("notifiedStatus", () => {
  it("toma el estado de la notificación de esa llamada", () => {
    const msgs = [notification("toolu_otro", "failed"), notification("toolu_1", "completed")];
    expect(notifiedStatus(msgs, "toolu_1")).toBe("completed");
    expect(notifiedStatus(msgs, "toolu_otro")).toBe("failed");
  });
  it("ignora mensajes que no son notificaciones y estados desconocidos", () => {
    expect(notifiedStatus([notification("toolu_1", "completed", "meta")], "toolu_1")).toBeNull();
    expect(notifiedStatus([notification("toolu_1", "rarisimo")], "toolu_1")).toBeNull();
    expect(notifiedStatus([], "toolu_1")).toBeNull();
  });
  it("solo corrige un run que el disco aún da por en curso", () => {
    expect(effectiveStatus(demoRun(2), "completed")).toBe("completed");
    expect(effectiveStatus(demoRun(5), "failed")).toBe("completed");
    expect(effectiveStatus(demoRun(2), null)).toBe("running");
  });
});

/** Mensaje que cuenta cuántas veces se lee su `kind` (una lectura = un recorrido). */
function counted(m: ChatMessage, reads: { n: number }): ChatMessage {
  return Object.defineProperty({ ...m }, "kind", { get: () => { reads.n += 1; return m.kind; } });
}

describe("notifiedStatus indexado", () => {
  it("con la misma lista no la vuelve a recorrer, ni por fila ni por cambio del store", () => {
    const reads = { n: 0 };
    const msgs = [notification("toolu_1", "completed"), notification("toolu_2", "failed")].map((m) => counted(m, reads));
    expect(notifiedStatus(msgs, "toolu_1")).toBe("completed");
    const first = reads.n;
    expect(notifiedStatus(msgs, "toolu_2")).toBe("failed");
    expect(notifiedStatus(msgs, "toolu_1")).toBe("completed");
    expect(reads.n).toBe(first);
  });
  it("al añadir mensajes solo recorre los nuevos y la última notificación manda", () => {
    const reads = { n: 0 };
    const base = Array.from({ length: 50 }, (_, i) => counted(notification(`toolu_${i}`, "failed", "meta"), reads));
    const msgs = [counted(notification("toolu_1", "failed"), reads), ...base];
    expect(notifiedStatus(msgs, "toolu_1")).toBe("failed");
    const before = reads.n;
    const streamed = [...msgs, counted(notification("toolu_x", "completed", "meta"), reads)];
    expect(notifiedStatus(streamed, "toolu_1")).toBe("failed");
    expect(reads.n - before).toBe(1);
    const next = [...streamed, counted(notification("toolu_1", "completed"), reads)];
    expect(notifiedStatus(next, "toolu_1")).toBe("completed");
    expect(reads.n - before).toBe(2);
    expect(notifiedStatus(msgs, "toolu_1")).toBe("failed");
  });
  it("si cambia un mensaje intermedio reconstruye el índice (caso negativo del atajo)", () => {
    const msgs = [notification("toolu_1", "failed"), notification("toolu_2", "completed")];
    expect(notifiedStatus(msgs, "toolu_1")).toBe("failed");
    const replaced = [notification("toolu_1", "killed"), msgs[1], notification("toolu_3", "stopped")];
    expect(notifiedStatus(replaced, "toolu_1")).toBe("killed");
    expect(notifiedStatus(replaced, "toolu_3")).toBe("stopped");
    expect(notifiedStatus(replaced, "toolu_9")).toBeNull();
  });
});

describe("tiempos y progreso", () => {
  it("formatElapsed en s, min y h", () => {
    expect(formatElapsed(null)).toBe("—");
    expect(formatElapsed(42_000)).toBe("42 s");
    expect(formatElapsed(125_000)).toBe("2 min 05 s");
    expect(formatElapsed(3_900_000)).toBe("1 h 05 min");
  });
  it("en curso cuenta hasta ahora; cerrado usa la duración", () => {
    expect(elapsedMs({ startedAt: 1000, durationMs: null }, true, 6000)).toBe(5000);
    expect(elapsedMs({ startedAt: 1000, durationMs: 300 }, false, 6000)).toBe(300);
    expect(elapsedMs({ startedAt: null, durationMs: null }, true, 6000)).toBeNull();
  });
  it("progreso y fase activa del run de demostración", () => {
    const r = demoRun(3);
    expect(runProgress(r)).toEqual({ done: 2, failed: 0, total: 3 });
    expect(activePhase(r)).toBe(2);
    expect(activePhase(demoRun(5))).toBeNull();
  });
});

describe("reducer de runs", () => {
  it("upsert por runId sin perder los demás; la lista no pisa lo llegado en vivo", () => {
    const otro = { ...demoRun(1), runId: "wf_otro-1" };
    let s = reducer(initialState, { type: "workflow", id: "s1", run: demoRun(2) });
    s = reducer(s, { type: "workflow", id: "s1", run: otro });
    s = reducer(s, { type: "workflow", id: "s1", run: demoRun(3) });
    expect(Object.keys(s.bySession.s1.workflows).sort()).toEqual(["wf_demo-001", "wf_otro-1"]);
    expect(s.bySession.s1.workflows["wf_demo-001"].agents).toHaveLength(3);
    expect(s.bySession.s1.workflowsLoaded).toBe(false);
    s = reducer(s, { type: "workflows", id: "s1", runs: [demoRun(1), { ...demoRun(1), runId: "wf_disco-1" }] });
    expect(s.bySession.s1.workflows["wf_demo-001"].agents).toHaveLength(3);
    expect(s.bySession.s1.workflows["wf_disco-1"]).toBeDefined();
    expect(s.bySession.s1.workflowsLoaded).toBe(true);
  });
  it("un reset vacía los runs de la conversación anterior", () => {
    let s = reducer(initialState, { type: "workflows", id: "s1", runs: [demoRun(2)] });
    s = reducer(s, { type: "reset", id: "s1" });
    expect(s.bySession.s1.workflows).toEqual({});
    expect(s.bySession.s1.workflowsLoaded).toBe(false);
  });
});
