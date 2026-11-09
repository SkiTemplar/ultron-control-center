import { describe, expect, it } from "vitest";
import { costOf } from "../pricing";
import { buildTimelineParts, currentTurnActivity, opensTurn, statsOfTurn } from "../timeline";
import type { ChatMessage, EngineTask, TurnPayload } from "../types";

const at = (minute: number) => `2026-10-08T10:${String(minute).padStart(2, "0")}:00Z`;
const msg = (uuid: string, role: ChatMessage["role"], minute: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  uuid, role, agentId: null, timestamp: at(minute), blocks: [{ kind: "text", text: uuid }], ...extra,
});
const task = (id: string, minute: number, anchor?: string): EngineTask => ({
  id, engine: "codex", kind: "task", mode: "local", cwd: "/p", prompt: "p", status: "done", events: [], sessionId: "s1",
  startedAt: `2026-10-08T10:${String(minute).padStart(2, "0")}:30Z`, anchorMessageUuid: anchor,
});
const tool = (uuid: string, minute: number, id: string, name = "Bash"): ChatMessage => ({
  ...msg(uuid, "assistant", minute), blocks: [{ kind: "toolUse", id, name, input: {}, summary: "" }],
});

describe("línea de tiempo v3 (§5.1, §5.6)", () => {
  it("un prompt absorbido a mitad de turno no abre turno y el motor anclado va al cierre del turno (F03)", () => {
    const q = msg("q", "user", 3, { queued: true });
    const parts = buildTimelineParts([msg("u1", "user", 1), tool("a1", 2, "t1"), q, tool("a2", 4, "t2"), msg("u2", "user", 6)], [task("e1", 2, "a1")]);
    expect(parts.items.map((i) => i.key)).toEqual(["u1", "a1", "q", "a2", "e:e1", "u2"]);
    const withActivity = parts.items.filter((i) => i.kind === "msg" && i.activity);
    expect(withActivity.map((i) => i.key)).toEqual(["a1"]);
    expect(opensTurn(q)).toBe(false);
  });

  it("sin prompt posterior y con el turno abierto, la intervención queda pendiente tras la burbuja (F04)", () => {
    const parts = buildTimelineParts([msg("u1", "user", 1), msg("a1", "assistant", 2)], [task("e1", 2, "a1")], { lastTurnOpen: true });
    expect(parts.pendingEngines.map((t) => t.id)).toEqual(["e1"]);
    expect(parts.items.some((i) => i.kind === "engine")).toBe(false);
  });

  it("con el turno cerrado la intervención se integra al final (caso negativo de pendientes)", () => {
    const parts = buildTimelineParts([msg("u1", "user", 1), msg("a1", "assistant", 2)], [task("e1", 2, "a1")], { lastTurnOpen: false });
    expect(parts.pendingEngines).toEqual([]);
    expect(parts.items.map((i) => i.key)).toEqual(["u1", "a1", "e:e1"]);
  });

  it("un mensaje de sistema dentro del turno no corta la respuesta: una sola cabecera (F13)", () => {
    const sys = msg("sys", "system", 3, { kind: "interrupted" });
    const parts = buildTimelineParts([msg("u1", "user", 1), msg("a1", "assistant", 2), sys, msg("a2", "assistant", 4)], []);
    const a2 = parts.items.find((i) => i.key === "a2");
    expect(a2?.kind === "msg" && a2.continued).toBe(true);
    const s = parts.items.find((i) => i.key === "sys");
    expect(s?.kind === "msg" && s.inTurn).toBe(true);
    const a1 = parts.items.find((i) => i.key === "a1");
    expect(a1?.kind === "msg" && a1.activity?.system).toBe(1);
  });

  it("«[Request interrupted by user]» y los comandos no abren turno (caso negativo: un prompt sí)", () => {
    expect(opensTurn(msg("x", "user", 1, { blocks: [{ kind: "text", text: "[Request interrupted by user]" }] }))).toBe(false);
    expect(opensTurn(msg("c", "user", 1, { kind: "command" }))).toBe(false);
    expect(opensTurn(msg("p", "user", 1, { kind: "prompt" }))).toBe(true);
    expect(opensTurn(msg("p2", "user", 1))).toBe(true);
  });

  it("las notas del cliente van en su posición cronológica", () => {
    const note = { id: "n1", at: "2026-10-08T10:02:30Z", level: "info" as const, text: "nota" };
    const parts = buildTimelineParts([msg("u1", "user", 1), msg("a1", "assistant", 2), msg("u2", "user", 3)], [], { notes: [note] });
    expect(parts.items.map((i) => i.key)).toEqual(["u1", "a1", "n:n1", "u2"]);
  });

  it("el gasto del turno sale del evento turn: principal más subagentes (USO-01, R17)", () => {
    const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
    const sub = { input: 500, output: 200, cacheRead: 0, cacheWrite: 0 };
    const payload: TurnPayload = { id: "s1", turnId: "T1", startedAt: at(1), endedAt: at(2), durationMs: 60000, reason: "answer", usage, subagentUsage: [sub] };
    const stats = statsOfTurn(payload, "claude-opus-5-5");
    expect(stats?.usage.output).toBe(300);
    expect(stats?.costUsd).toBeCloseTo((costOf("claude-opus-5-5", usage) ?? 0) + (costOf("claude-opus-5-5", sub) ?? 0), 9);
    const a1 = msg("a1", "assistant", 2, { streamKey: "T1:main:0:0", model: "claude-opus-5-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
    const item = buildTimelineParts([msg("u1", "user", 1), a1], [], { turns: [payload] }).items.find((i) => i.key === "a1");
    expect(item?.kind === "msg" && item.stats?.usage.output).toBe(300);
  });

  it("sin evento turn, el gasto se calcula con los mensajes (caso negativo)", () => {
    const a1 = msg("a1", "assistant", 2, { model: "claude-opus-5-5", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
    const item = buildTimelineParts([msg("u1", "user", 1), a1], []).items.find((i) => i.key === "a1");
    expect(item?.kind === "msg" && item.stats?.usage.output).toBe(5);
  });

  it("la actividad en vivo cuenta los ids del turno en curso más los vivos no persistidos (F14)", () => {
    const messages = [msg("u0", "user", 0), tool("a0", 0, "old"), msg("u1", "user", 1), tool("a1", 2, "t1"), tool("a2", 3, "t2", "Edit")];
    const live = [{ toolUseId: "t2", name: "Edit", agentId: null }, { toolUseId: "t3", name: "Read", agentId: null }];
    const act = currentTurnActivity(messages, live);
    expect(act.tools).toBe(3);
    expect(act.toolIds).toEqual(["t1", "t2", "t3"]);
  });
});
