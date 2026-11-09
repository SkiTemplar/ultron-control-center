import { describe, expect, it } from "vitest";
import {
  agendaText,
  DESK_TTL_MS,
  calendarNotice,
  dueKey,
  keepAnnounced,
  keepTargets,
  mergeDesk,
  nextDue,
  noticeText,
  outranks,
  resolveTarget,
  type DeskAlert,
  type DueSoon,
} from "../deskAlerts";

const alert = (over: Partial<DeskAlert> = {}): DeskAlert => ({
  seq: 1,
  source: "build",
  state: "failed",
  what: "cargo check",
  detail: "error[E0308]: mismatched types",
  cwd: "C:\\demo\\Arcadia",
  projectHint: "Arcadia",
  claudeSessionId: "c-1",
  at: "2030-03-10T10:00:00Z",
  ...over,
});

describe("resolveTarget", () => {
  const sessions = [
    { projectId: "p-arcadia", claudeSessionId: "c-1", cwd: "C:\\demo\\Arcadia" },
    { projectId: "p-otro", claudeSessionId: "c-2", cwd: "C:\\demo\\Otro" },
  ];

  it("una sesión de Sessions lleva a Sessions en su proyecto", () => {
    expect(resolveTarget(alert(), sessions)).toEqual({ kind: "sesiones", projectId: "p-arcadia" });
  });

  it("sin sesión coincidente va al editor con el nombre del proyecto (negativo)", () => {
    expect(resolveTarget(alert({ claudeSessionId: "c-cli" }), sessions)).toEqual({ kind: "editor", hint: "Arcadia" });
    expect(resolveTarget(alert({ claudeSessionId: null }), sessions)).toEqual({ kind: "editor", hint: "Arcadia" });
  });
});

describe("mergeDesk", () => {
  it("un fallo nuevo queda pendiente y es el aviso fresco", () => {
    const r = mergeDesk([], [alert()], 1000);
    expect(r.pending).toHaveLength(1);
    expect(r.fresh?.seq).toBe(1);
  });

  it("un cleared retira el fallo del mismo sitio y no avisa", () => {
    const first = mergeDesk([], [alert()], 1000);
    const r = mergeDesk(first.pending, [alert({ seq: 2, state: "cleared", detail: "" })], 2000);
    expect(r.pending).toEqual([]);
    expect(r.fresh).toBeNull();
  });

  it("un cleared de otro proyecto no toca el pendiente (negativo)", () => {
    const first = mergeDesk([], [alert()], 1000);
    const r = mergeDesk(first.pending, [alert({ seq: 2, state: "cleared", cwd: "C:\\demo\\Otro" })], 2000);
    expect(r.pending).toHaveLength(1);
  });

  it("fallo y arreglo en el mismo lote no dejan aviso fresco", () => {
    const r = mergeDesk([], [alert(), alert({ seq: 2, state: "cleared" })], 1000);
    expect(r.fresh).toBeNull();
    expect(r.pending).toEqual([]);
  });

  it("los pendientes caducan", () => {
    const first = mergeDesk([], [alert()], 0);
    expect(mergeDesk(first.pending, [], DESK_TTL_MS - 1).pending).toHaveLength(1);
    expect(mergeDesk(first.pending, [], DESK_TTL_MS).pending).toEqual([]);
  });
});

describe("textos del bocadillo", () => {
  it("tests y builds nombran el fallo y el proyecto", () => {
    expect(noticeText(alert({ source: "tests", what: "tests", detail: "cola::drena y 2 más", projectHint: "ultron" }))).toBe(
      "Tests en rojo en «ultron»: cola::drena y 2 más.",
    );
    expect(noticeText(alert())).toBe("cargo check falla en «Arcadia»: error[E0308]: mismatched types");
  });

  it("se trunca con puntos suspensivos", () => {
    const t = noticeText(alert({ detail: "é".repeat(400) }));
    expect(t.length).toBe(140);
    expect(t.endsWith("…")).toBe(true);
  });

  it("calendario: mañana con hora y hoy de todo el día", () => {
    const due = new Date(2030, 2, 11, 23, 59).toISOString();
    const d: DueSoon = { subject: "XYZ1", title: "Práctica 7", due, allDay: false, when: "tomorrow" };
    expect(calendarNotice(d)).toBe("Mañana, 23:59 — entrega de XYZ1: Práctica 7.");
    expect(calendarNotice({ ...d, when: "today", allDay: true })).toBe("Hoy — entrega de XYZ1: Práctica 7.");
  });

  it("la entrega de hoy va antes que la de mañana", () => {
    const base: DueSoon = { subject: "A", title: "t", due: "2030-03-11T10:00:00Z", allDay: false, when: "tomorrow" };
    const hoy = { ...base, subject: "B", due: "2030-03-10T22:00:00Z", when: "today" as const };
    expect(nextDue([base, hoy])?.subject).toBe("B");
    expect(nextDue([])).toBeNull();
  });
});

describe("prioridad entre avisos", () => {
  it("el calendario no pisa un fallo de build (negativo)", () => {
    expect(outranks("calendar", "build")).toBe(false);
  });

  it("un fallo pisa el calendario y la espera de Sessions manda sobre todo", () => {
    expect(outranks("build", "calendar")).toBe(true);
    expect(outranks("sessions", "build")).toBe(true);
    expect(outranks("turn", "build")).toBe(false);
    expect(outranks("calendar", null)).toBe(true);
  });
});

describe("poda de destinos y entregas anunciadas", () => {
  const due = (over: Partial<DueSoon> = {}): DueSoon => ({
    subject: "XYZ1", title: "Práctica", due: "2030-03-10T21:59:00Z", allDay: false, when: "today", ...over,
  });

  it("solo quedan los destinos de avisos pendientes", () => {
    const targets = new Map([
      [1, { kind: "editor" as const, hint: "A" }],
      [2, { kind: "sesiones" as const, projectId: "p" }],
    ]);
    const kept = keepTargets(targets, [{ alert: alert({ seq: 2 }), sinceMs: 0 }]);
    expect([...kept.keys()]).toEqual([2]);
    expect(targets.size).toBe(2); // no muta el original
    expect(keepTargets(targets, []).size).toBe(0);
  });

  it("solo quedan las entregas anunciadas que siguen siendo de hoy o mañana", () => {
    const hoy = due();
    const ayer = due({ subject: "OLD1", due: "2030-03-09T21:59:00Z" });
    const announced = new Set([dueKey(hoy), dueKey(ayer)]);
    expect([...keepAnnounced(announced, [hoy])]).toEqual([dueKey(hoy)]);
    // Al pasar de «mañana» a «hoy» la clave cambia: la anterior se olvida.
    const manana = due({ when: "tomorrow" });
    expect([...keepAnnounced(new Set([dueKey(manana)]), [hoy])]).toEqual([]);
  });
});

describe("agendaText", () => {
  const d = (subject: string, when: "today" | "tomorrow", h: number) => ({
    subject, title: "Práctica", due: new Date(2026, 9, 18, h, 0).toISOString(), allDay: false, when,
  });

  it("hoy antes que mañana, una por línea, y recorta a 4", () => {
    const text = agendaText([d("M1", "tomorrow", 9), d("H1", "today", 20), d("H2", "today", 10), d("M2", "tomorrow", 8), d("M3", "tomorrow", 7)]);
    const lines = text.split("\n");
    expect(lines[0]).toContain("H2");
    expect(lines[1]).toContain("H1");
    expect(lines[2]).toContain("M3");
    expect(lines[4]).toBe("y 1 más.");
  });

  it("sin entregas dice que no hay nada", () => {
    expect(agendaText([])).toMatch(/^Nada/);
  });
});
