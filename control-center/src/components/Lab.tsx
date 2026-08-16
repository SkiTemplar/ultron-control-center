// Lab TFG — detección de patrones de texto IA sobre el catálogo de
// investigación del usuario (docs/research/patrones-texto-ia.json).
// Dos vistas: Detector (pegar texto → matches deterministas contra las
// señales ejecutables del catálogo + guía de corrección) y Catálogo
// (explorador de los patrones con ejemplos/señales/corrección).
// El motor NO reescribe texto: señala y guía — el TFG lo escribe su autor.
// Wiring 2026-08-12 (decidido por el usuario: "Detector + guía de corrección").

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type TfgMatch = {
  pattern: string;
  rule: string;
  evidence: string;
  start: number;
  end: number;
  correction: string;
};

type TfgReport = {
  matches: TfgMatch[];
  patterns_hit: number;
  total_patterns_scanned: number;
  words: number;
  density_per_100w: number;
};

type CatalogPattern = {
  nombre: string;
  descripcion?: string;
  ejemplo_en?: string;
  ejemplo_es?: string;
  senal_deteccion?: string;
  correccion?: string;
  senales_ejecutables?: { tipo: string; valor: string; nota?: string }[];
};

type SubView = "detector" | "catalogo";

function densityColor(d: number): string {
  if (d >= 3) return "var(--color-danger)";
  if (d >= 1) return "var(--color-warn)";
  return "var(--color-success)";
}

/** Tramo elemental del texto y los avisos que lo cubren (0 = texto limpio). */
type Segment = { start: number; end: number; text: string; hits: number[] };

/**
 * Traductor de offset de BYTE (lo que emite el backend Rust: `start`/`end` son
 * indices de byte en UTF-8) a indice de string de JavaScript (UTF-16).
 *
 * Sin esto el resaltado se descuadra en cuanto el texto lleva una tilde o una
 * ñ: 'señal' ocupa 6 bytes y 5 posiciones en JS, asi que cada caracter no-ASCII
 * anterior al aviso lo desplaza. En un TFG en español eso no es un caso raro,
 * es el caso normal. Se construye una tabla byte->char de una pasada.
 */
function byteOffsetMapper(text: string): (byteOffset: number) => number {
  const table = new Map<number, number>();
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    table.set(bytes, i);
    // Longitud UTF-8 del code point.
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1; // pares suplentes ocupan 2 posiciones en JS
  }
  table.set(bytes, text.length);
  const total = bytes;
  return (b: number) => {
    if (b <= 0) return 0;
    if (b >= total) return text.length;
    // Un offset que cae dentro de un caracter multibyte (no deberia pasar, pero
    // el backend y este mapa podrian desincronizarse) se ancla al inicio de ese
    // caracter en vez de romper el resaltado.
    for (let probe = b; probe >= 0; probe--) {
      const hit = table.get(probe);
      if (hit !== undefined) return hit;
    }
    return 0;
  };
}

/**
 * Parte el texto en tramos elementales usando TODOS los limites (start/end) de
 * los avisos como puntos de corte.
 *
 * Por que asi y no pintando cada match por separado: los avisos SE SOLAPAN de
 * verdad — el detector marca una frase entera por su estructura y, dentro de
 * ella, una palabra concreta por lexico. Pintando match a match, el segundo
 * pisaria al primero y se perderia un aviso. Con el barrido por limites, cada
 * tramo sabe cuantos avisos lo cubren y se puede teñir en consecuencia.
 */
function buildSegments(text: string, matches: TfgMatch[]): Segment[] {
  const clamp = (n: number) => Math.max(0, Math.min(text.length, n));
  const bounds = new Set<number>([0, text.length]);
  for (const m of matches) {
    bounds.add(clamp(m.start));
    bounds.add(clamp(m.end));
  }
  const points = [...bounds].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const hits: number[] = [];
    matches.forEach((m, idx) => {
      if (clamp(m.start) <= start && clamp(m.end) >= end) hits.push(idx);
    });
    segments.push({ start, end, text: text.slice(start, end), hits });
  }
  return segments;
}

/** Linea y columna (1-based) de un offset, para citar la posicion del aviso. */
function lineCol(text: string, offset: number): { line: number; col: number } {
  const upto = text.slice(0, Math.max(0, Math.min(text.length, offset)));
  const lines = upto.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

/** Intensidad del subrayado segun cuantos avisos se apilan en el tramo. */
function markStyle(hitCount: number, isActive: boolean): React.CSSProperties {
  if (hitCount === 0) return {};
  const alpha = Math.min(0.1 + hitCount * 0.12, 0.42);
  return {
    background: isActive ? "rgba(210, 153, 34, 0.55)" : `rgba(210, 153, 34, ${alpha})`,
    borderBottom: `2px solid ${isActive ? "var(--color-warn)" : "rgba(210, 153, 34, 0.5)"}`,
    borderRadius: "2px",
    padding: "0 1px",
    cursor: "pointer",
  };
}

export function Lab() {
  const [view, setView] = useState<SubView>("detector");
  const [text, setText] = useState("");
  const [report, setReport] = useState<TfgReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<CatalogPattern[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Texto EXACTO que produjo el informe: si el usuario sigue editando el
  // textarea, los offsets del informe dejan de casar con lo que hay escrito y
  // el resaltado señalaria tramos equivocados. Se congela al analizar.
  const [analyzed, setAnalyzed] = useState("");
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [onlyPattern, setOnlyPattern] = useState<string | null>(null);
  const markRefs = useRef<Record<number, HTMLElement | null>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const cat = (await invoke("tfg_catalog_load")) as {
          patrones?: CatalogPattern[];
        };
        if (!cancelled) setPatterns(cat.patrones ?? []);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function analyze() {
    const t = text.trim();
    if (!t || analyzing) return;
    setAnalyzing(true);
    setError(null);
    try {
      const r = (await invoke("tfg_detect", { text: t })) as TfgReport;
      setReport(r);
      setAnalyzed(t);
      setActiveIdx(null);
      setOnlyPattern(null);
      markRefs.current = {};
    } catch (e) {
      setError(String(e));
      setReport(null);
      setAnalyzed("");
    } finally {
      setAnalyzing(false);
    }
  }

  // Avisos ordenados por posicion: es el orden en el que se leen sobre el
  // texto, y el que usa la navegacion anterior/siguiente.
  const ordered = useMemo(
    () => (report ? [...report.matches].sort((a, b) => a.start - b.start || a.end - b.end) : []),
    [report]
  );
  // Indices (sobre `ordered`) que la navegacion debe recorrer: con un patron
  // aislado, ‹ › no puede seguir paseando por avisos que no se ven.
  const navIdx = useMemo(
    () =>
      ordered
        .map((m, i) => (!onlyPattern || m.pattern === onlyPattern ? i : -1))
        .filter((i) => i >= 0),
    [ordered, onlyPattern]
  );
  // Avisos con los offsets ya traducidos de byte (Rust/UTF-8) a indice de
  // string (JS/UTF-16); sin esta traduccion el resaltado se desplaza en cuanto
  // hay una tilde antes del match.
  const located = useMemo(() => {
    if (!report || !analyzed) return [] as TfgMatch[];
    const toChar = byteOffsetMapper(analyzed);
    return ordered.map((m) => ({ ...m, start: toChar(m.start), end: toChar(m.end) }));
  }, [report, analyzed, ordered]);
  const segments = useMemo(
    () => (report && analyzed ? buildSegments(analyzed, located) : []),
    [report, analyzed, located]
  );

  /** Salta al aviso `idx` (indice sobre `ordered`) y lo centra en el panel. */
  function goTo(idx: number) {
    setActiveIdx(idx);
    const el = markRefs.current[idx];
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** Anterior/siguiente dentro de lo que se esta viendo, con vuelta al inicio. */
  function step(delta: number) {
    if (!navIdx.length) return;
    const pos = activeIdx === null ? -1 : navIdx.indexOf(activeIdx);
    const next = pos < 0 ? (delta > 0 ? 0 : navIdx.length - 1) : (pos + delta + navIdx.length) % navIdx.length;
    goTo(navIdx[next]);
  }

  // Agrupa matches por patrón para el informe.
  const grouped = report
    ? report.matches.reduce<Record<string, TfgMatch[]>>((acc, m) => {
        (acc[m.pattern] = acc[m.pattern] ?? []).push(m);
        return acc;
      }, {})
    : {};

  return (
    <div className="flex h-full flex-col">
      <header className="border-b" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex items-center justify-between gap-4 px-6 pt-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[15px] font-semibold">Lab</h2>
            <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              Detección determinista de patrones de texto IA · fuente: docs/research/patrones-texto-ia.json
            </span>
          </div>
        </div>
        <nav className="flex gap-1 px-6 pb-3 pt-3" role="tablist" aria-label="Lab sections">
          {(
            [
              ["detector", "Detector"],
              ["catalogo", "Catálogo"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className="rounded-md px-3 py-1.5 text-[12px] transition-colors"
              style={{
                background: view === id ? "var(--color-surface-3)" : "transparent",
                color: view === id ? "var(--color-text)" : "var(--color-text-secondary)",
                border: `1px solid ${view === id ? "var(--color-border-strong)" : "transparent"}`,
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {error && (
          <div
            className="mb-4 rounded p-3 text-[12.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}

        {view === "detector" && (
          <div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Pega aquí el texto a analizar (un apartado del TFG, un párrafo…). El análisis es local y determinista: cada aviso cita el patrón del catálogo y la señal exacta que lo disparó."
              rows={10}
              className="w-full rounded p-3 text-[12.5px] outline-none"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border-strong)",
                color: "var(--color-text)",
                resize: "vertical",
                fontFamily: "inherit",
              }}
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
                {text.trim() ? `${text.trim().split(/\s+/).length} palabras` : ""}
              </span>
              <button
                type="button"
                onClick={() => void analyze()}
                disabled={analyzing || !text.trim()}
                className="rounded px-4 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
              >
                {analyzing ? "Analizando…" : "Analizar"}
              </button>
            </div>

            {report && (
              <div className="mt-4">
                {/* Resumen */}
                <div
                  className="mb-4 flex flex-wrap items-baseline gap-6 rounded p-4"
                  style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
                >
                  <div>
                    <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-tertiary)" }}>
                      Avisos
                    </div>
                    <div className="text-[22px] font-semibold tabular-nums">{report.matches.length}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-tertiary)" }}>
                      Patrones distintos
                    </div>
                    <div className="text-[22px] font-semibold tabular-nums">
                      {report.patterns_hit}
                      <span className="text-[12px] font-normal" style={{ color: "var(--color-text-tertiary)" }}>
                        {" "}/ {report.total_patterns_scanned} escaneados
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-tertiary)" }}>
                      Densidad / 100 palabras
                    </div>
                    <div
                      className="text-[22px] font-semibold tabular-nums"
                      style={{ color: densityColor(report.density_per_100w) }}
                    >
                      {report.density_per_100w.toFixed(2)}
                    </div>
                  </div>
                </div>

                {report.matches.length > 0 && (
                  <div
                    className="mb-4 rounded"
                    style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
                  >
                    <div
                      className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      <span className="text-[11.5px] font-medium">
                        Texto marcado
                        <span className="ml-2 font-normal" style={{ color: "var(--color-text-tertiary)" }}>
                          cada tramo subrayado es un aviso; el color se intensifica donde se apilan varios
                        </span>
                      </span>
                      <div className="flex items-center gap-2">
                        {onlyPattern && (
                          <button
                            type="button"
                            onClick={() => setOnlyPattern(null)}
                            className="rounded px-2 py-1 text-[10.5px]"
                            style={{
                              background: "var(--color-surface-3)",
                              color: "var(--color-text-secondary)",
                              border: "1px solid var(--color-border-strong)",
                            }}
                          >
                            filtrando: {onlyPattern} ✕
                          </button>
                        )}
                        <span className="text-[11px] tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
                          {activeIdx === null || navIdx.indexOf(activeIdx) < 0
                            ? `${navIdx.length} aviso${navIdx.length !== 1 ? "s" : ""}`
                            : `${navIdx.indexOf(activeIdx) + 1} / ${navIdx.length}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => step(-1)}
                          aria-label="Aviso anterior"
                          className="rounded px-2 py-1 text-[12px]"
                          style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border-strong)" }}
                        >
                          ‹
                        </button>
                        <button
                          type="button"
                          onClick={() => step(1)}
                          aria-label="Aviso siguiente"
                          className="rounded px-2 py-1 text-[12px]"
                          style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border-strong)" }}
                        >
                          ›
                        </button>
                      </div>
                    </div>
                    <div
                      className="max-h-[340px] overflow-auto px-3 py-3 text-[12.5px] leading-relaxed"
                      style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                    >
                      {segments.map((seg, i) => {
                        const shown = onlyPattern
                          ? seg.hits.filter((h) => ordered[h].pattern === onlyPattern)
                          : seg.hits;
                        if (shown.length === 0) return <span key={i}>{seg.text}</span>;
                        const first = shown[0];
                        const isActive = activeIdx !== null && shown.includes(activeIdx);
                        const etiquetas = [...new Set(shown.map((h) => ordered[h].pattern))].join(" · ");
                        return (
                          <span
                            key={i}
                            ref={(el) => {
                              // Solo el PRIMER tramo de cada aviso guarda ref: es su
                              // ancla de scroll. Un aviso largo abarca varios tramos.
                              for (const h of shown) {
                                if (located[h].start === seg.start) markRefs.current[h] = el;
                              }
                            }}
                            title={`${etiquetas} — ${shown.length} aviso(s)`}
                            onClick={() => goTo(first)}
                            style={markStyle(shown.length, isActive)}
                          >
                            {seg.text}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {report.matches.length === 0 ? (
                  <p className="text-[12.5px]" style={{ color: "var(--color-success)" }}>
                    Sin señales del catálogo en este texto. Ojo con el alcance: solo se detecta lo que
                    el catálogo describe con señal ejecutable — un 0 no certifica texto humano.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(grouped)
                      .filter(([pattern]) => !onlyPattern || pattern === onlyPattern)
                      .map(([pattern, ms]) => (
                      <div
                        key={pattern}
                        className="rounded p-3"
                        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[12.5px] font-medium">{pattern}</span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setOnlyPattern(onlyPattern === pattern ? null : pattern)}
                              className="rounded px-1.5 py-0.5 text-[10px]"
                              style={{
                                background: onlyPattern === pattern ? "var(--color-accent)" : "var(--color-surface-3)",
                                color:
                                  onlyPattern === pattern ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
                                border: "1px solid var(--color-border-strong)",
                              }}
                            >
                              {onlyPattern === pattern ? "solo este" : "aislar"}
                            </button>
                            <span className="text-[11px] tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
                              {ms.length} aviso{ms.length !== 1 ? "s" : ""}
                            </span>
                          </div>
                        </div>
                        <ul className="mt-2 space-y-1">
                          {ms.slice(0, 8).map((m, i) => {
                            // Indice en `ordered` = el que usa la navegacion y el
                            // resaltado. Se busca por posicion, que es unica.
                            const gi = ordered.findIndex((o) => o.start === m.start && o.rule === m.rule);
                            // La posicion se cita sobre el offset YA traducido: si
                            // no, L:C se calcularia con un indice de byte y saldria
                            // corrida en cualquier texto con tildes.
                            const pos = analyzed && gi >= 0 ? lineCol(analyzed, located[gi].start) : null;
                            const isActive = gi >= 0 && gi === activeIdx;
                            return (
                              <li key={i}>
                                <button
                                  type="button"
                                  onClick={() => gi >= 0 && goTo(gi)}
                                  className="w-full rounded px-1 py-0.5 text-left text-[11.5px] transition-colors"
                                  style={{
                                    color: "var(--color-text-secondary)",
                                    background: isActive ? "var(--color-surface-3)" : "transparent",
                                  }}
                                >
                                  {pos && (
                                    <span
                                      className="mr-1 tabular-nums text-[10px]"
                                      style={{ color: "var(--color-text-faint)" }}
                                    >
                                      L{pos.line}:{pos.col}
                                    </span>
                                  )}
                                  <span
                                    className="rounded px-1 text-[10px] uppercase tracking-wide"
                                    style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}
                                  >
                                    {m.rule}
                                  </span>{" "}
                                  …{m.evidence}…
                                </button>
                              </li>
                            );
                          })}
                          {ms.length > 8 && (
                            <li className="text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                              +{ms.length - 8} más del mismo patrón
                            </li>
                          )}
                        </ul>
                        {ms[0].correction && (
                          <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                            <span style={{ color: "var(--color-warn)" }}>Guía:</span> {ms[0].correction}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {view === "catalogo" && (
          <div>
            {patterns === null ? (
              <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
                Cargando catálogo…
              </p>
            ) : (
              <div className="space-y-1.5">
                <p className="mb-3 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                  {patterns.length} patrones · las señales ejecutables (léxico/regex) son las que usa el
                  Detector; el resto de patrones son de lectura para el criterio propio.
                </p>
                {patterns.map((p) => {
                  const isOpen = expanded === p.nombre;
                  const nSignals = p.senales_ejecutables?.length ?? 0;
                  return (
                    <div
                      key={p.nombre}
                      className="rounded"
                      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
                    >
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : p.nombre)}
                        className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left"
                      >
                        <span className="text-[12.5px] font-medium">{p.nombre}</span>
                        <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: nSignals > 0 ? "var(--color-success)" : "var(--color-text-faint)" }}>
                          {nSignals > 0 ? `${nSignals} señal${nSignals !== 1 ? "es" : ""}` : "solo lectura"}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="border-t px-3 py-2 text-[11.5px]" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
                          {p.descripcion && <p>{p.descripcion}</p>}
                          {p.ejemplo_es && (
                            <p className="mt-1.5">
                              <span style={{ color: "var(--color-text-tertiary)" }}>Ejemplo (ES):</span> {p.ejemplo_es}
                            </p>
                          )}
                          {p.senal_deteccion && (
                            <p className="mt-1.5">
                              <span style={{ color: "var(--color-text-tertiary)" }}>Señal medible:</span> {p.senal_deteccion}
                            </p>
                          )}
                          {p.correccion && (
                            <p className="mt-1.5">
                              <span style={{ color: "var(--color-warn)" }}>Corrección:</span> {p.correccion}
                            </p>
                          )}
                          {nSignals > 0 && (
                            <p className="mt-1.5 text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                              Señales del detector: {p.senales_ejecutables!.map((s) => `${s.tipo}:${s.valor}`).join(" · ")}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default Lab;
