import { describe, expect, it } from "vitest";
import { siguienteIndice } from "../hudSelectNav";

describe("siguienteIndice", () => {
  it("baja y sube una posición", () => {
    expect(siguienteIndice("ArrowDown", 0, 4)).toBe(1);
    expect(siguienteIndice("ArrowUp", 2, 4)).toBe(1);
  });

  it("da la vuelta en los extremos", () => {
    // Sin esto el cursor se queda clavado en la última y parece que el
    // teclado no responde.
    expect(siguienteIndice("ArrowDown", 3, 4)).toBe(0);
    expect(siguienteIndice("ArrowUp", 0, 4)).toBe(3);
  });

  it("Inicio y Fin van a los extremos", () => {
    expect(siguienteIndice("Home", 2, 4)).toBe(0);
    expect(siguienteIndice("End", 1, 4)).toBe(3);
  });

  it("página arriba y abajo no se salen de la lista", () => {
    expect(siguienteIndice("PageDown", 2, 4)).toBe(3);
    expect(siguienteIndice("PageUp", 1, 4)).toBe(0);
    expect(siguienteIndice("PageDown", 0, 20)).toBe(5);
  });

  it("una tecla cualquiera no mueve el cursor", () => {
    // Caso negativo: si "a" moviera el cursor, escribir para buscar cambiaría
    // la selección sin querer.
    for (const t of ["a", "Tab", "Shift", "F5", ""]) {
      expect(siguienteIndice(t, 1, 4)).toBeNull();
    }
  });

  it("una lista vacía no devuelve índice", () => {
    expect(siguienteIndice("ArrowDown", 0, 0)).toBeNull();
    expect(siguienteIndice("Home", 0, 0)).toBeNull();
  });
});
