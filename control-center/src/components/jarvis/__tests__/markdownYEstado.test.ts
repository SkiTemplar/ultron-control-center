import { describe, expect, it } from "vitest";
import { artefactosDe, tipoDeBloque } from "../Markdown";
import { estadoGlobal } from "../../../lib/status";
import { normalizaUrl } from "../PanelLateral";
import { consumoDe } from "../MariaChat";
import type { AlertEntry } from "../../../types";

describe("artefactos del chat", () => {
  it("html, svg y mermaid se pueden abrir; el resto no", () => {
    expect(tipoDeBloque("html", "<p>hola</p>")).toBe("html");
    expect(tipoDeBloque("HTML", "<p>hola</p>")).toBe("html");
    expect(tipoDeBloque("svg", "<svg></svg>")).toBe("svg");
    expect(tipoDeBloque("mermaid", "graph TD; A-->B")).toBe("mermaid");
    expect(tipoDeBloque("rust", "fn main() {}")).toBeNull();
    expect(tipoDeBloque("", "texto")).toBeNull();
  });

  it("un bloque xml solo es artefacto si de verdad es un svg", () => {
    expect(tipoDeBloque("xml", '<svg viewBox="0 0 1 1"></svg>')).toBe("svg");
    expect(tipoDeBloque("xml", "<config><a/></config>")).toBeNull();
  });

  it("saca los artefactos de un mensaje en orden y sin la valla", () => {
    const texto = [
      "Aquí va:",
      "```html",
      "<h1>uno</h1>",
      "```",
      "y un script que no cuenta:",
      "```python",
      "print(1)",
      "```",
      "```mermaid",
      "graph TD; A-->B",
      "```",
    ].join("\n");
    const a = artefactosDe(texto);
    expect(a.map((x) => x.tipo)).toEqual(["html", "mermaid"]);
    expect(a[0].codigo).toBe("<h1>uno</h1>");
  });
});

describe("estado global", () => {
  const AHORA = Date.parse("2026-09-21T18:00:00Z");
  const aviso = (severity: string, horasAtras: number): AlertEntry => ({
    severity,
    source: "ui.promise",
    message: "Command plugin:shell|open not allowed by ACL",
    timestamp: new Date(AHORA - horasAtras * 3_600_000).toISOString(),
  });

  it("un aviso de ayer ya no tiene el pie en amarillo", () => {
    // El caso real del 2026-09-21: tres avisos del dia anterior.
    expect(estadoGlobal([aviso("warn", 20), aviso("warn", 19)], AHORA).status).toBe("ok");
  });

  it("un aviso reciente si, y dice por que", () => {
    const e = estadoGlobal([aviso("warn", 1), aviso("warn", 2)], AHORA);
    expect(e.status).toBe("warn");
    expect(e.vigentes).toBe(2);
    expect(e.motivo).toContain("ui.promise");
    expect(e.motivo).toContain("1 más");
  });

  it("lo critico manda sobre lo demas y aguanta un dia", () => {
    expect(estadoGlobal([aviso("warn", 1), aviso("critical", 20)], AHORA).status).toBe("down");
    expect(estadoGlobal([aviso("critical", 30)], AHORA).status).toBe("ok");
  });

  it("sin avisos, operativo y sin motivo", () => {
    expect(estadoGlobal([], AHORA)).toEqual({ status: "ok", motivo: "", vigentes: 0 });
  });
});

describe("panel web", () => {
  it("completa el esquema y no deja pasar lo que no es web", () => {
    expect(normalizaUrl(" localhost:5173 ")).toBe("http://localhost:5173");
    expect(normalizaUrl("ejemplo.com/a")).toBe("https://ejemplo.com/a");
    expect(normalizaUrl("https://x.test")).toBe("https://x.test");
    for (const mala of ["file:///C:/x", "javascript:alert(1)", "", "dos palabras"]) {
      expect(normalizaUrl(mala)).toBeNull();
    }
  });
});

describe("consumo de un turno", () => {
  const base = { ts: "2026-09-22T10:00:00Z", role: "assistant", provider: "claude", text: "hola" };

  it("pinta tiempo, tokens y coste cuando el proveedor los da", () => {
    expect(
      consumoDe({ ...base, ms: 12400, tokens_in: 8120, tokens_out: 1200, coste_usd: 0.0312 }),
    ).toBe("12,4 s · 8,1k↑/1,2k↓ · ~0,0312 $");
  });

  it("los milisegundos de un turno corto se dicen en ms", () => {
    expect(consumoDe({ ...base, ms: 840, tokens_in: 10, tokens_out: 5 })).toBe("840 ms · 10↑/5↓");
  });

  it("donde el proveedor no cuenta tokens se escribe «sin dato», no un cero", () => {
    // Caso negativo: agy y el modelo local no publican consumo. Un "0↑/0↓"
    // sería una cifra inventada; el tiempo sí lo mide mar.ia.
    expect(consumoDe({ ...base, provider: "antigravity", ms: 5000 })).toBe("5,0 s · tokens: sin dato");
    // Y sin coste no se estima ninguno: codex no lo publica.
    expect(consumoDe({ ...base, provider: "codex", ms: 2000, tokens_in: 4300, tokens_out: 210 })).toBe(
      "2,0 s · 4,3k↑/210↓",
    );
  });

  it("un turno viejo, sin ninguno de los campos, no ensucia la pantalla", () => {
    expect(consumoDe(base)).toBe("tokens: sin dato");
  });
});
