// Guarda de cascada (2026-09-23). Tailwind 4 mete sus utilidades en
// `@layer utilities` y una regla SIN capa gana a cualquier capa, sea cual sea
// la especificidad. Si una clase propia fija `position` fuera de capa, un
// `absolute` de Tailwind en el mismo elemento no hace nada: así el menú de «/»
// del chat se quedaba en el flujo (se comía el historial y tapaba la
// cabecera) y el desplegable de HudSelect empujaba lo de debajo.
//
// jsdom no aplica capas de cascada, así que no sirve renderizar y medir: se
// lee la hoja y el código tal cual.
import { beforeAll, describe, expect, it } from "vitest";

const POSICION = ["absolute", "fixed", "sticky", "relative", "static"];

/** Clases que fijan `position` en una regla fuera de cualquier `@layer`. */
function clasesConPosicionSinCapa(css: string): string[] {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const pila: string[] = [];
  const fuera = new Set<string>();
  let cabecera = "";
  let cuerpoDesde = -1;
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (c === "{") {
      pila.push(cabecera.trim());
      cabecera = "";
      cuerpoDesde = i + 1;
    } else if (c === "}") {
      const sel = pila.pop() ?? "";
      const cuerpo = cuerpoDesde >= 0 ? limpio.slice(cuerpoDesde, i) : "";
      cuerpoDesde = -1;
      const enCapa = pila.some((h) => h.startsWith("@layer"));
      if (!enCapa && !sel.startsWith("@") && /(^|[;\s])position\s*:/.test(cuerpo)) {
        for (const parte of sel.split(",")) {
          const m = parte.trim().match(/^\.([A-Za-z0-9_-]+)$/);
          if (m) fuera.add(m[1]);
        }
      }
      cabecera = "";
    } else if (c === ";" && cuerpoDesde < 0) {
      cabecera = "";
    } else {
      cabecera += c;
    }
  }
  return [...fuera].sort();
}

/** Cadenas de clases que juntan una clase de `clases` con una utilidad de posición. */
function choquesDePosicion(codigo: string, clases: string[]): string[] {
  const choques: string[] = [];
  for (const m of codigo.matchAll(/["'`]([^"'`\n]{1,400})["'`]/g)) {
    const fichas = m[1].split(/\s+/);
    const propia = clases.find((c) => fichas.includes(c));
    const util = fichas.find((f) => POSICION.includes(f));
    if (propia && util && util !== "relative") choques.push(`${propia} + ${util}: "${m[1]}"`);
  }
  return choques;
}

// Todo el código de la interfaz, como texto (sin los tests).
const CODIGO = Object.entries(
  import.meta.glob<string>(["./**/*.tsx", "!./**/*.test.tsx"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

// La hoja se lee del disco: vitest entrega los .css VACÍOS aunque lleven
// `?raw`, y con una hoja vacía la guarda pasaría sin mirar nada. `fs` se carga
// con un nombre en variable porque el tsconfig de la app no trae tipos de Node.
let css = "";
beforeAll(async () => {
  const modulo = "node:fs";
  const fs = (await import(/* @vite-ignore */ modulo)) as {
    readFileSync: (ruta: string, cod: string) => string;
  };
  const proceso = (globalThis as unknown as { process: { cwd(): string } }).process;
  css = fs.readFileSync(`${proceso.cwd()}/src/styles.css`, "utf8");
});

describe("cascada de styles.css frente a las utilidades de Tailwind", () => {
  it("la hoja se ha leído de verdad", () => {
    expect(css).toContain(".hud-panel");
    expect(css.length).toBeGreaterThan(5000);
  });

  it("ninguna clase propia sin capa pisa un absolute/fixed/sticky del código", () => {
    const sinCapa = clasesConPosicionSinCapa(css);
    expect(CODIGO.length).toBeGreaterThan(20);
    const choques = CODIGO.flatMap(([f, codigo]) =>
      choquesDePosicion(codigo, sinCapa).map((c) => `${f}: ${c}`),
    );
    expect(choques).toEqual([]);
  });

  it("hud-panel vive en @layer components (los menús flotantes dependen de ello)", () => {
    expect(clasesConPosicionSinCapa(css)).not.toContain("hud-panel");
    expect(css).toMatch(/@layer components\s*\{\s*\.hud-panel\s*\{/);
  });

  it("caso negativo: la misma regla sin capa SÍ se detecta", () => {
    const suelta = ".caja { position: relative; color: red; }\n.otra::before { position: absolute; }";
    expect(clasesConPosicionSinCapa(suelta)).toEqual(["caja"]);
    expect(choquesDePosicion('<ul className="caja absolute left-0">', ["caja"])).toHaveLength(1);
    const enCapa = "@layer components {\n  .caja { position: relative; }\n}";
    expect(clasesConPosicionSinCapa(enCapa)).toEqual([]);
  });
});
