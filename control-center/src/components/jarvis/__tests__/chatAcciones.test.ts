// Teclado del chat: precedencia de Escape, qué se puede pulsar escribiendo y
// que la paleta encuentre las acciones nuevas escribiendo en castellano.

import { describe, expect, it } from "vitest";
import { decidirEscape, seDisparaEscribiendo } from "../chatAcciones";
import { fuzzyScore } from "../../CommandPalette";

describe("decidirEscape", () => {
  it("con el menú de comandos abierto, lo cierra y no para nada", () => {
    expect(decidirEscape({ sugerenciasAbiertas: true, turnoEnCurso: false })).toBe(
      "cerrar-sugerencias",
    );
    // Y manda sobre parar: si hay las dos cosas, primero se cierra el menú.
    expect(decidirEscape({ sugerenciasAbiertas: true, turnoEnCurso: true })).toBe(
      "cerrar-sugerencias",
    );
  });

  it("sin menú y con un turno en curso, para la respuesta", () => {
    expect(decidirEscape({ sugerenciasAbiertas: false, turnoEnCurso: true })).toBe("parar");
  });

  it("sin menú y sin turno no hace nada", () => {
    // Caso negativo: Escape no puede cancelar «por si acaso» cuando no hay
    // nada que cancelar — es la tecla que la gente aporrea.
    expect(decidirEscape({ sugerenciasAbiertas: false, turnoEnCurso: false })).toBe("nada");
  });
});

describe("seDisparaEscribiendo", () => {
  it("deja pasar lo que lleva modificador y las teclas que no escriben", () => {
    for (const c of ["Alt+C", "Ctrl+K", "ctrl+shift+p", "Escape", "F5"]) {
      expect(seDisparaEscribiendo(c)).toBe(true);
    }
  });

  it("no deja que una letra suelta robe el teclado", () => {
    // Caso negativo, y el que justifica la regla: el chat se usa escribiendo.
    // Un atajo "c" se comería la letra en cada palabra con ce.
    for (const c of ["c", "N", "1", "Enter", "", "   "]) {
      expect(seDisparaEscribiendo(c)).toBe(false);
    }
  });
});

describe("la paleta encuentra las acciones del chat en castellano", () => {
  const ETIQUETAS = [
    "Chat · abrir el panel de cambios",
    "Chat · conversación nueva",
    "Chat · parar la respuesta",
    "Ir a Consumo",
    "Ir a Sesiones",
  ];
  /** Lo que la paleta dejaría arriba: solo lo que casa, mejor puntuado antes. */
  const mejor = (q: string) =>
    ETIQUETAS.map((e) => ({ e, s: fuzzyScore(e, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)[0]?.e;

  it("se busca por lo que uno teclea de verdad", () => {
    expect(mejor("cam")).toBe("Chat · abrir el panel de cambios");
    expect(mejor("nueva")).toBe("Chat · conversación nueva");
    expect(mejor("parar")).toBe("Chat · parar la respuesta");
    expect(mejor("consumo")).toBe("Ir a Consumo");
  });

  it("sin tildes también encuentra", () => {
    // Nadie escribe «conversación» con tilde en una caja de búsqueda; el
    // comparador va carácter a carácter, así que hubo que normalizar.
    expect(mejor("conversacion")).toBe("Chat · conversación nueva");
    expect(fuzzyScore("Chat · conversación nueva", "conversación")).toBeGreaterThanOrEqual(0);
  });

  it("lo que no está no casa con nada", () => {
    // Caso negativo: un score >= 0 para cualquier cosa llenaría la paleta de
    // ruido y el cursor caería en una acción que nadie ha pedido.
    for (const e of ETIQUETAS) expect(fuzzyScore(e, "zzzq")).toBeLessThan(0);
    expect(mejor("zzzq")).toBeUndefined();
  });
});
