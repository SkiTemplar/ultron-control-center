// Lab → Papers: literatura para el TFG desde Semantic Scholar y OpenAlex.
//
// Las dos fuentes a la vez y el resultado fusionado: no cubren lo mismo, y
// buscar dos veces a mano es lo que hace que no se busque. Cada ficha dice de
// dónde salió, cuántas citas tiene y si hay PDF abierto.
//
// Si una fuente falla (Semantic Scholar devuelve 429 sin clave, medido el
// 2026-09-19) se dice cuál y por qué, en vez de enseñar media lista como si
// fuera todo lo que hay.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Paper = {
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  abstract_text: string;
  citations: number;
  doi: string;
  url: string;
  pdf_url: string;
  open_access: boolean;
  source: string;
};

type Busqueda = { papers: Paper[]; fallos: string[] };

const FUENTE_LABEL: Record<string, string> = {
  semanticscholar: "S2",
  openalex: "OA",
  ambas: "S2+OA",
};

export function PapersView() {
  const [consulta, setConsulta] = useState("");
  const [limite, setLimite] = useState(15);
  const [res, setRes] = useState<Busqueda | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);

  async function buscar() {
    const q = consulta.trim();
    if (!q || buscando) return;
    setBuscando(true);
    setError(null);
    const r = await invoke<Busqueda>("maria_papers_search", { query: q, limit: limite }).catch(
      (e) => {
        setError(String(e));
        return null;
      },
    );
    setBuscando(false);
    if (r) setRes(r);
  }

  /** Cita en BibTeX, para pegarla directamente en el TFG. */
  function bibtex(p: Paper): string {
    const primer = (p.authors[0] ?? "anon").split(/\s+/).pop() ?? "anon";
    const clave = `${primer.toLowerCase()}${p.year ?? ""}`.replace(/[^a-z0-9]/g, "");
    const campos = [
      ["title", p.title],
      ["author", p.authors.join(" and ")],
      ["year", p.year ? String(p.year) : ""],
      ["journal", p.venue],
      ["doi", p.doi.replace(/^https?:\/\/doi\.org\//i, "")],
      ["url", p.url],
    ].filter(([, v]) => v);
    return `@article{${clave},\n${campos
      .map(([k, v]) => `  ${k} = {${v}}`)
      .join(",\n")}\n}`;
  }

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void buscar();
        }}
      >
        <input
          value={consulta}
          onChange={(e) => setConsulta(e.target.value)}
          placeholder="tema del TFG… (p. ej. procedural content generation)"
          aria-label="búsqueda de papers"
          className="flex-1 rounded-md px-3 text-[13px]"
          style={{
            minHeight: 38,
            minWidth: 260,
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            outline: "none",
          }}
        />
        <label className="flex items-center gap-1 text-[12px]">
          <span style={{ color: "var(--color-text-tertiary)" }}>resultados</span>
          <select
            value={limite}
            onChange={(e) => setLimite(Number(e.target.value))}
            aria-label="número de resultados"
            className="rounded-md px-2 text-[13px]"
            style={{
              minHeight: 38,
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
            }}
          >
            {[10, 15, 25, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={buscando || !consulta.trim()}
          className="rounded-md px-4 text-[13px]"
          style={{
            minHeight: 38,
            background: "var(--color-surface-3)",
            border: "1px solid var(--color-border-strong)",
            color: consulta.trim() ? "var(--color-text)" : "var(--color-text-tertiary)",
            cursor: consulta.trim() && !buscando ? "pointer" : "default",
          }}
        >
          {buscando ? "buscando…" : "buscar"}
        </button>
      </form>

      <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Semantic Scholar + OpenAlex a la vez, sin repetidos y ordenado por citas. No se envía
        ningún dato personal; las claves opcionales van en Ajustes → API Keys.
      </p>

      {error && (
        <div
          className="rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {res?.fallos.map((f) => (
        <div
          key={f}
          className="rounded p-2 text-[12px]"
          style={{
            border: "1px solid var(--color-warn)",
            color: "var(--color-warn)",
          }}
        >
          {f}
        </div>
      ))}

      {res && res.papers.length === 0 && !buscando && (
        <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          sin resultados.
        </p>
      )}

      {res?.papers.map((p) => {
        const id = p.doi || p.url || p.title;
        const desplegado = abierto === id;
        return (
          <article
            key={id}
            className="rounded-md p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <strong className="text-[13.5px]" style={{ color: "var(--color-text)" }}>
                {p.title}
              </strong>
              <span
                className="px-1.5 text-[10.5px]"
                style={{
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-tertiary)",
                }}
                title="fuente"
              >
                {FUENTE_LABEL[p.source] ?? p.source}
              </span>
              {p.open_access && (
                <span
                  className="px-1.5 text-[10.5px]"
                  style={{
                    border: "1px solid var(--color-success)",
                    color: "var(--color-success)",
                  }}
                >
                  acceso abierto
                </span>
              )}
            </div>

            <p className="mt-1 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
              {p.authors.slice(0, 5).join(", ")}
              {p.authors.length > 5 ? " et al." : ""}
              {p.year ? ` · ${p.year}` : ""}
              {p.venue ? ` · ${p.venue}` : ""}
              {` · ${p.citations} citas`}
            </p>

            {p.abstract_text && (
              <p className="mt-2 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
                {desplegado || p.abstract_text.length <= 320
                  ? p.abstract_text
                  : `${p.abstract_text.slice(0, 320)}…`}
              </p>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {p.abstract_text.length > 320 && (
                <button
                  type="button"
                  onClick={() => setAbierto(desplegado ? null : id)}
                  className="rounded px-2 py-1 text-[11.5px]"
                  style={{
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text-secondary)",
                    background: "transparent",
                    cursor: "pointer",
                  }}
                >
                  {desplegado ? "menos" : "resumen completo"}
                </button>
              )}
              {p.url && (
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded px-2 py-1 text-[11.5px]"
                  style={{ border: "1px solid var(--color-border)", color: "var(--color-accent)" }}
                >
                  ficha
                </a>
              )}
              {p.pdf_url && (
                <a
                  href={p.pdf_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded px-2 py-1 text-[11.5px]"
                  style={{ border: "1px solid var(--color-success)", color: "var(--color-success)" }}
                >
                  PDF
                </a>
              )}
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(bibtex(p))}
                className="rounded px-2 py-1 text-[11.5px]"
                style={{
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                  background: "transparent",
                  cursor: "pointer",
                }}
                title="copia la cita en BibTeX"
              >
                BibTeX
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
