import { describe, expect, it } from "vitest";
import { lastToolError, parseMejorar } from "../components/composer/mejorar";
import { MEJORAR_DESCRIPTION, withSessionCommands } from "../components/composer/commands";
import type { CommandDef } from "../types";
import type { ChatMessage } from "../types";

const result = (text: string, isError: boolean, agentId: string | null = null): ChatMessage => ({
  uuid: text, role: "user", timestamp: "2026-10-07T10:00:00Z", agentId,
  blocks: [{ kind: "toolResult", toolUseId: "t", isError, text }],
});

describe("/mejorar", () => {
  it("reconoce el comando con y sin borrador", () => {
    expect(parseMejorar("/mejorar arregla el login")).toBe("arregla el login");
    expect(parseMejorar("  /mejorar  \n linea 1\nlinea 2 ")).toBe("linea 1\nlinea 2");
    expect(parseMejorar("/mejorar")).toBe("");
  });

  it("no confunde otros textos", () => {
    expect(parseMejorar("/mejorarlo todo")).toBeNull();
    expect(parseMejorar("quiero /mejorar esto")).toBeNull();
    expect(parseMejorar("/compact")).toBeNull();
  });

  it("toma el último error del hilo principal, no de subagentes", () => {
    const msgs = [result("viejo", true), result("ok", false), result("del subagente", true, "a1")];
    expect(lastToolError(msgs)).toBe("viejo");
    expect(lastToolError([result("ok", false)])).toBeNull();
  });
});

describe("ventanas adicionales", () => {
  it("solo acepta etiquetas sesiones-<id> en ?win=", async () => {
    const { extraWindowLabel } = await import("../workspace");
    expect(extraWindowLabel("?win=sesiones-1a2b3c4d&session=x")).toBe("sesiones-1a2b3c4d");
    expect(extraWindowLabel("")).toBeNull();
    expect(extraWindowLabel("?win=main")).toBeNull();
    expect(extraWindowLabel("?win=sesiones-")).toBeNull();
  });
});

describe("/mejorar declara el proveedor en el catálogo vivo", () => {
  const delMod: CommandDef = {
    name: "mejorar", description: "Reescribe el borrador del prompt con el contexto del proyecto", source: "mod",
    origin: "ultron-mejorar", kind: "prompt", needsArgs: true, immediate: false,
  };

  it("sustituye la descripción del mod, que no dice a dónde sale el borrador", () => {
    const vivo = withSessionCommands([delMod]);
    expect(vivo.find((c) => c.name === "mejorar")?.description).toBe(MEJORAR_DESCRIPTION);
    expect(MEJORAR_DESCRIPTION).toContain("Groq");
    // Caso negativo: el catálogo de entrada no se muta.
    expect(delMod.description).not.toContain("Groq");
  });

  it("es idempotente y no toca los demás comandos", () => {
    const una = withSessionCommands([delMod]);
    expect(withSessionCommands(una)).toBe(una);
    expect(una.filter((c) => c.name === "mejorar")).toHaveLength(1);
  });
});
