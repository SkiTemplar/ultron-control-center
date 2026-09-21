import { describe, expect, it } from "vitest";
import { accionMic, estadoMic } from "../BotonMicrofono";

describe("estadoMic", () => {
  it("con el micrófono apagado da apagado, diga lo que diga la voz", () => {
    // Caso negativo y el importante: el botón NO puede pintar "escuchando"
    // con el micrófono cerrado. Que la pantalla diga una cosa y el audio haga
    // otra es justo lo que el usuario pidió que no pasara (2026-09-21).
    for (const voz of ["idle", "listening", "thinking", "speaking", "offline"] as const) {
      expect(estadoMic(false, voz)).toBe("apagado");
    }
  });

  it("con el micrófono abierto y la voz en reposo, queda en espera", () => {
    expect(estadoMic(true, "idle")).toBe("espera");
    expect(estadoMic(true, "thinking")).toBe("espera");
    expect(estadoMic(true, "speaking")).toBe("espera");
  });

  it("escuchando solo cuando de verdad se está escuchando", () => {
    expect(estadoMic(true, "listening")).toBe("escuchando");
  });
});

describe("accionMic", () => {
  it("cada estado tiene una acción distinta y ninguna se repite", () => {
    // Un botón de tres estados en el que dos hicieran lo mismo sería un botón
    // de dos estados mal dibujado.
    const acciones = (["apagado", "espera", "escuchando"] as const).map(accionMic);
    expect(acciones).toEqual(["encender", "escuchar", "cortar"]);
    expect(new Set(acciones).size).toBe(3);
  });

  it("apagado nunca empieza a escuchar directamente", () => {
    // Del todo apagado se pasa a "en espera", no a captura activa: encender el
    // micrófono no puede significar ponerse a grabar sin avisar.
    expect(accionMic("apagado")).not.toBe("escuchar");
  });
});
