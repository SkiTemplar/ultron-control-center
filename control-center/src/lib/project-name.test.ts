// lib/project-name.test.ts
// Casos de validateProjectName(): mismas reglas que INVALID_NAME en
// project-create.mjs (caracteres prohibidos NTFS/Windows + nombres
// reservados del sistema).

import { describe, expect, it } from "vitest";
import { isValidProjectName, validateProjectName } from "./project-name";

describe("validateProjectName", () => {
  it("acepta nombres normales con espacios, guiones y acentos", () => {
    expect(validateProjectName("Practica 1")).toBeNull();
    expect(validateProjectName("mi-proyecto_final")).toBeNull();
    expect(validateProjectName("Programación II")).toBeNull();
    expect(isValidProjectName("TFG")).toBe(true);
  });

  it("rechaza el nombre vacio o solo espacios", () => {
    expect(validateProjectName("")).not.toBeNull();
    expect(validateProjectName("   ")).not.toBeNull();
  });

  it("rechaza los caracteres prohibidos de Windows", () => {
    for (const bad of ['a<b', 'a>b', 'a:b', 'a"b', 'a/b', 'a\\b', 'a|b', 'a?b', 'a*b']) {
      expect(validateProjectName(bad), `esperaba error para ${bad}`).not.toBeNull();
    }
  });

  it("rechaza nombres terminados en punto", () => {
    expect(validateProjectName("proyecto.")).not.toBeNull();
  });

  it("recorta espacios sobrantes antes de validar", () => {
    expect(validateProjectName("  proyecto  ")).toBeNull();
  });

  it("rechaza los nombres reservados del sistema, con o sin extension", () => {
    expect(validateProjectName("CON")).not.toBeNull();
    expect(validateProjectName("con")).not.toBeNull();
    expect(validateProjectName("LPT1")).not.toBeNull();
    expect(validateProjectName("com3.txt")).not.toBeNull();
  });

  it("no confunde un nombre real que solo EMPIEZA como uno reservado", () => {
    // "CONtable" no es CON: split por "." da "CONtable" completo, no coincide.
    expect(validateProjectName("CONtable")).toBeNull();
    expect(validateProjectName("Compiladores")).toBeNull();
  });

  it("rechaza nombres por encima del limite de longitud (80, igual que el backend)", () => {
    expect(validateProjectName("a".repeat(81))).not.toBeNull();
    expect(validateProjectName("a".repeat(80))).toBeNull();
  });

  it("rechaza metacaracteres de cmd.exe y guion inicial, igual que el backend", () => {
    for (const bad of ["proy & calc.exe", "100%", "a^b", "hola!", "a`b", "-rf"]) {
      expect(validateProjectName(bad), `esperaba error para ${bad}`).not.toBeNull();
    }
    expect(validateProjectName("Práctica — 7")).toBeNull();
  });
});
