// Tamaño de letra del texto de los mensajes: preferencia propia, separada de la
// escala de toda la interfaz, que se aplica con la variable CSS --chat-fs.

// @ts-expect-error -- el proyecto no instala @types/node; vitest corre en Node.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { applyPrefs, CHAT_FONT_SIZES, DEFAULT_PREFS, sanitizePrefs } from "../prefs";

// Con «?raw» vitest entrega los .css vacíos: se leen del disco.
// Ruta a partir de import.meta.url sin URL(): en jsdom resuelve contra http://localhost.
const STYLES_DIR = decodeURIComponent(import.meta.url.replace(/^file:\/\/\/?/, "")).replace(/__tests__\/[^/]+$/, "styles/");
const readCss = (name: string): string => readFileSync(STYLES_DIR + name, "utf8");
const chatCss = readCss("chat.css");
const inspectorCss = readCss("inspector.css");

describe("chatFontSize", () => {
  afterEach(() => document.documentElement.style.removeProperty("--chat-fs"));

  it("acepta los tamaños de la lista", () => {
    for (const size of CHAT_FONT_SIZES) {
      expect(sanitizePrefs({ chatFontSize: size }).chatFontSize).toBe(size);
    }
  });

  it("vuelve al valor por defecto con un tamaño fuera de la lista o de otro tipo", () => {
    expect(sanitizePrefs({ chatFontSize: 40 }).chatFontSize).toBe(DEFAULT_PREFS.chatFontSize);
    expect(sanitizePrefs({ chatFontSize: "15" }).chatFontSize).toBe(DEFAULT_PREFS.chatFontSize);
    expect(sanitizePrefs(null).chatFontSize).toBe(DEFAULT_PREFS.chatFontSize);
  });

  it("publica el tamaño en la variable --chat-fs", () => {
    applyPrefs({ ...DEFAULT_PREFS, chatFontSize: 15 });
    expect(document.documentElement.style.getPropertyValue("--chat-fs")).toBe("15px");
  });
});

// Las cajas del markdown (callouts, tablas, código, títulos) tienen que seguir a
// --chat-fs: con un tamaño fijo en px no crecen al subir la letra de los mensajes.
describe("tamaños relativos del markdown", () => {
  const MD_SELECTOR = /(^|[\s,])(\.md\b|\.callout|\.codeblock|\.cb-body|\.linkcard|\.img-miss)/;
  const PX_FONT = /font(-size)?:\s*(\d+\s+)?[\d.]+px/;

  it("ninguna regla del markdown fija la letra en px", () => {
    const offenders = chatCss
      .split("\n")
      .filter((line: string) => MD_SELECTOR.test(line.split("{")[0] ?? "") && PX_FONT.test(line));
    expect(offenders).toEqual([]);
  });

  it("el inspector no redefine .callout, que es la clase de los avisos del chat", () => {
    expect(inspectorCss).not.toMatch(/(^|[\s,}])\.callout\b/m);
  });
});

describe("títulos y tablas del markdown", () => {
  const rule = (selector: string) => chatCss.split("\n").filter((line: string) => line.startsWith(selector)).join("\n");

  it("los títulos no llevan el prefijo # literal de la sintaxis", () => {
    expect(chatCss).not.toMatch(/\.md h[1-4]::before/);
  });

  it("las celdas de las tablas parten línea en vez de forzar el desplazamiento", () => {
    expect(rule(".md th, .md td {")).toMatch(/white-space: normal/);
  });
});

it("lee los CSS de verdad (con contenido)", () => {
  expect(chatCss).toContain(".callout-title");
  expect(inspectorCss).toContain(".insp-callout");
});
