import { describe, expect, it } from "vitest";
import { resultLine, splitStable } from "../components/chat/terminal-format";
import { engineBlockReason, opinionPrompt, OPINION_QUOTE_MAX } from "../engines";
import { broughtHeader, buildTimeline, sessionTasks } from "../timeline";
import type { ChatMessage, EngineTask } from "../types";

const msg = (uuid: string, role: ChatMessage["role"], minute: number): ChatMessage => ({
  uuid, role, agentId: null, timestamp: `2026-10-07T10:${String(minute).padStart(2, "0")}:00Z`, blocks: [{ kind: "text", text: uuid }],
});
const task = (id: string, minute: number, sessionId = "s1"): EngineTask => ({
  id, engine: "codex", kind: "opinion", mode: "local", cwd: "/p", prompt: "p", status: "done", events: [], sessionId,
  startedAt: `2026-10-07T10:${String(minute).padStart(2, "0")}:30Z`,
});

describe("línea de tiempo (E8)", () => {
  it("intercala intervenciones por hora y marca continuación y fin de turno", () => {
    const items = buildTimeline([msg("u1", "user", 1), msg("a1", "assistant", 2), msg("a2", "assistant", 3), msg("u2", "user", 5)], [task("t1", 3)]);
    expect(items.map((i) => i.key)).toEqual(["u1", "a1", "a2", "e:t1", "u2"]);
    const a1 = items[1];
    const a2 = items[2];
    expect(a1.kind === "msg" && a1.endsTurn).toBe(false);
    expect(a2.kind === "msg" && a2.continued && a2.endsTurn).toBe(true);
  });

  it("una intervención lanzada a mitad de turno no lo parte: va al cierre del turno", () => {
    const tool: ChatMessage = { ...msg("r1", "user", 3), blocks: [{ kind: "toolResult", toolUseId: "x", isError: false, text: "ok" }] };
    const items = buildTimeline([msg("u1", "user", 1), msg("a1", "assistant", 2), tool, msg("a2", "assistant", 4), msg("u2", "user", 6)], [task("t1", 2)]);
    expect(items.map((i) => i.key)).toEqual(["u1", "a1", "r1", "a2", "e:t1", "u2"]);
  });

  it("sin prompt posterior la intervención queda al final (caso negativo: no se intercala)", () => {
    const items = buildTimeline([msg("a1", "assistant", 1), msg("a2", "assistant", 4)], [task("t1", 2)]);
    expect(items.map((i) => i.key)).toEqual(["a1", "a2", "e:t1"]);
  });

  it("resume la actividad del turno en su primera respuesta", () => {
    const use = (uuid: string, minute: number, name: string): ChatMessage => ({ ...msg(uuid, "assistant", minute), blocks: [{ kind: "toolUse", id: `${uuid}-t`, name, input: {}, summary: "" }] });
    const items = buildTimeline([msg("u1", "user", 1), use("a1", 2, "Bash"), use("a2", 3, "Edit"), use("a3", 4, "Bash"), msg("a4", "assistant", 5), msg("u2", "user", 6), msg("a5", "assistant", 7)], []);
    const first = items[1];
    expect(first.kind === "msg" && first.activity).toEqual({ tools: 3, byName: [["Bash", 2], ["Edit", 1]], toolIds: ["a1-t", "a2-t", "a3-t"] });
    expect(items.filter((i) => i.kind === "msg" && i.activity).map((i) => i.key)).toEqual(["a1", "a5"]);
    const last = items[6];
    expect(last.kind === "msg" && last.turn).toBe("u2");
    expect(last.kind === "msg" && last.activity?.tools).toBe(0);
  });

  it("el fin de turno es la última respuesta aunque haya resultados de herramienta en medio, con tokens y gasto", () => {
    const usage = { input: 1000, output: 500, cacheRead: 100_000, cacheWrite: 2000 };
    const a = (uuid: string, minute: number): ChatMessage => ({ ...msg(uuid, "assistant", minute), model: "claude-opus-5-5[1m]", usage });
    const tool: ChatMessage = { ...msg("r1", "user", 3), blocks: [{ kind: "toolResult", toolUseId: "x", isError: false, text: "ok" }] };
    const items = buildTimeline([msg("u1", "user", 1), a("a1", 2), tool, a("a2", 4), msg("u2", "user", 6)], []);
    const ends = items.filter((i) => i.kind === "msg" && i.endsTurn).map((i) => i.key);
    expect(ends).toEqual(["a2"]);
    const last = items.find((i) => i.key === "a2");
    expect(last?.kind === "msg" && last.stats?.usage).toEqual({ input: 2000, output: 1000, cacheRead: 200_000, cacheWrite: 4000 });
    // Opus 5.5 sin desglose de caché (cuenta como 5 min, 1,25×): (2000·4 + 1000·20 + 200000·0,2 + 4000·4·1,25) / 1e6
    expect(last?.kind === "msg" && last.stats?.costUsd).toBeCloseTo(0.088, 6);
  });

  it("sin precio para el modelo el gasto queda en null (caso negativo)", () => {
    const m: ChatMessage = { ...msg("a1", "assistant", 2), model: "modelo-raro", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    const item = buildTimeline([msg("u1", "user", 1), m], []).find((i) => i.key === "a1");
    expect(item?.kind === "msg" && item.stats?.costUsd).toBeNull();
  });

  it("reconoce el mensaje pegado por «Traer a Claude» y no otros (caso negativo)", () => {
    expect(broughtHeader("Resultado de Codex (Dime hola):\n¡Hola!")).toBe("Resultado de Codex");
    expect(broughtHeader("Segunda opinión de Gemini (x):\ny")).toBe("Segunda opinión de Gemini");
    expect(broughtHeader("El resultado de Codex (ayer) fue malo")).toBeNull();
  });

  it("filtra por sesión y oculta las descartadas (caso negativo)", () => {
    const list = sessionTasks([task("b", 5), task("a", 1), task("otra", 2, "s2"), task("fuera", 3)], "s1", ["fuera"]);
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("motores (E8)", () => {
  it("da el motivo si el motor no está y no bloquea mientras no se sepa", () => {
    expect(engineBlockReason(null, "gemini")).toBeNull();
    expect(engineBlockReason([{ id: "gemini", available: false, reason: "agy no está en el PATH" }], "gemini")).toBe("agy no está en el PATH");
    expect(engineBlockReason([{ id: "codex", available: true }], "gemini")).toMatch(/no aparece/);
    expect(engineBlockReason([{ id: "codex", available: true }], "codex")).toBeNull();
  });

  it("recorta la respuesta citada en la segunda opinión", () => {
    const p = opinionPrompt("x".repeat(OPINION_QUOTE_MAX + 50));
    expect(p).toContain("[…recortado]");
    expect(p.length).toBeLessThan(OPINION_QUOTE_MAX + 400);
  });
});

describe("vista de terminal (E2)", () => {
  it("resume el resultado de la herramienta en la línea ⎿", () => {
    const ok = (text: string) => ({ kind: "toolResult" as const, toolUseId: "t", isError: false, text });
    expect(resultLine("Read", ok("a\nb\nc"), null)).toBe("Leídas 3 líneas");
    expect(resultLine("Grep", ok(""), null)).toBe("Sin coincidencias");
    expect(resultLine("Edit", ok("ok"), { added: 3, removed: 1 })).toBe("Actualizado: +3 −1");
    expect(resultLine("Bash", ok("PASS\nmás\nfin"), null)).toBe("PASS  … +2 líneas");
    expect(resultLine("Bash", { ...ok("boom\ntraza"), isError: true }, null)).toBe("Error: boom");
    expect(resultLine("Bash", undefined, null, true)).toBe("En curso…");
  });

  it("no corta una lista, una cita ni una continuación sangrada; dos párrafos sí (F12)", () => {
    expect(splitStable("1. a\n\n2. b")).toEqual({ stable: "", tail: "1. a\n\n2. b" });
    expect(splitStable("- a\n\n  - b")).toEqual({ stable: "", tail: "- a\n\n  - b" });
    expect(splitStable("> cita\n\n> sigue")).toEqual({ stable: "", tail: "> cita\n\n> sigue" });
    expect(splitStable("uno\n\ndos\n\ntres").stable).toBe("uno\n\ndos\n\n");
  });

  it("corta el streaming por párrafos cerrados y nunca dentro de un bloque de código", () => {
    expect(splitStable("uno\n\ndos")).toEqual({ stable: "uno\n\n", tail: "dos" });
    expect(splitStable("sin cierre")).toEqual({ stable: "", tail: "sin cierre" });
    const fenced = "intro\n\n```ts\nconst a = 1\n\nconst b = 2";
    expect(splitStable(fenced)).toEqual({ stable: "intro\n\n", tail: "```ts\nconst a = 1\n\nconst b = 2" });
  });
});

