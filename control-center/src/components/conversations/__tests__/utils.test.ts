// Tests de las utilidades puras del navegador de conversaciones.

import { describe, it, expect } from "vitest";
import { bucketFor, cleanPreview, formatRel, projectNameFor, shortModel, titleFor } from "../utils";

const NOW = new Date("2026-09-17T12:00:00Z");

/** ISO de una fecha/hora LOCAL. Los cubos se calculan sobre el calendario
 *  local, asi que el test tiene que expresarse en local o depende de la zona
 *  horaria de la maquina (fallaba en Madrid escrito en UTC). */
function localIso(y: number, m: number, d: number, h = 12, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

describe("bucketFor", () => {
  it("usa dias de calendario, no ventanas de 24 h", () => {
    // 23:50 de ayer esta a pocas horas de distancia, pero es AYER.
    expect(bucketFor(localIso(2026, 9, 16, 23, 50), NOW)).toBe("Ayer");
    expect(bucketFor(localIso(2026, 9, 17, 0, 5), NOW)).toBe("Hoy");
  });

  it("clasifica las ventanas mas largas", () => {
    expect(bucketFor(localIso(2026, 9, 13, 10), NOW)).toBe("Últimos 7 días");
    expect(bucketFor(localIso(2026, 8, 30, 10), NOW)).toBe("Últimos 30 días");
    expect(bucketFor(localIso(2026, 1, 2, 10), NOW)).toBe("Más antiguo");
  });

  it("no revienta con fecha ausente o basura", () => {
    expect(bucketFor(null, NOW)).toBe("Sin fecha");
    expect(bucketFor("no-es-fecha", NOW)).toBe("Sin fecha");
  });
});

describe("cleanPreview", () => {
  it("convierte un comando de barra en su nombre y argumentos", () => {
    const raw =
      "<command-name>/jarvis</command-name><command-message>jarvis</command-message><command-args>arregla el login</command-args>";
    expect(cleanPreview(raw)).toBe("/jarvis arregla el login");
  });

  it("quita el envoltorio cuando el comando no lleva argumentos", () => {
    const raw =
      "<command-name>/ultron</command-name><command-message>ultron</command-message><command-args></command-args>";
    expect(cleanPreview(raw)).toBe("/ultron");
  });

  it("descarta los bloques inyectados por el harness", () => {
    const raw = "<system-reminder>no mires esto</system-reminder>arregla el login";
    expect(cleanPreview(raw)).toBe("arregla el login");
  });

  it("deja intacto un mensaje normal", () => {
    expect(cleanPreview("optimiza el shader del agua")).toBe("optimiza el shader del agua");
  });

  it("no inventa texto cuando solo hay etiquetas", () => {
    expect(cleanPreview("<command-args></command-args>")).toBe("");
  });
});

describe("titleFor", () => {
  it("cae al id corto cuando no hay texto utilizable", () => {
    expect(titleFor({ id: "abcdefgh-1234", preview: null })).toBe("Sesión abcdefgh");
    expect(titleFor({ id: "abcdefgh-1234", preview: "   " })).toBe("Sesión abcdefgh");
    // Caso real que motivo cleanPreview: puro envoltorio, cero contenido.
    expect(titleFor({ id: "abcdefgh-1234", preview: "<command-args></command-args>" })).toBe(
      "Sesión abcdefgh",
    );
  });

  it("recorta con puntos suspensivos", () => {
    const long = "a".repeat(200);
    const out = titleFor({ id: "x", preview: long }, 20);
    expect(out).toHaveLength(21);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("otros formateadores", () => {
  it("projectNameFor devuelve el ultimo segmento de la ruta", () => {
    expect(projectNameFor("C:/utad/portfolio")).toBe("portfolio");
    expect(projectNameFor("C:\\Users\\mokiu\\.ultron\\")).toBe(".ultron");
  });

  it("formatRel habla en español y no muestra futuro", () => {
    expect(formatRel("2026-09-17T11:59:30Z", NOW)).toBe("ahora mismo");
    expect(formatRel("2026-09-17T11:30:00Z", NOW)).toBe("hace 30 min");
    expect(formatRel("2026-09-17T09:00:00Z", NOW)).toBe("hace 3 h");
    expect(formatRel("2026-09-14T12:00:00Z", NOW)).toBe("hace 3 d");
    // Un timestamp en el futuro (reloj desajustado) no debe decir "hace -5 min".
    expect(formatRel("2026-09-17T12:05:00Z", NOW)).toBe("ahora mismo");
    expect(formatRel(null, NOW)).toBe("—");
  });

  it("shortModel quita el prefijo del proveedor", () => {
    expect(shortModel("claude-opus-5")).toBe("opus-5");
    expect(shortModel(null)).toBe("");
  });
});
