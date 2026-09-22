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

// Opciones que se ven pero no se pueden elegir: los modelos que la suscripción
// no permite (2026-09-22). El cursor pasa de largo porque pararse encima de
// algo que el Enter ignora parece que el teclado se ha colgado.
describe("siguienteIndice saltando opciones vetadas", () => {
  /** Vetadas las de estos índices. */
  const veta =
    (...ids: number[]) =>
    (i: number) =>
      ids.includes(i);

  it("pasa de largo por encima de una vetada", () => {
    // 0 libre, 1 vetada, 2 libre.
    expect(siguienteIndice("ArrowDown", 0, 3, veta(1))).toBe(2);
  });

  it("sigue en el sentido de la tecla, no da media vuelta", () => {
    // Caso que distingue «saltar» de «rebotar»: subiendo desde 3 con la 2
    // vetada hay que acabar en la 1, no volver a la 3.
    expect(siguienteIndice("ArrowUp", 3, 4, veta(2))).toBe(1);
  });

  it("da la vuelta a la lista si hace falta", () => {
    // 3 vetadas al final: bajar desde 0 tiene que volver al principio.
    expect(siguienteIndice("ArrowDown", 0, 4, veta(1, 2, 3))).toBe(0);
    // Inicio y Fin también respetan el veto, cada uno hacia su lado.
    expect(siguienteIndice("Home", 2, 4, veta(0))).toBe(1);
    expect(siguienteIndice("End", 0, 4, veta(3))).toBe(2);
  });

  it("con TODAS vetadas no devuelve índice y no se cuelga", () => {
    // La guarda de la que depende todo: sin ella, buscar un hueco que no
    // existe es un bucle infinito que congela la ventana.
    for (const t of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]) {
      expect(siguienteIndice(t, 1, 4, () => true)).toBeNull();
    }
  });

  it("sin función de veto se comporta exactamente como antes", () => {
    // Caso negativo del cuarto argumento: es opcional y las llamadas que no
    // tienen nada que saltar no pueden cambiar de comportamiento.
    expect(siguienteIndice("ArrowDown", 3, 4)).toBe(0);
    expect(siguienteIndice("ArrowDown", 0, 3, () => false)).toBe(1);
  });
});
