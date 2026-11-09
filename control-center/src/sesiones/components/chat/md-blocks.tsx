// Bloques del Markdown del chat: código (fichero, números de línea, plegado,
// ajuste, diff, árbol JSON/YAML, vista previa HTML/SVG y diagramas), tablas
// ordenables, callouts, rutas que abren VS Code, imágenes locales y enlaces.

import { Children, cloneElement, isValidElement, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { useSessionInfo } from "../../store";
import { openViewerFrom } from "../../ui";
import { useChatScope } from "./ChatContext";
import { Diagram, type DiagramKind } from "./md-diagrams";
import { CALLOUTS, cellNumber, codeFileName, compareCells, diffKind, isAbsolutePath, localImagePath, parsePathRef, type CalloutKind } from "./md-plugins";
import { CopyButton } from "./CopyButton";
import { MEDIA_EXT, NETWORK_PATH_BLOCKED, isNetworkPath } from "../inspector/rutas-sesion";

export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function useCwd(): string | undefined {
  const scope = useChatScope();
  return useSessionInfo(scope?.sessionId ?? null)?.cwd || undefined;
}

/** Ruta que se puede pedir al backend; `null` si es relativa sin `cwd` o de red (la propia o la del `cwd`). */
function joinPath(cwd: string | undefined, p: string): string | null {
  if (isNetworkPath(p)) return null;
  if (isAbsolutePath(p)) return p;
  if (!cwd || isNetworkPath(cwd)) return null;
  return `${cwd.replace(/[\\/]+$/, "")}\\${p.replace(/^\.[\\/]/, "").replace(/\//g, "\\")}`;
}

// ---------------------------------------------------------------- código ---

// Map y no objeto: el lenguaje lo escribe el modelo y `constructor` resolvería por el prototipo.
const DIAGRAMS = new Map<string, DiagramKind>([["mermaid", "mermaid"], ["dot", "dot"], ["graphviz", "dot"], ["chart", "vega"], ["vega-lite", "vega"], ["vegalite", "vega"]]);
const TREE_LANGS = new Set(["json", "yaml", "yml"]);
const FOLD_LINES = 30;
const TREE_MIN_LINES = 8;

type CodeView = "code" | "tree" | "preview" | "live";

/**
 * HTML semiinteractivo (R16, motores-ventanas:F13): solo tras pulsar el botón, el
 * documento se sirve desde `preview://` (otro origen con su propia CSP, sin red)
 * en un iframe `sandbox="allow-scripts"` sin `allow-same-origin`.
 */
function HtmlLive({ html, lang }: { html: string; lang: string }) {
  const api = useApi();
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let alive = true;
    api.previewPut(html)
      .then((url) => alive && setState({ url }))
      .catch((e: unknown) => alive && setState({ error: String(e instanceof Error ? e.message : e) }));
    return () => {
      alive = false;
    };
  }, [api, html]);
  if (state.error) return <p className="diagram-err" role="alert">No se pudo abrir la vista interactiva: {state.error}</p>;
  if (!state.url) return <span className="loading">Preparando la vista interactiva…</span>;
  return <iframe className="preview" sandbox="allow-scripts" src={state.url} title={`Vista interactiva ${lang}`} />;
}

function isPreviewable(lang: string, raw: string): boolean {
  return lang === "html" || lang === "svg" || (lang === "xml" && raw.trimStart().startsWith("<svg"));
}

function DiffBody({ lines }: { lines: string[] }) {
  return (
    <code>
      {lines.map((l, i) => (
        <span key={i} className={`dl d-${diffKind(l)}`}>{l || " "}{"\n"}</span>
      ))}
    </code>
  );
}

function usePortableTree(lang: string, raw: string, active: boolean) {
  const [value, setValue] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const parse = lang === "json" ? Promise.resolve().then(() => JSON.parse(raw) as unknown) : import("yaml").then((y) => y.parse(raw) as unknown);
    parse.then(
      (v) => alive && setValue(v),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [lang, raw, active]);
  return { value, error };
}

function TreeNode({ name, value, depth }: { name?: string | number; value: unknown; depth: number }) {
  const label = name !== undefined && <span className="tk">{name}: </span>;
  if (value && typeof value === "object") {
    const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    return (
      <details className="tnode" open={depth < 2}>
        <summary>{label}<span className="faint">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span></summary>
        <div className="tchildren">
          {entries.map(([k, v]) => <TreeNode key={k} name={k} value={v} depth={depth + 1} />)}
        </div>
      </details>
    );
  }
  const kind = value === null ? "null" : typeof value;
  return <div className="tleaf">{label}<span className={`tv t-${kind}`}>{JSON.stringify(value)}</span></div>;
}

function CodeHead({ lang, file, raw, children }: { lang: string; file: string | null; raw: string; children?: ReactNode }) {
  return (
    <div className="cb-head">
      <span className="cb-title">{lang}{file && <span className="cb-file"> · {file}</span>}</span>
      <span className="cb-acts">
        {children}
        <CopyButton text={raw} />
      </span>
    </div>
  );
}

export function CodeBlock({ children, meta }: { children?: ReactNode; meta?: string }) {
  const child = Array.isArray(children) ? children[0] : children;
  const className = isValidElement(child) ? String((child.props as { className?: string }).className ?? "") : "";
  const lang = (/language-([\w+-]+)/.exec(className)?.[1] ?? "texto").toLowerCase();
  const raw = textOf(children).replace(/\n$/, "");
  const lines = useMemo(() => raw.split("\n"), [raw]);
  const [view, setView] = useState<CodeView>("code");
  const [wrap, setWrap] = useState(false);
  const [open, setOpen] = useState(false);
  const tree = usePortableTree(lang === "yml" ? "yaml" : lang, raw, view === "tree");
  const diagram = DIAGRAMS.get(lang);
  if (diagram) return <Diagram kind={diagram} code={raw} />;

  const file = codeFileName(meta);
  const canTree = TREE_LANGS.has(lang) && lines.length >= TREE_MIN_LINES;
  const canPreview = isPreviewable(lang, raw);
  const folded = lines.length > FOLD_LINES && !open && view === "code";
  const toggle = (v: CodeView) => setView((cur) => (cur === v ? "code" : v));
  return (
    <div className="codeblock" data-lang={lang}>
      <CodeHead lang={lang} file={file} raw={raw}>
        {canTree && <button className="copy" aria-pressed={view === "tree"} onClick={() => toggle("tree")}>Árbol</button>}
        {canPreview && <button className="copy" aria-pressed={view === "preview"} onClick={() => toggle("preview")}>Vista previa</button>}
        {canPreview && lang === "html" && <button className="copy" aria-pressed={view === "live"} onClick={() => toggle("live")} title="Ejecuta los scripts del HTML aislado en otro origen y sin red">Interactivo</button>}
        {view === "code" && <button className="copy" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>Ajustar</button>}
      </CodeHead>
      {view === "tree" && (
        <div className="tree">
          {tree.error ? <p className="diagram-err">No se pudo leer: {tree.error}</p> : tree.value === undefined ? <span className="loading">Leyendo…</span> : <TreeNode value={tree.value} depth={0} />}
        </div>
      )}
      {view === "preview" && (
        // Sin `allow-scripts`: el HTML se pinta pero no ejecuta nada.
        <iframe className="preview" sandbox="" srcDoc={raw} title={`Vista previa ${lang}`} />
      )}
      {view === "live" && <HtmlLive html={raw} lang={lang} />}
      {view === "code" && (
        <div className="cb-body" data-wrap={wrap || undefined} data-folded={folded || undefined}>
          {lines.length > 3 && !wrap && <div className="gutter" aria-hidden="true">{lines.map((_, i) => i + 1).join("\n")}</div>}
          <pre>{lang === "diff" ? <DiffBody lines={lines} /> : children}</pre>
        </div>
      )}
      {lines.length > FOLD_LINES && view === "code" && (
        <button className="cb-fold" onClick={() => setOpen((o) => !o)}>
          {open ? "Plegar" : `Mostrar ${lines.length - FOLD_LINES} líneas más`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tablas ---

type El = ReactElement<{ children?: ReactNode; className?: string; onClick?: () => void; "aria-sort"?: string; title?: string }>;

function elements(node: ReactNode): El[] {
  return Children.toArray(node).filter(isValidElement) as El[];
}

export function SortableTable({ children }: { children?: ReactNode }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const parts = elements(children);
  const thead = parts.find((p) => p.type === "thead");
  const tbody = parts.find((p) => p.type === "tbody");
  const rows = tbody ? elements(tbody.props.children) : [];
  const cellText = (row: El, col: number) => textOf(elements(row.props.children)[col]);
  const ncols = rows[0] ? elements(rows[0].props.children).length : 0;
  const numeric = Array.from({ length: ncols }, (_, c) => {
    const vals = rows.map((r) => cellText(r, c)).filter((t) => t.trim() && t.trim() !== "—" && t.trim() !== "-");
    return vals.length > 0 && vals.filter((t) => cellNumber(t) !== null).length / vals.length >= 0.8;
  });
  const sorted = sort ? [...rows].sort((a, b) => sort.dir * compareCells(cellText(a, sort.col), cellText(b, sort.col))) : rows;
  const markRow = (row: El) =>
    cloneElement(row, {}, elements(row.props.children).map((cell, c) =>
      cloneElement(cell, { key: c, className: numeric[c] ? "num" : undefined })));
  const headRow = thead ? elements(thead.props.children)[0] : undefined;
  const head = headRow && cloneElement(headRow, {}, elements(headRow.props.children).map((th, c) =>
    cloneElement(th, {
      key: c,
      className: `sortable${numeric[c] ? " num" : ""}`,
      "aria-sort": sort?.col === c ? (sort.dir === 1 ? "ascending" : "descending") : "none",
      title: "Ordenar por esta columna",
      onClick: () => setSort((s) => (s?.col === c ? (s.dir === 1 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 })),
    })));
  return (
    <div className="tablewrap" tabIndex={0} role="region" aria-label="Tabla">
      <table>
        {head && <thead>{head}</thead>}
        <tbody>{sorted.map((r, i) => cloneElement(markRow(r), { key: i }))}</tbody>
      </table>
    </div>
  );
}

// -------------------------------------------------------------- callouts ---

const CALLOUT_TITLE: Record<CalloutKind, [string, string]> = {
  note: ["ℹ", "Nota"],
  tip: ["✦", "Consejo"],
  important: ["◆", "Importante"],
  warning: ["▲", "Atención"],
  caution: ["✖", "Cuidado"],
};

export function Blockquote({ children, className, ...rest }: { children?: ReactNode; className?: string; "data-callout"?: string }) {
  // El atributo puede venir de HTML en bruto: `constructor` o `__proto__` resolverían por el prototipo.
  const kind = CALLOUTS.find((k) => k === rest["data-callout"]);
  if (!kind) return <blockquote className={className}>{children}</blockquote>;
  const [icon, title] = CALLOUT_TITLE[kind];
  return (
    <div className={`callout callout-${kind}`} role="note">
      <div className="callout-title"><span aria-hidden="true">{icon}</span> {title}</div>
      {children}
    </div>
  );
}

// ----------------------------------------------------- rutas e imágenes ---

/** Vídeos, audio, imágenes y documentos se abren con la app del sistema; el resto, en VS Code. */
function openCited(api: ReturnType<typeof useApi>, path: string, line: number | undefined, cwd: string | undefined): void {
  if (isNetworkPath(path)) return reportError(NETWORK_PATH_BLOCKED);
  const run = MEDIA_EXT.test(path) ? api.openFile(path, cwd) : api.openInEditor(path, line, cwd);
  run.catch(reportError);
}

function citedTitle(path: string, line: number | undefined): string {
  if (MEDIA_EXT.test(path)) return `Abrir con la app del sistema: ${path}`;
  return `Abrir en VS Code: ${path}${line ? ` (línea ${line})` : ""}`;
}

function LocalThumb({ path, alt, inline }: { path: string; alt: string; inline?: boolean }) {
  const api = useApi();
  const cwd = useCwd();
  const full = joinPath(cwd, path);
  const [src, setSrc] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const isNetwork = isNetworkPath(path) || isNetworkPath(cwd ?? "");
  const failed = full ? readError : isNetwork ? NETWORK_PATH_BLOCKED : "ruta relativa sin directorio de la sesión";
  useEffect(() => {
    if (!full) return;
    let alive = true;
    api.readImage(full).then(
      (url) => alive && setSrc(url),
      (e: unknown) => alive && setReadError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [api, full]);
  if (failed) return <span className="img-miss" title={failed}>🖼 {alt || path}</span>;
  if (!src) return <span className="loading">Cargando imagen…</span>;
  return (
    <img className={inline ? "thumb-inline" : undefined} src={src} alt={alt || path} loading="lazy" data-gallery="" data-path={full ?? undefined}
      onClick={(e) => openViewerFrom(e.currentTarget, { src, caption: alt || path, path: full ?? undefined })} />
  );
}

export function MdImage({ src, alt }: { src?: string; alt?: string }) {
  const url = typeof src === "string" ? src : "";
  // Sin `src` (el saneado lo borró por protocolo no admitido): aviso en vez de un <img> vacío.
  if (!url) return <span className="img-miss" title="Origen de imagen no admitido">🖼 {alt || "imagen"}</span>;
  if (!/^(data:|blob:|https?:)/i.test(url)) return <LocalThumb path={localImagePath(safeDecode(url, decodeURI))} alt={alt ?? ""} />;
  return (
    <img src={url} alt={alt ?? ""} loading="lazy" data-gallery=""
      onClick={(e) => url && openViewerFrom(e.currentTarget, { src: url, caption: alt ?? "imagen" })} />
  );
}

export function InlineCode({ children, className, ...rest }: { children?: ReactNode; className?: string; "data-inline"?: string }) {
  const api = useApi();
  const cwd = useCwd();
  const text = textOf(children);
  const ref = rest["data-inline"] !== undefined ? parsePathRef(text) : null;
  if (!ref) return <code className={className}>{children}</code>;
  return (
    <>
      <code className="pathref" role="link" tabIndex={0} title={citedTitle(ref.path, ref.line)}
        onClick={() => openCited(api, ref.path, ref.line, cwd)}
        onKeyDown={(e) => e.key === "Enter" && openCited(api, ref.path, ref.line, cwd)}>
        {children}
      </code>
      {ref.isImage && <LocalThumb path={ref.path} alt={ref.path} inline />}
    </>
  );
}

// ---------------------------------------------------------------- enlaces ---

export type LinkTarget =
  | { kind: "anchor"; id: string }
  | { kind: "external" }
  | { kind: "file"; path: string; line?: number };

/** Decodifica sin lanzar: un `%` suelto deja el texto tal cual. */
function safeDecode(s: string, fn: (v: string) => string = decodeURIComponent): string {
  try {
    return fn(s);
  } catch {
    return s;
  }
}

/**
 * A dónde lleva un enlace del Markdown. Las anclas (`#…`, notas al pie) se quedan en
 * el hilo y las rutas relativas o absolutas abren el editor: con `target=_blank`
 * abrían el navegador en `http://tauri.localhost/…`.
 */
export function linkTarget(href: string): LinkTarget {
  if (href.startsWith("#")) return { kind: "anchor", id: safeDecode(href.slice(1)) };
  if (/^file:/i.test(href)) {
    try {
      return { kind: "file", path: safeDecode(new URL(href).pathname.replace(/^\/([A-Za-z]:)/, "$1")) };
    } catch {
      return { kind: "external" };
    }
  }
  // Con esquema (http, https, mailto…) es externo; `C:\…` o `C:/…` es una ruta de Windows.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) return { kind: "external" };
  // `#L12` da la línea; otra ancla (`README.md#instalar`) se quita: no es parte de la ruta.
  const m = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|#[^#]*|:(\d+))?$/.exec(href);
  const path = localImagePath(safeDecode(m?.[1] || href, decodeURI));
  const line = m?.[2] ?? m?.[3];
  return { kind: "file", path, line: line ? Number(line) : undefined };
}

/** Destino de un ancla dentro del mismo mensaje (o, si no está, en el hilo). */
function scrollToAnchor(from: HTMLElement, id: string): boolean {
  const scopes = [from.closest(".md"), from.closest("[data-testid='message-scroll']"), document];
  for (const scope of scopes) {
    const target = scope ? [...scope.querySelectorAll<HTMLElement>("[id]")].find((el) => el.id === id) : undefined;
    if (target) {
      target.scrollIntoView?.({ block: "center" });
      return true;
    }
  }
  return false;
}

/** Esquemas que salen al navegador del sistema; el resto no se abre. */
const WEB_SCHEMES = /^(?:https?|mailto):/i;

/**
 * Clic en un enlace externo. En la webview de Tauri, `target=_blank` intenta abrir
 * otra webview y el ACL lo rechaza, así que el clic no hacía nada: se delega en el
 * plugin `opener`. El `href` se conserva para copiarlo desde el menú contextual.
 */
function openExternal(api: ReturnType<typeof useApi>, href: string, e: { preventDefault(): void }): void {
  e.preventDefault();
  if (!WEB_SCHEMES.test(href)) return reportError(`El enlace ${href} no es web (http, https o mailto): no se abre.`);
  api.openUrl(href).catch((err: unknown) => reportError(`No se pudo abrir ${href}: ${String(err)}`));
}

export function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const api = useApi();
  const cwd = useCwd();
  // El saneado borró el destino: un <a> sin href parecería un enlace y no haría nada.
  if (!href) return <span className="link-blocked" title="Destino de enlace no admitido">{children}</span>;
  let url: URL | null = null;
  try {
    url = href ? new URL(href) : null;
  } catch {
    url = null;
  }
  const target = href ? linkTarget(href) : null;
  if (target?.kind === "anchor") {
    return (
      <a href={href} onClick={(e) => {
        e.preventDefault();
        if (!scrollToAnchor(e.currentTarget, target.id)) reportError(`El enlace ${href} no apunta a nada de este hilo.`);
      }}>{children}</a>
    );
  }
  if (target?.kind === "file") {
    return (
      <a href={href} className="pathlink" title={citedTitle(target.path, target.line)} onClick={(e) => {
        e.preventDefault();
        openCited(api, target.path, target.line, cwd);
      }}>{children}</a>
    );
  }
  const bare = url && textOf(children).trim() === href;
  if (url && bare && /^https?:$/.test(url.protocol)) {
    const path = `${url.pathname}${url.search}`.replace(/\/$/, "");
    return (
      <a className="linkcard" href={href} rel="noreferrer noopener" onClick={(e) => openExternal(api, href, e)}>
        <span className="lc-host">{url.hostname.replace(/^www\./, "")}</span>
        {path && <span className="lc-path">{safeDecode(path, decodeURI)}</span>}
      </a>
    );
  }
  return (
    <a href={href} rel="noreferrer noopener" title={url?.hostname ?? href} onClick={(e) => openExternal(api, href, e)}>
      {children}
    </a>
  );
}
