// Piezas puras del Markdown del chat: callouts al estilo GitHub, marcas de
// código en línea y de ✓/✗, esquema de saneado del HTML en bruto y utilidades
// de rutas y tablas. Sin React, para poder probarlas.

import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import { isNetworkPath } from "../inspector/rutas-sesion";

// --- Árboles mínimos (mdast / hast) sin depender de los paquetes de tipos ---

interface Node {
  type: string;
  value?: string;
  meta?: string | null;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

// --- Callouts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION] ---

export const CALLOUTS = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutKind = (typeof CALLOUTS)[number];
const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i;

function markCallout(quote: Node): void {
  const para = quote.children?.[0];
  const first = para?.type === "paragraph" ? para.children?.[0] : undefined;
  if (first?.type !== "text" || !first.value) return;
  const m = CALLOUT_RE.exec(first.value);
  if (!m) return;
  first.value = first.value.slice(m[0].length);
  const kind = m[1].toLowerCase();
  quote.data = { ...quote.data, hProperties: { className: ["callout", `callout-${kind}`], dataCallout: kind } };
}

function walk(node: Node, fn: (n: Node, parent: Node | null) => void, parent: Node | null = null): void {
  fn(node, parent);
  node.children?.forEach((c) => walk(c, fn, node));
}

/** remark: el meta de la valla (```ts src/a.ts) viaja como `data-meta` (el saneado borra `data`). */
export function remarkCodeMeta() {
  return (tree: Node) =>
    walk(tree, (n) => {
      if (n.type === "code" && n.meta) n.data = { ...n.data, hProperties: { ...n.data?.hProperties, dataMeta: n.meta } };
    });
}

// --- Imágenes con ruta absoluta de Windows ---

const DRIVE_RE = /^[A-Za-z]:[\\/]/;
const DRIVE_MARK_RE = /^\/([A-Za-z]:[\\/])/;

/**
 * remark: `C:/x.png` llega al saneado como protocolo `c:` y pierde el `src`.
 * Se antepone `/` (ruta relativa a ojos del saneado) y `localImagePath` lo quita.
 */
export function remarkLocalImages() {
  return (tree: Node & { url?: string }) =>
    walk(tree, (n) => {
      const img = n as Node & { url?: string };
      if (img.type === "image" && img.url && DRIVE_RE.test(img.url)) img.url = `/${img.url}`;
    });
}

/** Deshace la marca de `remarkLocalImages`: `/C:/x.png` → `C:/x.png`. */
export function localImagePath(url: string): string {
  return url.replace(DRIVE_MARK_RE, "$1");
}

const FILE_DRIVE_RE = /^file:\/\/\/([A-Za-z]:[\\/].*)$/i;

/**
 * remark: lo mismo para los enlaces, que sin esto salían sin `href` y no hacían nada.
 * `file:///C:/x` se reduce a la ruta; un `file://host/…` no se toca: es de red y el saneado lo borra.
 */
export function remarkLocalLinks() {
  return (tree: Node & { url?: string }) =>
    walk(tree, (n) => {
      const link = n as Node & { url?: string };
      if ((link.type !== "link" && link.type !== "definition") || !link.url) return;
      const local = FILE_DRIVE_RE.exec(link.url)?.[1] ?? link.url;
      if (DRIVE_RE.test(local)) link.url = `/${local}`;
    });
}

/** remark: convierte los blockquote que empiezan por `[!TIPO]` en callouts. */
export function remarkCallouts() {
  return (tree: Node) => walk(tree, (n) => n.type === "blockquote" && markCallout(n));
}

// --- Marcas en línea: código en línea y ✓/✗ coloreados ---

const MARKS = /([✓✔✅])|([✗✘❌])/u;

function splitMarks(text: string): Node[] {
  const out: Node[] = [];
  let rest = text;
  for (let m = MARKS.exec(rest); m; m = MARKS.exec(rest)) {
    if (m.index > 0) out.push({ type: "text", value: rest.slice(0, m.index) });
    const cls = m[1] ? "mark-ok" : "mark-err";
    out.push({ type: "element", tagName: "span", properties: { className: [cls] }, children: [{ type: "text", value: m[0] }] });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push({ type: "text", value: rest });
  return out;
}

/** rehype (tras sanear): marca `code` fuera de `pre` y colorea ✓/✗ fuera de código. */
export function rehypeInlineMarks() {
  const visit = (node: Node, inCode: boolean) => {
    if (!node.children) return;
    const next: Node[] = [];
    for (const c of node.children) {
      if (c.type === "element" && c.tagName === "code" && node.tagName !== "pre") {
        c.properties = { ...c.properties, dataInline: "" };
      }
      if (c.type === "text" && !inCode && c.value && MARKS.test(c.value)) {
        next.push(...splitMarks(c.value));
        continue;
      }
      visit(c, inCode || c.tagName === "code" || c.tagName === "pre");
      next.push(c);
    }
    node.children = next;
  };
  return (tree: Node) => visit(tree, false);
}

// --- Saneado del HTML en bruto (rehype-raw) ---

const extraClasses = (...names: (string | RegExp)[]): [string, ...(string | RegExp)[]] => ["className", ...names];

/** Esquema de GitHub + clases de lenguaje, matemáticas y callouts; sin scripts ni estilos. */
export const SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "kbd", "mark"],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), extraClasses(/^language-./, "math-inline", "math-display"), "dataMeta"],
    span: [...(defaultSchema.attributes?.span ?? []), extraClasses("math-inline", "math-display")],
    div: [...(defaultSchema.attributes?.div ?? []), extraClasses("math-display")],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), extraClasses("callout", /^callout-/), "dataCallout"],
  },
};

// --- Rutas citadas: `src/a.ts:42`, `C:\x\y.rs`, `./doc.md` ---

const PATH_RE = /^((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/)?(?:[\w .@()+-]+[\\/])*[\w.@()+-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+))?(?::\d+)?$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

export interface PathRef {
  path: string;
  line?: number;
  isImage: boolean;
}

/** Ruta de fichero (con línea opcional) o `null` si el texto no lo parece. */
export function parsePathRef(text: string): PathRef | null {
  const t = text.trim();
  if (t.length > 260 || /\s{2}|^https?:/i.test(t)) return null;
  const m = PATH_RE.exec(t);
  if (!m) return null;
  const path = m[1];
  // Sin separador solo vale `fichero.ext` con extensión conocida de código o docs.
  if (!/[\\/]/.test(path) && !/\.(tsx?|jsx?|mjs|cjs|rs|py|md|json|toml|ya?ml|css|html|cpp|hpp|h|c|cs|go|java|kt|swift|sh|ps1|png|jpe?g|gif|webp|svg)$/i.test(path)) return null;
  return { path, line: m[2] ? Number(m[2]) : undefined, isImage: IMAGE_EXT.test(path) };
}

/** Absoluta y local: una ruta de red no cuenta, para que nadie la dé por buena. */
export function isAbsolutePath(p: string): boolean {
  return !isNetworkPath(p) && /^([A-Za-z]:[\\/]|\/|~[\\/])/.test(p);
}

// --- Tablas: números a la derecha y orden por columna ---

/** Valor numérico de una celda (`1.234,5`, `12 %`, `3,42 $`, `-7`) o `null`. */
export function cellNumber(text: string): number | null {
  const t = text.trim().replace(/\s*(%|\$|€|ms|s|MB|KB|GB|x|×)$/i, "").replace(/^[$€]\s*/, "");
  if (!/^[-+]?[\d.,\s]+$/.test(t) || !/\d/.test(t)) return null;
  const compact = t.replace(/\s/g, "");
  const normalized = /,\d{1,2}$/.test(compact) || (compact.includes(",") && compact.includes("."))
    ? compact.replace(/\./g, "").replace(",", ".")
    : compact.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Compara dos celdas: numérico si ambas lo son, si no texto en español. */
export function compareCells(a: string, b: string): number {
  const na = cellNumber(a);
  const nb = cellNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b, "es", { numeric: true, sensitivity: "base" });
}

// --- Bloques de código ---

/** Nombre de fichero del meta de la valla: ```ts src/a.ts  o  ```ts title="a.ts". */
export function codeFileName(meta: string | undefined): string | null {
  if (!meta) return null;
  const titled = /title=["']?([^"'\s]+)["']?/.exec(meta);
  if (titled) return titled[1];
  const first = meta.trim().split(/\s+/)[0];
  return first && /[\w-]\.[A-Za-z0-9]+$/.test(first) ? first : null;
}

export type DiffKind = "add" | "del" | "hunk" | "ctx";

export function diffKind(line: string): DiffKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  return "ctx";
}
