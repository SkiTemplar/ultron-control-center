// Fluidez del texto en vivo: la parte estable se trocea por párrafos y cada trozo
// se memoiza, así un delta no vuelve a analizar toda la respuesta. Se comprueba
// que el corte no cambia lo que se pinta y que el coste deja de ser cuadrático.

import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Markdown, MarkdownBlocks } from "../components/chat/Markdown";
import { splitBlocks, splitStable } from "../components/chat/terminal-format";
import { ApiContext } from "../context";
import { deltas, liveText } from "./fixtures/live-text";

// Cuenta los caracteres que llegan al analizador de Markdown (el coste que importa).
const parsed = vi.hoisted(() => ({ chars: 0 }));
vi.mock("react-markdown", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-markdown")>();
  const counted = (options: Parameters<typeof mod.default>[0]) => {
    parsed.chars += options.children?.length ?? 0;
    return mod.default(options);
  };
  return { ...mod, default: counted };
});

const api = {} as SesionesApi;

/** HTML sin los nodos de texto en blanco entre bloques (no se pintan). */
function html(el: Element): string {
  return el.innerHTML.replace(/>\s+</g, "><");
}

describe("splitBlocks", () => {
  it("los trozos y la cola reconstruyen el texto y coinciden con splitStable", () => {
    const text = liveText(4).slice(0, 3000);
    const { blocks, tail } = splitBlocks(text);
    expect(blocks.length).toBeGreaterThan(3);
    expect(blocks.join("") + tail).toBe(text);
    expect(blocks.join("")).toBe(splitStable(text).stable);
  });

  it("no trocea dentro de listas, citas ni bloques de código", () => {
    expect(splitBlocks("1. a\n\n2. b\n\nfin\n\nx").blocks).toEqual(["1. a\n\n2. b\n\n", "fin\n\n"]);
    expect(splitBlocks("```ts\nconst a = 1\n\nconst b = 2\n```\n\nluego").blocks).toEqual(["```ts\nconst a = 1\n\nconst b = 2\n```\n\n"]);
  });

  it("con construcciones que cruzan bloques, la parte estable va entera (caso negativo)", () => {
    const html = "<details>\n\ncuerpo\n\n</details>\n\nsigue\n\nfin";
    expect(splitBlocks(html).blocks).toEqual(["<details>\n\ncuerpo\n\n</details>\n\nsigue\n\n"]);
    const ref = "ver [doc][d]\n\n[d]: https://example.com\n\notro\n\nfin";
    expect(splitBlocks(ref).blocks).toHaveLength(1);
    const foot = "nota[^1]\n\n[^1]: pie\n\nfin";
    expect(splitBlocks(foot).blocks).toHaveLength(1);
  });

  it("sin párrafo cerrado no hay trozos", () => {
    expect(splitBlocks("sin cierre")).toEqual({ blocks: [], tail: "sin cierre" });
  });
});

describe("MarkdownBlocks", () => {
  it("pinta lo mismo que analizar la parte estable de una vez", () => {
    const text = liveText(6);
    const { blocks } = splitBlocks(text);
    const whole = render(<ApiContext.Provider value={api}><Markdown text={blocks.join("")} live /></ApiContext.Provider>);
    const pieces = render(<ApiContext.Provider value={api}><MarkdownBlocks blocks={blocks} /></ApiContext.Provider>);
    expect(html(pieces.container)).toBe(html(whole.container));
  });

  /**
   * Medido el 2026-10-13 (Windows, vitest + jsdom), respuesta de 10 KB en 174
   * deltas de 60 caracteres con render real: antes ~1.870 ms (10,8 ms por delta,
   * picos de 40-76 ms); con los trozos memoizados ~330 ms (1,9 ms por delta).
   * El test no mide tiempo (depende de la máquina): cuenta los caracteres que pasan
   * por el analizador, que es lo que crecía de forma cuadrática.
   */
  it("un delta no vuelve a analizar la parte estable entera: al menos 5 veces menos texto analizado", () => {
    const text = liveText(10);
    const steps = deltas(text, 60);
    const wrap = (node: ReactNode) => <ApiContext.Provider value={api}>{node}</ApiContext.Provider>;
    const measure = (view: (acc: string) => ReactNode): number => {
      let acc = "";
      const r = render(wrap(view("")));
      parsed.chars = 0;
      for (const d of steps) {
        acc += d;
        act(() => r.rerender(wrap(view(acc))));
      }
      r.unmount();
      return parsed.chars;
    };
    const before = measure((acc) => {
      const { stable, tail } = splitStable(acc);
      return <>{stable && <Markdown text={stable} live />}{tail && <Markdown text={tail} live />}</>;
    });
    const after = measure((acc) => {
      const { blocks, tail } = splitBlocks(acc);
      return <>{blocks.length > 0 && <MarkdownBlocks blocks={blocks} />}{tail && <Markdown text={tail} live />}</>;
    });
    expect(after * 5).toBeLessThan(before);
  }, 60_000);
});
