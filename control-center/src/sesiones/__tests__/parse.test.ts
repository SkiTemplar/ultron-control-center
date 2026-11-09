import { describe, expect, it } from "vitest";
import {
  buildResultIndex, estimateContext, formatTokens, isToolResultOnly, mergeStreamText,
  segmentBlocks, toolDiffLines, toolDiffStats, toolSummary, visibleMessages,
} from "../parse";
import type { ChatMessage } from "../types";

const base = { timestamp: "2026-10-07T10:00:00Z", agentId: null };

describe("parser de mensajes", () => {
  it("agrupa herramientas consecutivas y omite resultados", () => {
    const segs = segmentBlocks([
      { kind: "text", text: "a" },
      { kind: "toolUse", id: "1", name: "Read", input: {}, summary: "" },
      { kind: "toolUse", id: "2", name: "Grep", input: {}, summary: "" },
      { kind: "toolResult", toolUseId: "1", isError: false, text: "" },
      { kind: "text", text: "b" },
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["text", "tools", "text"]);
    expect(segs[1].kind === "tools" && segs[1].tools.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("indexa resultados y oculta mensajes que solo traen resultados", () => {
    const only: ChatMessage = { ...base, uuid: "r", role: "user", blocks: [{ kind: "toolResult", toolUseId: "t", isError: true, text: "boom" }] };
    const normal: ChatMessage = { ...base, uuid: "n", role: "user", blocks: [{ kind: "text", text: "hola" }] };
    expect(isToolResultOnly(only)).toBe(true);
    expect(buildResultIndex([only]).get("t")?.isError).toBe(true);
    expect(visibleMessages([only, normal]).map((m) => m.uuid)).toEqual(["n"]);
  });

  it("cuenta líneas añadidas y quitadas en Edit, Write y MultiEdit", () => {
    expect(toolDiffStats("Edit", { old_string: "a\nb", new_string: "a\nb\nc" })).toEqual({ added: 3, removed: 2 });
    expect(toolDiffStats("Write", { content: "x\ny\n" })).toEqual({ added: 2, removed: 0 });
    expect(toolDiffStats("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d\ne" }] })).toEqual({ added: 3, removed: 2 });
    expect(toolDiffStats("Bash", { command: "ls" })).toBeNull();
  });

  it("genera líneas de diff con su tipo", () => {
    const lines = toolDiffLines("Edit", { old_string: "viejo", new_string: "nuevo" });
    expect(lines).toEqual([{ kind: "del", text: "viejo" }, { kind: "add", text: "nuevo" }]);
  });

  it("resume la herramienta con la ruta o el comando", () => {
    expect(toolSummary("Read", { file_path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolSummary("Bash", { command: "npm test\n--watch" })).toBe("npm test");
    expect(toolSummary("Raro", {})).toBe("Raro");
  });

  it("acumula el texto en vivo como deltas, aunque un delta repita el principio", () => {
    expect(mergeStreamText("Hola", " mundo")).toBe("Hola mundo");
    expect(mergeStreamText("Ja", "Ja")).toBe("JaJa");
    expect(mergeStreamText("x", "")).toBe("x");
  });

  it("estima el contexto sin superar el total", () => {
    const msgs: ChatMessage[] = [
      { ...base, uuid: "1", role: "assistant", blocks: [{ kind: "toolUse", id: "r", name: "Read", input: { file_path: "x" }, summary: "" }] },
      { ...base, uuid: "2", role: "user", blocks: [{ kind: "toolResult", toolUseId: "r", isError: false, text: "x".repeat(4000) }] },
      { ...base, uuid: "3", role: "assistant", blocks: [{ kind: "text", text: "y".repeat(400) }] },
    ];
    const slices = estimateContext(msgs, 10000);
    const total = slices.reduce((a, s) => a + s.tokens, 0);
    expect(total).toBe(10000);
    expect(slices.find((s) => s.key === "reads")?.tokens).toBe(1000);
    expect(slices.find((s) => s.key === "messages")?.tokens).toBe(100);
  });

  it("formatea tokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(412000)).toBe("412k");
    expect(formatTokens(1000000)).toBe("1M");
  });
});
