// mar.ia — el markdown del chat.
//
// Un solo sitio para todo lo que una respuesta puede traer:
//   * codigo con resaltado de sintaxis y boton de copiar por bloque;
//   * formulas (LaTeX) y tablas;
//   * diagramas Mermaid pintados en el propio mensaje;
//   * bloques html / svg / mermaid con un boton "abrir": se ven funcionando en
//     el panel de artefactos (`Artefacto.tsx`);
//   * enlaces que SE ABREN. Antes un clic en un enlace era un error silencioso
//     ("plugin:shell|open not allowed by ACL") que ademas dejaba el estado
//     global en amarillo; ahora van por el plugin `opener`, en el navegador.

import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import "katex/dist/katex.min.css";
import { BotonCopiar } from "./BotonCopiar";

/** Lo que se puede abrir en el panel de artefactos. */
export type TipoArtefacto = "html" | "svg" | "mermaid";
export type ArtefactoRef = { tipo: TipoArtefacto; codigo: string };

const ABRIBLES: Record<string, TipoArtefacto> = {
  html: "html",
  svg: "svg",
  xml: "svg",
  mermaid: "mermaid",
};

/** Tipo de artefacto de un bloque, o null. `xml` solo cuenta si es un SVG. */
export function tipoDeBloque(lang: string, codigo: string): TipoArtefacto | null {
  const t = ABRIBLES[lang.toLowerCase()];
  if (!t) return null;
  if (lang.toLowerCase() === "xml" && !/<svg[\s>]/i.test(codigo)) return null;
  return t;
}

/** Texto plano de un arbol de React (el codigo ya resaltado viene en <span>). */
function textoDe(n: ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textoDe).join("");
  if (typeof n === "object" && "props" in n) {
    return textoDe((n as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

let mermaidListo: Promise<typeof import("mermaid").default> | null = null;
/** Mermaid pesa: se carga la primera vez que aparece un diagrama, no antes. */
function cargarMermaid() {
  mermaidListo ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "inherit",
    });
    return m.default;
  });
  return mermaidListo;
}

/** Diagrama Mermaid. Mientras se escribe (streaming) el codigo esta a medias y
 *  no parsea: se enseña el texto y se reintenta cuando cambia. */
export function Mermaid({ codigo }: { codigo: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    const t = setTimeout(() => {
      void cargarMermaid()
        .then((m) => m.render(`mmd-${id}`, codigo))
        .then((r) => {
          if (vivo) {
            setSvg(r.svg);
            setError(null);
          }
        })
        .catch((e) => {
          if (vivo) setError(String(e?.message ?? e));
        });
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [codigo, id]);
  if (svg) {
    // SVG generado por mermaid en modo `strict` (sin HTML ni scripts).
    return <div className="cc-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  return (
    <pre className="cc-code" title={error ?? "pintando el diagrama…"}>
      <code>{codigo}</code>
    </pre>
  );
}

function Bloque({
  lang,
  codigo,
  children,
  onAbrir,
}: {
  lang: string;
  codigo: string;
  children: ReactNode;
  onAbrir?: (a: ArtefactoRef) => void;
}) {
  const tipo = tipoDeBloque(lang, codigo);
  return (
    <div className="cc-bloque">
      <div className="cc-bloque-barra">
        <span>{lang || "texto"}</span>
        <span className="flex items-center gap-2">
          {tipo && onAbrir && (
            <button
              type="button"
              className="cc-bloque-boton"
              onClick={() => onAbrir({ tipo, codigo })}
              title="verlo funcionando en el panel de la derecha"
            >
              abrir
            </button>
          )}
          <BotonCopiar texto={codigo} />
        </span>
      </div>
      {tipo === "mermaid" ? <Mermaid codigo={codigo} /> : <pre className="cc-code">{children}</pre>}
    </div>
  );
}

function componentes(onAbrir?: (a: ArtefactoRef) => void): Components {
  return {
    a({ href, children }) {
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href && /^https?:\/\//i.test(href)) void openUrl(href);
          }}
          title={href}
        >
          {children}
        </a>
      );
    },
    // `pre` envuelve a los bloques con valla; el `code` suelto es el de linea.
    pre({ children }) {
      const hijo = Array.isArray(children) ? children[0] : children;
      const props = (hijo as { props?: { className?: string; children?: ReactNode } })?.props;
      const lang = /language-([\w-]+)/.exec(props?.className ?? "")?.[1] ?? "";
      const codigo = textoDe(props?.children).replace(/\n$/, "");
      return (
        <Bloque lang={lang} codigo={codigo} onAbrir={onAbrir}>
          {children}
        </Bloque>
      );
    },
  };
}

export const Markdown = memo(function Markdown({
  texto,
  onAbrir,
}: {
  texto: string;
  onAbrir?: (a: ArtefactoRef) => void;
}) {
  // `onAbrir` cambia de identidad en cada render del chat; los componentes no
  // tienen por que rehacerse con el.
  const ref = useRef(onAbrir);
  ref.current = onAbrir;
  const [comps] = useState(() => componentes((a) => ref.current?.(a)));
  return (
    <div className="cc-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={comps}
      >
        {texto}
      </ReactMarkdown>
    </div>
  );
});

/** Artefactos que trae un mensaje, en orden. Para el boton del propio mensaje. */
export function artefactosDe(texto: string): ArtefactoRef[] {
  const out: ArtefactoRef[] = [];
  const valla = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
  for (let m = valla.exec(texto); m; m = valla.exec(texto)) {
    const tipo = tipoDeBloque(m[1] ?? "", m[2] ?? "");
    if (tipo) out.push({ tipo, codigo: (m[2] ?? "").replace(/\n$/, "") });
  }
  return out;
}
