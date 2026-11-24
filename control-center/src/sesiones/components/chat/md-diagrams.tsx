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

/** Lado largo del PNG exportado: calidad de impresión sin pasar del límite de canvas de WebView2. */
export const PNG_LONG_SIDE = 8192;
/** Tope de área del canvas (px²): por encima, Chromium devuelve un canvas vacío. */
export const PNG_MAX_AREA = 64_000_000;
/** `sesiones_save_image` rechaza más de 20 MB; el data URL en base64 ocupa 4/3. */
const MAX_DATA_URL = Math.floor((20 * 1024 * 1024 * 4) / 3);

const LENGTH = /^\s*([\d.]+)\s*(px|pt)?\s*$/;

function attrLength(v: string | null): number | null {
  const m = v ? LENGTH.exec(v) : null;
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "pt" ? 4 / 3 : 1);
  return n > 0 ? n : null;
}

/**
 * Tamaño propio del SVG: el `viewBox` manda (Mermaid declara `width="100%"` y sin él el
 * navegador rasteriza a 300×150); si no hay, `width`/`height` absolutos.
 */
export function svgIntrinsicSize(svg: string): { w: number; h: number } | null {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (root.nodeName !== "svg") return null;
  const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  const w = attrLength(root.getAttribute("width"));
  const h = attrLength(root.getAttribute("height"));
  return w && h ? { w, h } : null;
}

/** Tamaño del PNG: lado largo `longSide`, sin pasar de `PNG_MAX_AREA`, proporción intacta. */
export function pngTargetSize(w: number, h: number, longSide = PNG_LONG_SIDE): { w: number; h: number } {
  const byLong = longSide / Math.max(w, h);
  const byArea = Math.sqrt(PNG_MAX_AREA / (w * h));
  const scale = Math.min(byLong, byArea);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** El SVG con tamaño absoluto: así se rasteriza como vector al tamaño final, no se amplía un mapa de bits. */
function sizedSvg(svg: string, w: number, h: number): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  root.setAttribute("width", String(w));
  root.setAttribute("height", String(h));
  root.removeAttribute("style");
  return new XMLSerializer().serializeToString(doc);
}

async function rasterize(svg: string, w: number, h: number): Promise<string> {
  const img = new Image();
  img.src = svgDataUrl(sizedSvg(svg, w, h));
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("sin contexto 2D");
  ctx.fillStyle = cssVar("--bg") || "#111";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

async function svgToPng(svg: string): Promise<string> {
  const size = svgIntrinsicSize(svg) ?? { w: 1024, h: 768 };
  // Un PNG que pase de 20 MB (gráficas con mucho ruido) se rehace a la mitad.
  for (let long = PNG_LONG_SIDE; long >= 1024; long /= 2) {
    const t = pngTargetSize(size.w, size.h, long);
    const url = await rasterize(svg, t.w, t.h);
    if (url.length <= MAX_DATA_URL) return url;
  }
  throw new Error("el PNG supera 20 MB incluso a 1024 px");
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
