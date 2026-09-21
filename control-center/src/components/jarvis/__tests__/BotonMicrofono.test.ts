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
  it("es un interruptor: encender o apagar, nada más", () => {
    expect(accionMic("apagado")).toBe("encender");
    expect(accionMic("espera")).toBe("apagar");
    expect(accionMic("escuchando")).toBe("apagar");
  });

  it("estando escuchando, el clic NO corta para enviar", () => {
    // Caso negativo del cambio pedido el 2026-09-21: "no que cuando le pulse
    // se corte y se envíe, eso debería poderse pulsando enter". Si esto
    // volviera a devolver "cortar", el botón mandaría el mensaje sin querer.
    expect(accionMic("escuchando")).toBe("apagar");
  });
});
