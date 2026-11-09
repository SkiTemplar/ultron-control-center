// Markdown del chat: GFM, callouts, fórmulas (KaTeX), HTML en bruto saneado
// (<details>, <kbd>…), resaltado de código, diagramas, tablas ordenables,
// rutas que abren VS Code e imágenes que abren el visor. El árbol ya procesado
// se guarda en una caché LRU por texto: una fila virtualizada que vuelve a la
// vista no repite el análisis, KaTeX ni el resaltado. Cada texto lleva su barrera
// de error: si no se puede pintar, se ve en crudo y el resto de la ventana sigue.

import "katex/dist/katex.min.css";
import { memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { ErrorBoundary } from "../ErrorBoundary";
import { Blockquote, CodeBlock, InlineCode, MdImage, MdLink, SortableTable } from "./md-blocks";
import { LruCache } from "./md-cache";
import { remarkStrictInlineMath } from "./md-math";
import { rehypeInlineMarks, remarkCallouts, remarkCodeMeta, remarkLocalImages, remarkLocalLinks, SANITIZE_SCHEMA } from "./md-plugins";

export { CopyButton } from "./CopyButton";

const PLAIN = ["text", "texto", "mermaid", "dot", "graphviz", "chart", "vega-lite", "vegalite", "diff"];

const components: Components = {
  pre: ({ children, node }) => {
    const code = node?.children?.[0];
    const meta = code && code.type === "element" ? code.properties?.dataMeta : undefined;
    return <CodeBlock meta={typeof meta === "string" ? meta : undefined}>{children}</CodeBlock>;
  },
  code: ({ children, className, node: _node, ...rest }) => <InlineCode className={className} {...rest}>{children}</InlineCode>,
  table: ({ children }) => <SortableTable>{children}</SortableTable>,
  blockquote: ({ children, className, node: _node, ...rest }) => <Blockquote className={className} {...rest}>{children}</Blockquote>,
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
  img: ({ src, alt }) => <MdImage src={typeof src === "string" ? src : undefined} alt={alt} />,
};

// `remarkStrictInlineMath` retoca lo que registra `remarkMath`: tiene que ir justo detrás.
const remarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkMath, remarkStrictInlineMath, remarkCallouts, remarkCodeMeta, remarkLocalImages, remarkLocalLinks];
// Orden: HTML en bruto → saneado → fórmulas y resaltado (generan HTML de
// confianza) → marcas propias.
const rehypePlugins: Options["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  [rehypeKatex, { throwOnError: false, output: "html" }],
  [rehypeHighlight, { detect: false, plainText: PLAIN }],
  rehypeInlineMarks,
];

/** Tope de la caché: entradas y caracteres de texto fuente (el árbol pesa en proporción). */
export const MD_CACHE_ENTRIES = 400;
export const MD_CACHE_CHARS = 2_000_000;

export const mdCache = new LruCache<ReactElement>(MD_CACHE_ENTRIES, MD_CACHE_CHARS, (key) => key.length);

function process(text: string): ReactElement {
  return ReactMarkdown({ children: text, remarkPlugins, rehypePlugins, components });
}

/**
 * Árbol de React del Markdown. Con `live` (texto en streaming, cambia por
 * fotograma) no se guarda: llenaría la caché de versiones intermedias.
 */
export function renderMarkdown(text: string, live = false): ReactElement {
  if (live) return process(text);
  const hit = mdCache.get(text);
  if (hit) return hit;
  const tree = process(text);
  mdCache.set(text, tree);
  return tree;
}

/** Barrera de un texto: `resetKey` hace que el siguiente fotograma del streaming lo reintente. */
function TextBoundary({ text, children }: { text: string; children: ReactNode }) {
  return (
    <ErrorBoundary scope="este texto" resetKey={text} detail={<pre className="md-raw">{text}</pre>}>
      {children}
    </ErrorBoundary>
  );
}

function MarkdownBody({ text, live }: { text: string; live: boolean }) {
  return <div className="md">{renderMarkdown(text, live)}</div>;
}

function MarkdownImpl({ text, live = false }: { text: string; live?: boolean }) {
  return <TextBoundary text={text}><MarkdownBody text={text} live={live} /></TextBoundary>;
}

export const Markdown = memo(MarkdownImpl);

/** Un trozo cerrado del texto en vivo: sus bloques salen sueltos, sin envoltorio propio. */
const LivePiece = memo(function LivePiece({ text }: { text: string }) {
  return renderMarkdown(text, true);
});

/**
 * Parte estable del texto en vivo troceada por párrafos (`splitBlocks`). Todos los
 * trozos van dentro del mismo `.md`, así el DOM y los márgenes son los de un solo
 * análisis, pero cada trozo se memoiza por su texto: al cerrar un párrafo solo se
 * analiza el nuevo, no toda la respuesta.
 */
export const MarkdownBlocks = memo(function MarkdownBlocks({ blocks }: { blocks: readonly string[] }) {
  return <div className="md">{blocks.map((b, i) => <TextBoundary key={i} text={b}><LivePiece text={b} /></TextBoundary>)}</div>;
}, (a, b) => a.blocks.length === b.blocks.length && a.blocks.every((x, i) => x === b.blocks[i]));
