// Settings/api-keys/validation.test.ts — casos de isPlausibleEmail(): mismo
// "parse, don't validate" que el backend (env_keys.rs::is_valid_email).

import { describe, expect, it } from "vitest";
import { isPlausibleEmail } from "./validation";

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
