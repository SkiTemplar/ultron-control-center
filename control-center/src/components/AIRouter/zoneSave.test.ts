import { describe, expect, it } from "vitest";
import { saveZoneDraft } from "./zoneSave";
import type { Zone } from "./types";

const draft: Zone = {
  id: "summarize",
  label: "Summarize document",
  category: "chat",
  primary: { provider_id: "groq", model: "openai/gpt-oss-20b", max_tokens: 1024 },
  fallbacks: [{ provider_id: "gemini-cli", model: "gemini-2.5-flash", max_tokens: 1024 }],
};

describe("saveZoneDraft", () => {
  it("devuelve la zona que persiste el backend, no el borrador", async () => {
    const persisted = { ...draft, fallbacks: [] };
    const result = await saveZoneDraft(async () => persisted, draft);
    expect(result).toEqual({ ok: true, zone: persisted });
  });

  it("enseña el motivo cuando el backend rechaza la edición", async () => {
    const reason =
      "No se ha guardado la zona 'summarize': la carga la dejaría así: groq → gemini. Motivo: gemini-cli está retirado";
    const result = await saveZoneDraft(async () => {
      throw reason;
    }, draft);
    expect(result).toEqual({ ok: false, error: reason });
  });

  it("no da por guardado un backend antiguo que no devuelve la zona", async () => {
    const result = await saveZoneDraft(async () => null, draft);
    expect(result.ok).toBe(false);
  });

  it("llama al comando con la zona como argumento", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    await saveZoneDraft(async (cmd, args) => {
      calls.push([cmd, args]);
      return draft;
    }, draft);
    expect(calls).toEqual([["ai_router_save_zone", { zone: draft }]]);
  });
});
