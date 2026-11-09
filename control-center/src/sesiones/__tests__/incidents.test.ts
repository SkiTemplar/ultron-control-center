// Registro de incidentes: qué avisos se mandan al backend y cuándo un atasco es nuevo.
import { afterEach, describe, expect, it, vi } from "vitest";
import { addNote, reportError } from "../bootstrap";
import { newStalls, reportIncident, setIncidentSink, type IncidentReport } from "../incidents";
import { store } from "../store";
import type { SessionInfo, StallInfo } from "../types";

const stall = (reason: StallInfo["reason"], tool?: string): StallInfo => ({ reason, since: "2026-10-16T10:00:00Z", detail: "Bash lleva 2 min", ...(tool ? { tool } : {}) });
const session = (id: string, stalled: StallInfo | null) => ({ id, stalled }) as unknown as SessionInfo;

afterEach(() => setIncidentSink(null));

describe("avisos que se registran", () => {
  it("warn y error van al registro; info no", () => {
    const sink = vi.fn(async (_r: IncidentReport) => {});
    setIncidentSink(sink);
    addNote("s1", "info", "Modo de permisos: plan");
    addNote("s1", "warn", "La cola se ha parado");
    addNote("s1", "error", "No se pudo pasar Bash a segundo plano");
    expect(sink.mock.calls.map(([r]) => [r.level, r.text])).toEqual([
      ["warn", "La cola se ha parado"],
      ["error", "No se pudo pasar Bash a segundo plano"],
    ]);
    expect(sink.mock.calls[0][0]).toMatchObject({ id: "s1", origin: "note" });
  });

  it("un error global va sin sesión", () => {
    const sink = vi.fn(async (_r: IncidentReport) => {});
    setIncidentSink(sink);
    reportError(new Error("sesiones_list falló"));
    expect(sink).toHaveBeenCalledWith({ id: null, origin: "error", level: "error", text: "sesiones_list falló" });
  });

  it("sin destino no hace nada", () => {
    expect(() => reportIncident({ id: "s1", origin: "note", level: "warn", text: "x" })).not.toThrow();
  });

  it("si el registro falla avisa una sola vez con una nota info", async () => {
    setIncidentSink(async () => {
      throw new Error("disco lleno");
    });
    const notesBefore = store.getState().bySession["s9"]?.notes.length ?? 0;
    reportIncident({ id: "s9", origin: "note", level: "error", text: "a" });
    reportIncident({ id: "s9", origin: "note", level: "error", text: "b" });
    await new Promise((r) => setTimeout(r, 0));
    const notes = store.getState().bySession["s9"]?.notes ?? [];
    const added = notes.slice(notesBefore);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ level: "info", text: expect.stringContaining("disco lleno") });
  });
});

describe("newStalls", () => {
  it("un atasco que aparece es un incidente", () => {
    const { reports, seen } = newStalls(new Map(), [session("s1", stall("toolOverdue", "Bash")), session("s2", null)]);
    expect(reports).toEqual([{ id: "s1", origin: "stall", level: "warn", text: "toolOverdue: Bash lleva 2 min" }]);
    expect([...seen]).toEqual([["s1", "toolOverdue|Bash"]]);
  });

  it("el mismo atasco en la lista siguiente no se repite", () => {
    const first = newStalls(new Map(), [session("s1", stall("toolOverdue", "Bash"))]);
    expect(newStalls(first.seen, [session("s1", stall("toolOverdue", "Bash"))]).reports).toEqual([]);
  });

  it("otro motivo en la misma sesión sí es nuevo, y uno que vuelve tras resolverse también", () => {
    const a = newStalls(new Map(), [session("s1", stall("toolOverdue", "Bash"))]);
    const b = newStalls(a.seen, [session("s1", stall("tuiFrozen"))]);
    expect(b.reports).toHaveLength(1);
    const resolved = newStalls(b.seen, [session("s1", null)]);
    expect(resolved.seen.size).toBe(0);
    expect(newStalls(resolved.seen, [session("s1", stall("tuiFrozen"))]).reports).toHaveLength(1);
  });

  it("no muta el mapa anterior", () => {
    const prev = new Map<string, string>();
    newStalls(prev, [session("s1", stall("noEvents"))]);
    expect(prev.size).toBe(0);
  });
});
