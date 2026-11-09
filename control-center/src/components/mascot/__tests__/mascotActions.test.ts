// Acciones de la mascota (mascotActions.ts): un fallo del backend llega al
// bocadillo de avisos en vez de tragarse.

import { describe, expect, it, vi } from "vitest";
import { outranks } from "../deskAlerts";
import { actionErrorText, approvalFailureWhat, copyText, runAction } from "../mascotActions";

describe("acciones de la mascota", () => {
  it("un «Permitir» tras el plazo devuelve el motivo y dice que no se ejecutó", async () => {
    const invoke = vi.fn().mockRejectedValue("esa confirmación ya no está pendiente");
    const err = await runAction(invoke, "mascot_approve_answer", { id: "x", allow: true }, approvalFailureWhat(true));
    expect(invoke).toHaveBeenCalledWith("mascot_approve_answer", { id: "x", allow: true });
    expect(err).toContain("NO se ha ejecutado");
    expect(err).toContain("ya no está pendiente");
  });

  it("caso negativo: si el backend responde, no hay aviso", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    expect(await runAction(invoke, "mascot_set_hidden", { hidden: true }, "No me pude esconder")).toBeNull();
  });

  it("el texto del error sale de un Error, de una cadena o de nada", () => {
    expect(actionErrorText("No se pudo", new Error("boom"))).toBe("No se pudo: boom");
    expect(actionErrorText("No se pudo", "  ")).toBe("No se pudo: error desconocido");
    expect(actionErrorText("No se pudo", undefined)).toBe("No se pudo: error desconocido");
  });

  it("copiar sin portapapeles o con permiso denegado avisa; si copia, no", async () => {
    expect(await copyText(undefined, "x")).toContain("sin acceso al portapapeles");
    const denied = { writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) };
    expect(await copyText(denied, "x")).toBe("No se pudo copiar: NotAllowedError");
    const ok = { writeText: vi.fn().mockResolvedValue(undefined) };
    expect(await copyText(ok, "hola")).toBeNull();
    expect(ok.writeText).toHaveBeenCalledWith("hola");
  });

  it("el aviso de error pisa a los demás y ninguno lo pisa a él", () => {
    expect(outranks("error", "sessions")).toBe(true);
    expect(outranks("sessions", "error")).toBe(false);
    expect(outranks("calendar", "error")).toBe(false);
  });
});
