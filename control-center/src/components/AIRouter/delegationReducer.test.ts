// Reducer y validación de la cadena de delegación (contrato 2026-10-26, §1).

import { describe, expect, it } from "vitest";
import {
  INITIAL_DELEGATION_STATE,
  delegationReducer,
  enginesOutsideChain,
  isDelegationDirty,
  validateDelegationConfig,
  type DelegationEditState,
} from "./delegationReducer";
import type { DelegationConfig } from "./delegationTypes";

function baseConfig(): DelegationConfig {
  return {
    version: 1,
    chain: ["codex", "agy", "claude-p", "deepseek"],
    tiers: {
      complex: { start: "codex" },
      standard: { start: "agy" },
      trivial: { start: "deepseek" },
    },
    relayOnCheckFail: true,
    engines: {
      codex: { runner: "codex", model: "gpt-5.6-terra", tierModels: { complex: "gpt-5.6-sol" }, enabled: true },
      agy: { runner: "agy", model: "gemini-3.8-flash-high", enabled: true },
      "claude-p": { runner: "claude", model: "claude-sonnet-5-5", maxBudgetUsd: 2, enabled: true },
      deepseek: { runner: "opencode", model: "deepseek/deepseek-flash", keyEnv: "DEEPSEEK_API_KEY", enabled: true },
      "openrouter-free": { runner: "opencode", model: "openrouter/x:free", enabled: false },
    },
  };
}

function loaded(): DelegationEditState {
  return delegationReducer(INITIAL_DELEGATION_STATE, { type: "LOAD", config: baseConfig() });
}

describe("delegationReducer", () => {
  it("LOAD deja el borrador igual a lo guardado y sin cambios pendientes", () => {
    const s = loaded();
    expect(s.draft).toEqual(s.saved);
    expect(s.draft).not.toBe(s.saved);
    expect(isDelegationDirty(s)).toBe(false);
  });

  it("MOVE sube y baja sin mutar el estado anterior", () => {
    const s0 = loaded();
    const s1 = delegationReducer(s0, { type: "MOVE", engineId: "agy", delta: -1 });
    expect(s1.draft?.chain).toEqual(["agy", "codex", "claude-p", "deepseek"]);
    expect(s0.draft?.chain).toEqual(["codex", "agy", "claude-p", "deepseek"]);
    expect(isDelegationDirty(s1)).toBe(true);
    const s2 = delegationReducer(s1, { type: "MOVE", engineId: "agy", delta: 1 });
    expect(s2.draft?.chain).toEqual(s0.draft?.chain);
  });

  it("MOVE en los extremos o con un id ajeno no cambia nada", () => {
    const s0 = loaded();
    expect(delegationReducer(s0, { type: "MOVE", engineId: "codex", delta: -1 })).toBe(s0);
    expect(delegationReducer(s0, { type: "MOVE", engineId: "deepseek", delta: 1 })).toBe(s0);
    expect(delegationReducer(s0, { type: "MOVE", engineId: "nadie", delta: 1 })).toBe(s0);
  });

  it("TOGGLE_ENABLED, ADD_TO_CHAIN y REMOVE_FROM_CHAIN", () => {
    let s = delegationReducer(loaded(), { type: "TOGGLE_ENABLED", engineId: "agy" });
    expect(s.draft?.engines.agy.enabled).toBe(false);
    s = delegationReducer(s, { type: "ADD_TO_CHAIN", engineId: "openrouter-free" });
    expect(s.draft?.chain[s.draft.chain.length - 1]).toBe("openrouter-free");
    expect(delegationReducer(s, { type: "ADD_TO_CHAIN", engineId: "openrouter-free" })).toBe(s);
    expect(delegationReducer(s, { type: "ADD_TO_CHAIN", engineId: "inexistente" })).toBe(s);
    s = delegationReducer(s, { type: "REMOVE_FROM_CHAIN", engineId: "codex" });
    expect(s.draft?.chain).not.toContain("codex");
    expect(enginesOutsideChain(s.draft as DelegationConfig)).toEqual(["codex"]);
  });

  it("SET_MODEL cambia el base o el del nivel, y el nivel vacío se borra", () => {
    let s = delegationReducer(loaded(), { type: "SET_MODEL", engineId: "agy", tier: null, model: "g-otro" });
    expect(s.draft?.engines.agy.model).toBe("g-otro");
    s = delegationReducer(s, { type: "SET_MODEL", engineId: "agy", tier: "trivial", model: "g-mini" });
    expect(s.draft?.engines.agy.tierModels).toEqual({ trivial: "g-mini" });
    s = delegationReducer(s, { type: "SET_MODEL", engineId: "agy", tier: "trivial", model: "" });
    expect(s.draft?.engines.agy).not.toHaveProperty("tierModels");
    s = delegationReducer(s, { type: "SET_MODEL", engineId: "codex", tier: "complex", model: " " });
    expect(s.draft?.engines.codex).not.toHaveProperty("tierModels");
  });

  it("SET_MAX_BUDGET pone y quita el tope", () => {
    let s = delegationReducer(loaded(), { type: "SET_MAX_BUDGET", engineId: "claude-p", value: 5 });
    expect(s.draft?.engines["claude-p"].maxBudgetUsd).toBe(5);
    s = delegationReducer(s, { type: "SET_MAX_BUDGET", engineId: "claude-p", value: null });
    expect(s.draft?.engines["claude-p"]).not.toHaveProperty("maxBudgetUsd");
  });

  it("SET_TIER_START y RESET vuelven a lo guardado", () => {
    let s = delegationReducer(loaded(), { type: "SET_TIER_START", tier: "trivial", engineId: "agy" });
    expect(s.draft?.tiers.trivial.start).toBe("agy");
    s = delegationReducer(s, { type: "RESET" });
    expect(s.draft?.tiers.trivial.start).toBe("deepseek");
    expect(isDelegationDirty(s)).toBe(false);
  });

  it("sin configuración cargada las acciones de edición no hacen nada", () => {
    const s = delegationReducer(INITIAL_DELEGATION_STATE, { type: "TOGGLE_ENABLED", engineId: "agy" });
    expect(s).toBe(INITIAL_DELEGATION_STATE);
  });
});

describe("validateDelegationConfig", () => {
  it("la configuración del contrato es válida y sin avisos", () => {
    expect(validateDelegationConfig(baseConfig())).toEqual({ errors: [], warnings: [] });
  });

  it("rechaza ids de cadena desconocidos o duplicados", () => {
    const c = { ...baseConfig(), chain: ["codex", "codex", "fantasma", "agy", "deepseek"] };
    const { errors } = validateDelegationConfig(c);
    expect(errors.some((e) => e.includes("dos veces"))).toBe(true);
    expect(errors.some((e) => e.includes("fantasma"))).toBe(true);
  });

  it("rechaza runners fuera del contrato y motores activos sin modelo", () => {
    const c = baseConfig();
    const bad = {
      ...c,
      engines: {
        ...c.engines,
        agy: { ...c.engines.agy, model: "" },
        codex: { ...c.engines.codex, runner: "ollama" as never },
      },
    };
    const { errors } = validateDelegationConfig(bad);
    expect(errors.some((e) => e.includes("ollama"))).toBe(true);
    expect(errors.some((e) => e.includes("«agy»") && e.includes("modelo"))).toBe(true);
  });

  // Caso negativo: el backend exige modelo también en un motor apagado; la UI
  // lo dejaba pasar y el guardado fallaba en ai_router_set_delegation.
  it("exige modelo también en un motor desactivado", () => {
    const c = baseConfig();
    const off = {
      ...c,
      engines: { ...c.engines, "openrouter-free": { ...c.engines["openrouter-free"], model: "" } },
    };
    const { errors } = validateDelegationConfig(off);
    expect(errors.some((e) => e.includes("«openrouter-free»") && e.includes("modelo"))).toBe(true);
  });

  it("rechaza modelos con metacaracteres de shell, como el backend", () => {
    const c = baseConfig();
    for (const bad of ['x" & echo INJECTED & "', "m%USERNAME%m", "$(id)", "a`b`", "con espacio"]) {
      const cfg = { ...c, engines: { ...c.engines, agy: { ...c.engines.agy, model: bad } } };
      expect(validateDelegationConfig(cfg).errors.join(" ")).toMatch(/caracteres no admitidos/);
      const tier = { ...c, engines: { ...c.engines, agy: { ...c.engines.agy, tierModels: { trivial: bad } } } };
      expect(validateDelegationConfig(tier).errors.join(" ")).toMatch(/nivel trivial/);
    }
    expect(validateDelegationConfig(c).errors).toEqual([]);
  });

  it("maxBudgetUsd solo en runner claude y mayor que 0", () => {
    const c = baseConfig();
    const onOpencode = {
      ...c,
      engines: { ...c.engines, deepseek: { ...c.engines.deepseek, maxBudgetUsd: 1 } },
    };
    expect(validateDelegationConfig(onOpencode).errors.join(" ")).toMatch(/solo admite el runner claude/);
    for (const maxBudgetUsd of [0, -1, Number.NaN]) {
      const bad = {
        ...c,
        engines: { ...c.engines, "claude-p": { ...c.engines["claude-p"], maxBudgetUsd } },
      };
      expect(validateDelegationConfig(bad).errors.join(" ")).toMatch(/mayor que 0/);
    }
  });

  it("un nivel que entra por un motor fuera de la cadena es error; desactivado, aviso", () => {
    const c = baseConfig();
    const outside = { ...c, tiers: { ...c.tiers, trivial: { start: "openrouter-free" } } };
    expect(validateDelegationConfig(outside).errors.join(" ")).toMatch(/Trivial/);
    const disabled = { ...c, engines: { ...c.engines, agy: { ...c.engines.agy, enabled: false } } };
    const issues = validateDelegationConfig(disabled);
    expect(issues.errors).toEqual([]);
    expect(issues.warnings.join(" ")).toMatch(/Estándar/);
  });

  it("sin ningún motor activo en la cadena es error", () => {
    const c = baseConfig();
    const engines = Object.fromEntries(
      Object.entries(c.engines).map(([id, e]) => [id, { ...e, enabled: false }]),
    );
    expect(validateDelegationConfig({ ...c, engines }).errors.join(" ")).toMatch(/ningún motor activo/);
  });
});
