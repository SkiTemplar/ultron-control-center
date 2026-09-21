// Settings/api-keys/key-catalog.test.ts — invariantes del catalogo: cada
// clave declara envVar, un docsUrl https y un tutorial con contenido; las
// claves de email de RESEARCH_KEYS estan marcadas como no secretas.

import { describe, expect, it } from "vitest";
import { EMAIL_ENV_VARS, RESEARCH_KEYS } from "./key-catalog";
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

describe("RESEARCH_KEYS", () => {
  it("no esta vacio", () => {
    expect(RESEARCH_KEYS.length).toBeGreaterThan(0);
  });

  it("cada clave tiene envVar, docsUrl https y tutorial no vacio", () => {
    for (const def of RESEARCH_KEYS) {
      expectValidTutorial(def);
    }
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
