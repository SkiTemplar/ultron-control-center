// Delegaciones de Claude en Codex y Antigravity por Bash: salen en el árbol de
// Agentes con su estado; las órdenes que solo consultan la CLI no.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Agentes } from "../components/inspector/Agentes";
import { EXTERNAL_MAX, externalRuns } from "../components/inspector/externos";
import { SESSIONS } from "../mock/data";
import { store } from "../store";
import type { ChatMessage } from "../types";

let n = 0;
function bash(command: string, extra: Record<string, unknown> = {}): ChatMessage {
  n += 1;
  return {
    uuid: `u${n}`, role: "assistant", timestamp: "2026-10-19T10:00:00.000Z", agentId: null,
    blocks: [{ kind: "toolUse", id: `t${n}`, name: "Bash", input: { command, ...extra }, summary: command }],
  };
}

function result(toolUseId: string, isError = false): ChatMessage {
  return {
    uuid: `r${toolUseId}`, role: "user", timestamp: "2026-10-19T10:00:01.000Z", agentId: null,
    blocks: [{ kind: "toolResult", toolUseId, isError, text: "" }],
  };
}

describe("externalRuns", () => {
  it("detecta Codex y AGY y su estado", () => {
    const codex = bash('node "C:/x/codex-companion.mjs" task --model gpt-6-astra', { description: "Rescate con Codex" });
    const agy = bash('cd ~/p && agy --model gemini-3.8-flash-high --mode plan -p "barre el módulo"');
    const exec = bash("codex exec -m gpt-6-astra - < prompt.txt", { run_in_background: true });
    const fallo = bash('timeout 300 agy -p "x"');
    const runs = externalRuns([codex, agy, exec, fallo, result("t" + (n - 3)), result("t" + (n - 1)), result("t" + n, true)]);
    expect(runs.map((r) => [r.label, r.status])).toEqual([
      ["Codex", "done"],
      ["AGY", "running"],
      ["Codex", "background"],
      ["AGY", "error"],
    ]);
    expect(runs[0].description).toBe("Rescate con Codex");
  });

  it("caso negativo: consultas de la CLI y menciones no son delegaciones", () => {
    const runs = externalRuns([
      bash("codex --version"),
      bash("codex debug models 2>/dev/null"),
      bash("timeout 30 agy models 2>&1 | head"),
      bash("agy --help"),
      bash("grep -rn codex src; ls ~/.agy"),
      bash("cd ~/.ultron/mods; for m in agentes codex; do echo $m; done"),
    ]);
    expect(runs).toEqual([]);
  });

  it("caduca la delegación sin resultado cuando el turno acaba o la sesión se para", () => {
    const sinResultado = bash('agy -p "x"');
    const prompt: ChatMessage = {
      uuid: `p${n}`, role: "user", kind: "prompt", timestamp: "2026-10-19T10:05:00.000Z", agentId: null,
      blocks: [{ kind: "text", text: "sigue con otra cosa" }],
    };
    expect(externalRuns([sinResultado], "working")[0].status).toBe("running");
    expect(externalRuns([sinResultado], "waiting")[0].status).toBe("running");
    expect(externalRuns([sinResultado, prompt], "working")[0].status).toBe("expired");
    expect(externalRuns([sinResultado], "idle")[0].status).toBe("expired");
    expect(externalRuns([sinResultado], "exited")[0].status).toBe("expired");
    const corte: ChatMessage = { ...prompt, uuid: `i${n}`, kind: undefined, blocks: [{ kind: "text", text: "[Request interrupted by user]" }] };
    expect(externalRuns([sinResultado, corte], "working")[0].status).toBe("expired");
  });

  it("caso negativo: con resultado no caduca, y un prompt de otro hilo no cierra el turno", () => {
    const conResultado = bash('agy -p "x"');
    const ok = result(`t${n}`);
    const otra = bash("codex exec -");
    const otroHilo: ChatMessage = {
      uuid: `s${n}`, role: "user", kind: "prompt", timestamp: "2026-10-19T10:05:00.000Z", agentId: "sub1",
      blocks: [{ kind: "text", text: "prompt del subagente" }],
    };
    const runs = externalRuns([conResultado, ok, otra, otroHilo], "idle");
    expect(runs[0].status).toBe("done");
    expect(externalRuns([conResultado, ok, otra, otroHilo], "working").map((r) => r.status)).toEqual(["done", "running"]);
  });

  it("solo las últimas EXTERNAL_MAX", () => {
    const msgs = Array.from({ length: EXTERNAL_MAX + 3 }, () => bash("codex exec -"));
    expect(externalRuns(msgs)).toHaveLength(EXTERNAL_MAX);
  });
});

describe("Agentes", () => {
  it("pinta las delegaciones externas en el árbol", () => {
    const session = SESSIONS[0];
    store.dispatch({ type: "messages", id: session.id, messages: [bash('agy -p "resume"', { description: "Lectura con AGY" })] });
    render(<Agentes session={session} currentAgent={null} />);
    expect(screen.getByText("Lectura con AGY")).toBeTruthy();
    expect(screen.getByText("AGY")).toBeTruthy();
  });

  it("marca «caducada» la delegación sin resultado de una sesión parada", () => {
    const session = { ...SESSIONS[0], status: "idle" as const };
    store.dispatch({ type: "messages", id: session.id, messages: [bash('agy -p "resume"', { description: "AGY cortado" })] });
    render(<Agentes session={session} currentAgent={null} />);
    const fila = screen.getByText("AGY cortado").closest(".node");
    expect(fila?.textContent).toContain("caducada");
    expect(fila?.textContent).not.toContain("en curso");
  });
});
