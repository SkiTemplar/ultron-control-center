// OpenCode como tercer motor externo y uso de DeepSeek y delegaciones.
import { describe, expect, it } from "vitest";
import { ENGINE_IDS, ENGINE_LABEL, engineOfTarget, modelProvider } from "../engines";
import { sanitizePrefs } from "../prefs";
import { parseEngineModel } from "../components/composer/session-commands";
import { deepseekText, delegationLine, normalizeEngines } from "../components/inspector/uso-motores";

describe("motor OpenCode", () => {
  it("es el tercer motor y el destino «opencode» lo lanza", () => {
    expect(ENGINE_IDS).toEqual(["codex", "gemini", "opencode"]);
    expect(ENGINE_LABEL.opencode).toBe("OpenCode");
    expect(engineOfTarget("opencode")).toBe("opencode");
  });

  it("agrupa los modelos de OpenCode por proveedor y no los de otros motores", () => {
    expect(modelProvider("opencode", "deepseek/deepseek-flash")).toBe("DeepSeek");
    expect(modelProvider("opencode", "openrouter/nvidia/nemotron:free")).toBe("OpenRouter");
    expect(modelProvider("opencode", "otro/x")).toBe("otro");
    expect(modelProvider("codex", "gpt-6-astra")).toBeNull();
  });

  it("las preferencias aceptan proveedor/modelo solo para OpenCode", () => {
    const ok = sanitizePrefs({ engineModels: { codex: "a/b", opencode: "openrouter/nvidia/nemotron-3:free" } });
    expect(ok.engineModels).toEqual({ codex: null, gemini: null, opencode: "openrouter/nvidia/nemotron-3:free" });
    expect(sanitizePrefs({ engineModels: { opencode: "--auto/x" } }).engineModels.opencode).toBeNull();
    expect(sanitizePrefs({ engineModels: { opencode: "sin-proveedor" } }).engineModels.opencode).toBeNull();
  });

  it("/motor-modelo entiende opencode", () => {
    expect(parseEngineModel("opencode groq/llama-3.3-70b")).toEqual({ engine: "opencode", model: "groq/llama-3.3-70b" });
    expect(parseEngineModel("opencode predeterminado")).toEqual({ engine: "opencode", model: "" });
    expect(parseEngineModel("claude x")).toBeNull();
  });
});

describe("uso: DeepSeek y delegaciones", () => {
  const base = { generatedAtMs: 1, engines: [] };

  it("valida el saldo y las delegaciones en la frontera", () => {
    const u = normalizeEngines({
      ...base,
      deepseek: { status: "ok", available: false, balances: [{ currency: "USD", total: "0.00" }, { currency: 3 }], note: "sin saldo", readAtMs: 5 },
      delegations: [{ engine: "codex", attempts: 4, ok: 3, successPct: 75, costUsd: null }, { engine: "roto" }],
    });
    expect(u.deepseek?.balances).toEqual([{ currency: "USD", total: "0.00" }]);
    expect(u.delegations).toEqual([{ engine: "codex", attempts: 4, ok: 3, successPct: 75, costUsd: null }]);
  });

  it("un backend anterior sin estos campos no rompe", () => {
    const u = normalizeEngines(base);
    expect(u.deepseek).toBeNull();
    expect(u.delegations).toBeNull();
    expect(normalizeEngines({ ...base, deepseek: { status: "raro" } }).deepseek).toBeNull();
  });

  it("sin saldo se dice; sin key, también", () => {
    expect(deepseekText({ status: "ok", available: false, balances: [{ currency: "USD", total: "0.00" }], note: "sin saldo", readAtMs: 1 })).toBe("0,00 USD · sin saldo");
    expect(deepseekText({ status: "ok", available: true, balances: [{ currency: "CNY", total: "12.40" }], note: null, readAtMs: 1 })).toBe("12,40 CNY");
    expect(deepseekText({ status: "none", available: null, balances: [], note: "sin DEEPSEEK_API_KEY", readAtMs: null })).toBe("sin DEEPSEEK_API_KEY");
    expect(deepseekText({ status: "error", available: null, balances: [], note: "DeepSeek respondió 401", readAtMs: null })).toBe("no se pudo leer: DeepSeek respondió 401");
  });

  it("la línea de delegaciones lleva intentos, éxito y coste solo si lo hay", () => {
    expect(delegationLine({ engine: "claude-p", attempts: 2, ok: 1, successPct: 50, costUsd: 0.75 })).toBe("claude-p: 2 intentos · 50 % de éxito · 0,75 USD");
    expect(delegationLine({ engine: "codex", attempts: 1, ok: 1, successPct: 100, costUsd: null })).toBe("codex: 1 intento · 100 % de éxito");
  });
});
