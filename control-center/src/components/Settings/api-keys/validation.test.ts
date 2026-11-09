// Settings/api-keys/validation.test.ts — casos de isPlausibleEmail(): mismo
// "parse, don't validate" que el backend (env_keys.rs::is_valid_email).

import { describe, expect, it } from "vitest";
import {
  CUSTOM_KEY_ENV_RE,
  isPlausibleEmail,
  slugToKeyEnv,
  suggestSlug,
  validateCustomProvider,
} from "./validation";

describe("isPlausibleEmail", () => {
  it("acepta emails con formato normal", () => {
    expect(isPlausibleEmail("alumno@example.com")).toBe(true);
    expect(isPlausibleEmail("nombre.apellido@dominio.co.uk")).toBe(true);
    expect(isPlausibleEmail("a@b.io")).toBe(true);
  });

  it("rechaza cadenas sin arroba", () => {
    expect(isPlausibleEmail("sin-arroba.com")).toBe(false);
  });

  it("rechaza arroba en el primer o ultimo caracter", () => {
    expect(isPlausibleEmail("@dominio.com")).toBe(false);
    expect(isPlausibleEmail("usuario@")).toBe(false);
  });

  it("rechaza dominio sin punto", () => {
    expect(isPlausibleEmail("usuario@dominiosinpunto")).toBe(false);
  });

  it("rechaza dominio que empieza o termina en punto", () => {
    expect(isPlausibleEmail("usuario@.dominio.com")).toBe(false);
    expect(isPlausibleEmail("usuario@dominio.com.")).toBe(false);
  });

  it("rechaza cadena vacia", () => {
    expect(isPlausibleEmail("")).toBe(false);
  });
});

describe("slugToKeyEnv", () => {
  it("pasa el id a mayúsculas y cambia guiones por guiones bajos", () => {
    expect(slugToKeyEnv("mi-proxy")).toBe("ULTRON_KEY_MI_PROXY");
    expect(slugToKeyEnv("lab_2")).toBe("ULTRON_KEY_LAB_2");
  });

  it("el resultado cumple el regex del contrato y los nombres ajenos no", () => {
    expect(CUSTOM_KEY_ENV_RE.test(slugToKeyEnv("mi-proxy"))).toBe(true);
    expect(CUSTOM_KEY_ENV_RE.test(slugToKeyEnv("a".repeat(40)))).toBe(true);
    expect(CUSTOM_KEY_ENV_RE.test("OPENAI_API_KEY")).toBe(false);
    expect(CUSTOM_KEY_ENV_RE.test("ULTRON_KEY_A")).toBe(false);
    expect(CUSTOM_KEY_ENV_RE.test(`ULTRON_KEY_${"A".repeat(41)}`)).toBe(false);
    expect(CUSTOM_KEY_ENV_RE.test("ULTRON_KEY_mi_proxy")).toBe(false);
  });
});

describe("suggestSlug", () => {
  it("quita tildes, pasa a minúsculas y une con guiones", () => {
    expect(suggestSlug("Mi Proxy Ñandú")).toBe("mi-proxy-nandu");
    expect(suggestSlug("  --Lab (2)--  ")).toBe("lab-2");
  });

  it("el slug sugerido de un nombre largo sigue siendo un id válido", () => {
    const slug = suggestSlug("Proveedor ".repeat(10));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(validateCustomProvider(
      { name: "x", id: slug, baseUrl: "https://a.io", apiFormat: "gemini", apiKey: "" },
      new Set(),
    )).toEqual({});
  });
});

describe("validateCustomProvider", () => {
  const ok = {
    name: "Mi proxy",
    id: "mi-proxy",
    baseUrl: "https://api.ejemplo.com/v1",
    apiFormat: "openai_compat",
    apiKey: "sk-123",
  };
  const seed = new Set(["groq", "deepseek"]);

  it("acepta un borrador válido", () => {
    expect(validateCustomProvider(ok, seed)).toEqual({});
  });

  it("acepta http solo en localhost y la key vacía", () => {
    const local = { ...ok, baseUrl: "http://127.0.0.1:8080/v1", apiKey: "" };
    expect(validateCustomProvider(local, seed)).toEqual({});
  });

  it("acepta http en el loopback IPv6, como el backend", () => {
    const local = { ...ok, baseUrl: "http://[::1]:8080/v1", apiKey: "" };
    expect(validateCustomProvider(local, seed)).toEqual({});
    expect(validateCustomProvider({ ...local, baseUrl: "http://[::2]:8080/v1" }, seed).baseUrl).toBeDefined();
  });

  // Caso negativo: ids que el backend (is_slug) rechaza y el formulario
  // aceptaba («_» y «-» final).
  it("rechaza ids con mayúsculas, espacios, «_», guiones en los extremos o más de 40", () => {
    for (const id of ["Mi-Proxy", "mi proxy", "a", "-abc", "abc-", "mi_proxy", "a".repeat(41), "ñu"]) {
      expect(validateCustomProvider({ ...ok, id }, seed).id).toBeDefined();
    }
  });

  it("acepta ids de 2 y 40 caracteres con guiones internos", () => {
    for (const id of ["a1", "mi-proxy", `a${"-".repeat(38)}b`]) {
      expect(validateCustomProvider({ ...ok, id }, seed).id).toBeUndefined();
    }
  });

  it("el nombre admite 80 caracteres, como el backend, y no 81", () => {
    expect(validateCustomProvider({ ...ok, name: "ñ".repeat(80) }, seed).name).toBeUndefined();
    expect(validateCustomProvider({ ...ok, name: "n".repeat(81) }, seed).name).toBeDefined();
  });

  it("rechaza un id que ya usa un proveedor del seed", () => {
    expect(validateCustomProvider({ ...ok, id: "groq" }, seed).id).toMatch(/groq/);
  });

  it("rechaza base_url sin https, con credenciales, con query o inválida", () => {
    for (const baseUrl of [
      "",
      "api.ejemplo.com",
      "http://api.ejemplo.com",
      "https://user:pw@api.ejemplo.com",
      "https://api.ejemplo.com/v1?x=1",
      "ftp://api.ejemplo.com",
    ]) {
      expect(validateCustomProvider({ ...ok, baseUrl }, seed).baseUrl).toBeDefined();
    }
  });

  it("rechaza formatos fuera del contrato y el nombre vacío", () => {
    const errs = validateCustomProvider({ ...ok, apiFormat: "ollama", name: "  " }, seed);
    expect(errs.apiFormat).toBeDefined();
    expect(errs.name).toBeDefined();
  });

  it("rechaza una key con espacios internos", () => {
    expect(validateCustomProvider({ ...ok, apiKey: "sk 123" }, seed).apiKey).toBeDefined();
  });
});
