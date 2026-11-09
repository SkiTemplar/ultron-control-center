// Settings/api-keys/key-catalog.test.ts — invariantes del catalogo: cada
// clave declara envVar, un docsUrl https y un tutorial con contenido; las
// claves de email de RESEARCH_KEYS estan marcadas como no secretas.

import { describe, expect, it } from "vitest";
import {
  EMAIL_ENV_VARS,
  PROVIDER_KEYS,
  RESEARCH_KEYS,
  SUBSCRIPTION_CLIS,
  keysOfGroup,
} from "./key-catalog";
import type { ProviderKeyDef, ResearchKeyDef } from "./types";

function expectValidTutorial(def: ProviderKeyDef) {
  expect(def.envVar.length).toBeGreaterThan(0);
  expect(def.docsUrl.startsWith("https://")).toBe(true);
  expect(def.tutorial.steps.length).toBeGreaterThan(0);
  for (const step of def.tutorial.steps) {
    expect(step.trim().length).toBeGreaterThan(0);
  }
  expect(def.tutorial.usedFor.trim().length).toBeGreaterThan(0);
  expect(def.tutorial.ifMissing.trim().length).toBeGreaterThan(0);
  expect(def.tutorial.sourceUrl.startsWith("https://")).toBe(true);
  expect(def.tutorial.sourceLabel.trim().length).toBeGreaterThan(0);
}

describe("PROVIDER_KEYS", () => {
  it("no esta vacio", () => {
    expect(PROVIDER_KEYS.length).toBeGreaterThan(0);
  });

  it("cada clave tiene envVar, docsUrl https y tutorial no vacio", () => {
    for (const def of PROVIDER_KEYS) {
      expectValidTutorial(def);
    }
  });

  it("no tiene envVar duplicados", () => {
    const envVars = PROVIDER_KEYS.map((d) => d.envVar);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it("incluye las variables del contrato del delegador (§5)", () => {
    const envVars = new Set(PROVIDER_KEYS.map((d) => d.envVar));
    for (const v of [
      "CEREBRAS_API_KEY",
      "MISTRAL_API_KEY",
      "NVIDIA_NIM_API_KEY",
      "GITHUB_MODELS_TOKEN",
      "TOGETHER_API_KEY",
      "FIREWORKS_API_KEY",
      "XAI_API_KEY",
      "SAMBANOVA_API_KEY",
      "HF_TOKEN",
      "MOONSHOT_API_KEY",
      "DASHSCOPE_API_KEY",
      "ZAI_API_KEY",
      "COHERE_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
    ]) {
      expect(envVars.has(v)).toBe(true);
    }
  });

  it("cada clave de provider es de pago o gratuita, nunca de otro grupo", () => {
    for (const def of PROVIDER_KEYS) {
      expect(["paid", "free"]).toContain(def.group);
    }
    expect(keysOfGroup("paid").length + keysOfGroup("free").length).toBe(PROVIDER_KEYS.length);
  });

  it("ninguna clave fija usa el prefijo reservado de los personalizados", () => {
    for (const def of [...PROVIDER_KEYS, ...RESEARCH_KEYS]) {
      expect(def.envVar.startsWith("ULTRON_KEY_")).toBe(false);
    }
  });

  it("DeepSeek documenta la delegación con OpenCode y sus dos modelos", () => {
    const ds = PROVIDER_KEYS.find((d) => d.envVar === "DEEPSEEK_API_KEY");
    expect(ds?.tutorial.usedFor).toMatch(/OpenCode/);
    expect(ds?.tutorial.usedFor).toMatch(/deepseek-flash/);
    expect(ds?.tutorial.usedFor).toMatch(/deepseek-v4-pro/);
  });
});

describe("SUBSCRIPTION_CLIS", () => {
  it("son Codex, Antigravity y claude -p, con id de motor y docsUrl https", () => {
    expect(SUBSCRIPTION_CLIS.map((c) => c.engineId)).toEqual(["codex", "agy", "claude-p"]);
    for (const cli of SUBSCRIPTION_CLIS) {
      expect(cli.docsUrl.startsWith("https://")).toBe(true);
    }
  });
});

describe("RESEARCH_KEYS", () => {
  it("no esta vacio", () => {
    expect(RESEARCH_KEYS.length).toBeGreaterThan(0);
  });

  it("cada clave tiene envVar, docsUrl https y tutorial no vacio", () => {
    for (const def of RESEARCH_KEYS) {
      expectValidTutorial(def);
    }
  });

  it("todas pertenecen al grupo research", () => {
    expect(keysOfGroup("research")).toEqual(RESEARCH_KEYS);
  });

  it("las claves de email estan marcadas isEmail y en EMAIL_ENV_VARS", () => {
    const emailDefs: ResearchKeyDef[] = RESEARCH_KEYS.filter((d) => d.isEmail);
    expect(emailDefs.length).toBeGreaterThan(0);
    for (const def of emailDefs) {
      expect(EMAIL_ENV_VARS.has(def.envVar)).toBe(true);
    }
  });

  it("las claves que no son email no estan en EMAIL_ENV_VARS", () => {
    const secretDefs = RESEARCH_KEYS.filter((d) => !d.isEmail);
    expect(secretDefs.length).toBeGreaterThan(0);
    for (const def of secretDefs) {
      expect(EMAIL_ENV_VARS.has(def.envVar)).toBe(false);
    }
  });
});
