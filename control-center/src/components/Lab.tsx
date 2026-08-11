// Lab TFG — detección de patrones de texto IA sobre el catálogo de
// investigación del usuario (docs/research/patrones-texto-ia.json).
// Dos vistas: Detector (pegar texto → matches deterministas contra las
// señales ejecutables del catálogo + guía de corrección) y Catálogo
// (explorador de los patrones con ejemplos/señales/corrección).
// El motor NO reescribe texto: señala y guía — el TFG lo escribe su autor.
// Wiring 2026-08-12 (decidido por el usuario: "Detector + guía de corrección").

import { useEffect, useState } from "react";
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

export function Lab() {
  const [view, setView] = useState<SubView>("detector");
  const [text, setText] = useState("");
  const [report, setReport] = useState<TfgReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<CatalogPattern[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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
    } catch (e) {
      setError(String(e));
      setReport(null);
    } finally {
      setAnalyzing(false);
    }
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

                {report.matches.length === 0 ? (
                  <p className="text-[12.5px]" style={{ color: "var(--color-success)" }}>
                    Sin señales del catálogo en este texto. Ojo con el alcance: solo se detecta lo que
                    el catálogo describe con señal ejecutable — un 0 no certifica texto humano.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(grouped).map(([pattern, ms]) => (
                      <div
                        key={pattern}
                        className="rounded p-3"
                        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[12.5px] font-medium">{pattern}</span>
                          <span className="text-[11px] tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
                            {ms.length} aviso{ms.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <ul className="mt-2 space-y-1">
                          {ms.slice(0, 8).map((m, i) => (
                            <li key={i} className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
                              <span
                                className="rounded px-1 text-[10px] uppercase tracking-wide"
                                style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}
                              >
                                {m.rule}
                              </span>{" "}
                              …{m.evidence}…
                            </li>
                          ))}
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
