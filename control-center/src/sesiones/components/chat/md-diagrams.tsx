// Diagramas y gráficas del chat, cargados bajo demanda (cada librería va en
// su propio chunk): Mermaid, Graphviz (DOT, WASM) y Vega-Lite (con el
// intérprete de expresiones, sin `eval`, por la CSP). Se pueden alternar con el
// código fuente, ampliar en el visor y exportar a SVG o PNG. El SVG ya dibujado
// y la altura medida se guardan en cachés LRU: al volver a la vista una fila
// virtualizada, el diagrama sale al momento y con su altura (el scroll no salta).

import DOMPurify from "dompurify";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { openViewer } from "../../ui";
import { CopyButton } from "./CopyButton";
import { LruCache } from "./md-cache";

export type DiagramKind = "mermaid" | "dot" | "vega";

let seq = 0;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function svgDataUrl(svg: string): string {
  let bin = "";
  new TextEncoder().encode(svg).forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

async function svgToPng(svg: string): Promise<string> {
  const img = new Image();
  img.src = svgDataUrl(svg);
  await img.decode();
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, img.naturalWidth * scale);
  canvas.height = Math.max(1, img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("sin contexto 2D");
  ctx.fillStyle = cssVar("--bg") || "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function renderMermaid(code: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    // Sin foreignObject: el SVG se puede pasar a PNG sin «ensuciar» el canvas.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: cssVar("--f-mono"),
    themeVariables: {
      background: cssVar("--bg"),
      mainBkg: cssVar("--panel"),
      primaryColor: cssVar("--panel"),
      primaryTextColor: cssVar("--fg"),
      primaryBorderColor: cssVar("--accent"),
      secondaryColor: cssVar("--bg"),
      tertiaryColor: cssVar("--panel"),
      lineColor: cssVar("--muted"),
      textColor: cssVar("--fg"),
      nodeBorder: cssVar("--accent"),
      fontSize: "13px",
    },
  });
  seq += 1;
  const { svg } = await mermaid.render(`mmd-${seq}`, code);
  return svg;
}

async function renderDot(code: string): Promise<string> {
  const { instance } = await import("@viz-js/viz");
  const viz = await instance();
  const fg = cssVar("--fg");
  const font = "monospace";
  return viz.renderString(code, {
    format: "svg",
    engine: "dot",
    graphAttributes: { bgcolor: "transparent", fontcolor: fg, fontname: font },
    nodeAttributes: { color: cssVar("--accent"), fontcolor: fg, fontname: font, fillcolor: cssVar("--panel"), style: "filled" },
    edgeAttributes: { color: cssVar("--muted"), fontcolor: cssVar("--muted"), fontname: font },
  });
}

async function renderVega(code: string): Promise<string> {
  const host = document.createElement("div");
  const spec = JSON.parse(code) as Record<string, unknown>;
  const [{ default: embed }, { expressionInterpreter }] = await Promise.all([import("vega-embed"), import("vega-interpreter")]);
  const res = await embed(host, spec, {
    actions: false,
    renderer: "svg",
    ast: true,
    expr: expressionInterpreter,
    config: {
      background: "transparent",
      font: cssVar("--f-mono"),
      axis: { labelColor: cssVar("--muted"), titleColor: cssVar("--fg"), gridColor: cssVar("--line"), domainColor: cssVar("--line") },
      legend: { labelColor: cssVar("--muted"), titleColor: cssVar("--fg") },
      title: { color: cssVar("--fg") },
      mark: { color: cssVar("--accent") },
      view: { stroke: null, continuousWidth: 420, discreteWidth: { step: 56 } },
      range: { category: [cssVar("--accent"), cssVar("--info"), cssVar("--ok"), cssVar("--warn"), cssVar("--err"), cssVar("--muted")] },
    },
  });
  const svg = await res.view.toSVG();
  res.finalize();
  return svg;
}

// Instancia propia: el gancho no debe afectar al DOMPurify que usa Mermaid por dentro.
const svgPurify = DOMPurify(window);
svgPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName.toLowerCase() !== "a") return;
  node.removeAttribute("href");
  node.removeAttribute("xlink:href");
});

/**
 * SVG saneado: sin scripts ni manejadores, y los enlaces quedan sin destino. Un clic
 * en `<a>` navegaría la propia ventana de la app a una web ajena, sin forma de volver.
 */
export function cleanSvg(svg: string): string {
  return svgPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

/** SVG saneado por diagrama y tema: tope de entradas y de caracteres. */
export const svgCache = new LruCache<string>(60, 8_000_000, (_key, svg) => svg.length);
/** Altura medida de cada diagrama, para reservarla mientras se vuelve a dibujar. */
export const heightCache = new LruCache<number>(500, 500);

/** Clave del diagrama: tipo, tema (los colores salen de las variables CSS) y código. */
export function diagramKey(kind: DiagramKind, code: string): string {
  const theme = ["--bg", "--fg", "--accent", "--panel", "--f-mono"].map(cssVar).join("|");
  return `${kind}\u0000${theme}\u0000${code}`;
}

/**
 * Espera desde el último cambio del código antes de redibujar. En streaming cada
 * delta cambia el código: sin la espera se dibujaba (o fallaba) el diagrama a
 * medias en cada trozo. El primer dibujo de un bloque ya completo no espera.
 */
export const DIAGRAM_SETTLE_MS = 400;

function useRendered(kind: DiagramKind, code: string, key: string) {
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const firstKey = useRef(key);
  useEffect(() => {
    const cached = svgCache.get(key);
    if (cached) {
      setSvg(cached);
      setError(null);
      return;
    }
    let alive = true;
    const draw = () => {
      const job = kind === "mermaid" ? renderMermaid(code) : kind === "dot" ? renderDot(code) : renderVega(code);
      job.then(
        (s) => {
          const clean = cleanSvg(s);
          svgCache.set(key, clean);
          if (!alive) return;
          setSvg(clean);
          setError(null);
        },
        (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
      );
    };
    // Mientras tanto se queda el último dibujo bueno (o el error anterior).
    const timer = key === firstKey.current ? null : window.setTimeout(draw, DIAGRAM_SETTLE_MS);
    if (timer === null) draw();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [kind, code, key]);
  return { svg, error };
}

const LABEL: Record<DiagramKind, string> = { mermaid: "mermaid", dot: "graphviz", vega: "gráfica" };

export function Diagram({ kind, code }: { kind: DiagramKind; code: string }) {
  const api = useApi();
  const host = useRef<HTMLDivElement>(null);
  const [showCode, setShowCode] = useState(false);
  const key = useMemo(() => diagramKey(kind, code), [kind, code]);
  const { svg, error } = useRendered(kind, code, key);

  // Antes de pintar: la fila se mide ya con el diagrama dentro.
  useLayoutEffect(() => {
    // `svg` llega saneado por cleanSvg (DOMPurify, perfil SVG).
    if (!host.current || !svg || showCode) return;
    host.current.innerHTML = svg;
    const h = host.current.offsetHeight;
    if (h > 0) heightCache.set(key, h);
  }, [svg, showCode, key]);

  const name = `${LABEL[kind]}-${new Date().toISOString().slice(0, 10)}`;
  const save = (png: boolean) => {
    if (!svg) return;
    (png ? svgToPng(svg) : Promise.resolve(svgDataUrl(svg)))
      .then((url) => api.saveImage(url, name))
      .catch(reportError);
  };

  return (
    <div className="codeblock diagram" data-kind={kind}>
      <div className="cb-head">
        <span>{LABEL[kind]}</span>
        <span className="cb-acts">
          <button className="copy" onClick={() => setShowCode((v) => !v)}>{showCode ? "Diagrama" : "Código"}</button>
          {svg && <button className="copy" onClick={() => openViewer(svgDataUrl(svg), LABEL[kind])}>Ampliar</button>}
          {svg && <button className="copy" onClick={() => save(false)}>SVG</button>}
          {svg && <button className="copy" onClick={() => save(true)}>PNG</button>}
          <CopyButton text={code} />
        </span>
      </div>
      {showCode || error ? (
        <>
          {error && <p className="diagram-err">No se pudo dibujar: {error}</p>}
          <pre>{code}</pre>
        </>
      ) : (
        <div ref={host} className="diagram-body" role="img" aria-label={`Diagrama ${LABEL[kind]}`}
          style={svg ? undefined : { minHeight: heightCache.get(key) }}>
          {!svg && <span className="loading">Dibujando…</span>}
        </div>
      )}
    </div>
  );
}
