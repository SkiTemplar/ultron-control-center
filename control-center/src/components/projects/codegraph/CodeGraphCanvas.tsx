// Lienzo del visor CodeGraph: pinta el grafo con Graphviz (@viz-js/viz, la
// misma librería que ya pinta los bloques `dot` del chat de Sessions) y
// traduce el clic sobre un nodo del SVG al nodo del índice.

import { useEffect, useRef, useState, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { nodeIndexFromSvgId, toDot, type CgNode, type CgView } from "../../../lib/codegraph";

type Props = {
  view: CgView;
  selectedId: string | null;
  onNodeClick: (node: CgNode) => void;
};

type VizInstance = { renderString: (dot: string, opts: Record<string, unknown>) => string };

let vizPromise: Promise<VizInstance> | null = null;

/** Graphviz se carga una vez (WASM, ~1,5 MB) y solo al abrir el visor. */
function loadViz(): Promise<VizInstance> {
  if (!vizPromise) {
    vizPromise = import("@viz-js/viz")
      .then((m) => m.instance())
      .catch((e: unknown) => {
        vizPromise = null; // el siguiente intento vuelve a probar
        throw e;
      });
  }
  return vizPromise;
}

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

async function renderSvg(dot: string): Promise<string> {
  const viz = await loadViz();
  const fg = cssVar("--color-text", "#e5e7eb");
  const svg = viz.renderString(dot, {
    format: "svg",
    engine: "dot",
    graphAttributes: { bgcolor: "transparent", fontcolor: fg, fontname: "monospace" },
    nodeAttributes: {
      color: cssVar("--color-accent", "#60a5fa"),
      fontcolor: fg,
      fontname: "monospace",
      fillcolor: cssVar("--color-surface-2", "#1f2937"),
      style: "filled",
    },
    edgeAttributes: {
      color: cssVar("--color-text-tertiary", "#9ca3af"),
      fontcolor: cssVar("--color-text-tertiary", "#9ca3af"),
      fontname: "monospace",
    },
  });
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
}

export function CodeGraphCanvas({ view, selectedId, onNodeClick }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (view.nodes.length === 0) {
      setSvg(null);
      return;
    }
    // Solo cuenta el último render: uno lento no puede pisar a uno posterior.
    const mine = ++seq.current;
    setError(null);
    renderSvg(toDot(view, selectedId))
      .then((out) => {
        if (seq.current === mine) setSvg(out);
      })
      .catch((e: unknown) => {
        if (seq.current === mine) setError(`No se pudo dibujar el grafo: ${String(e)}`);
      });
  }, [view, selectedId]);

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const group = (e.target as Element).closest?.("g.node");
    const index = nodeIndexFromSvgId(group?.getAttribute("id"));
    if (index === null) return;
    const node = view.nodes[index];
    if (node) onNodeClick(node);
  };

  if (error) {
    return (
      <p className="p-4 text-[12px]" style={{ color: "var(--color-danger, #ef4444)" }} role="alert">
        {error}
      </p>
    );
  }
  if (view.nodes.length === 0) {
    return (
      <p className="p-4 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
        Busca un símbolo o elige un fichero para ver su vecindario. Clic en un nodo para
        expandirlo.
      </p>
    );
  }
  if (svg === null) {
    return (
      <p className="p-4 text-[12px]" style={{ color: "var(--color-text-tertiary)" }} role="status">
        Dibujando el grafo…
      </p>
    );
  }
  return (
    <div
      className="codegraph-canvas h-full w-full cursor-pointer overflow-auto p-2 [&_svg]:max-w-none"
      data-testid="codegraph-canvas"
      onClick={handleClick}
      // SVG de Graphviz generado aquí y saneado con DOMPurify.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
