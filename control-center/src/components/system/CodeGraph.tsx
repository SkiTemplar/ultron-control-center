// ULTRON Control Center — CodeGraph panel (F8)
//
// Exposes the three codegraph Tauri commands to the UI:
//   memory_graph_metrics      — aggregate counters (total edges, by kind, unresolved)
//   memory_impact_analysis    — callers/callees for a given symbol
//   memory_drain_unresolved   — promote unresolved refs to full edges
//
// The backend commands are WRITE-ONLY on the ingestion side; this panel is
// READ-ONLY (no schema changes). drain_unresolved is a safe idempotent
// promotion — not a destructive write.
//
// PLUGIN UPDATE-CHECK NOTE: `check_plugin_updates` and `plugin_check_updates_bulk`
// are registered in lib.rs:418-420, but no existing UI tab surfaces them.
// A dedicated plugin-update panel is missing — this is flagged in changes[]
// but NOT implemented here to avoid scope creep.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types mirroring the Rust structs in codegraph.rs / schema_v4.rs
// ---------------------------------------------------------------------------

interface KindCount {
  kind: string;
  count: number;
}

interface GraphMetrics {
  total_edges: number;
  edges_by_kind: KindCount[];
  unresolved_refs: number;
}

interface CodeEdge {
  id: number;
  source: string;
  target: string;
  kind: string;
  file: string | null;
  line_from: number | null;
  line_to: number | null;
  provenance: string | null;
  project_id: string | null;
  created_at: number;
}

interface DrainResult {
  promoted: number;
  remaining: number;
}

type ImpactDirection = "callers" | "callees" | "both";

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function MetricCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div
      className="flex flex-col gap-1 rounded-lg p-4"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <span
        className="text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </span>
      <span
        className="text-[22px] font-bold tabular-nums"
        style={{ color: accent ? "var(--color-warn)" : "var(--color-text)" }}
      >
        {value}
      </span>
      {sub !== undefined && sub.length > 0 && (
        <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[13px] font-semibold mb-3" style={{ color: "var(--color-text-secondary)" }}>
      {children}
    </h2>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div
      className="rounded p-3 text-[12px]"
      style={{
        background: "rgba(248,81,73,0.08)",
        color: "var(--color-danger)",
        border: "1px solid rgba(248,81,73,0.3)",
      }}
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph Metrics section
// ---------------------------------------------------------------------------

function GraphMetricsSection() {
  const [metrics, setMetrics] = useState<GraphMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = (await invoke("memory_graph_metrics")) as GraphMetrics;
      setMetrics(result);
      setLastRefreshed(new Date());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setMetrics(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionHeader>Metricas del grafo</SectionHeader>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded px-3 py-1 text-[11px] transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
        >
          {loading ? "Cargando..." : "Refresh"}
        </button>
      </div>

      {error !== null && <InlineError message={error} />}

      {metrics !== null && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <MetricCard label="Edges totales" value={metrics.total_edges.toLocaleString()} sub="filas en la tabla edges" />
            <MetricCard
              label="Unresolved refs"
              value={metrics.unresolved_refs.toLocaleString()}
              sub="pendientes de promover a edge"
              accent={metrics.unresolved_refs > 0}
            />
            <MetricCard
              label="Tipos de edge"
              value={String(metrics.edges_by_kind.length)}
              sub="kinds distintos registrados"
            />
          </div>

          {metrics.edges_by_kind.length > 0 && (
            <div>
              <h3
                className="mb-2 text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Distribucion por kind
              </h3>
              <div
                className="overflow-hidden rounded-lg"
                style={{ border: "1px solid var(--color-border)", background: "var(--color-surface-2)" }}
              >
                <table className="w-full table-auto text-left">
                  <thead>
                    <tr
                      style={{
                        borderBottom: "1px solid var(--color-border)",
                        background: "var(--color-surface-1)",
                      }}
                    >
                      {["Kind", "Edges"].map((h) => (
                        <th
                          key={h}
                          className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
                          style={{ color: "var(--color-text-tertiary)" }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.edges_by_kind
                      .slice()
                      .sort((a, b) => b.count - a.count)
                      .map((kc) => (
                        <tr key={kc.kind} style={{ borderBottom: "1px solid var(--color-border)" }}>
                          <td
                            className="px-4 py-2.5 text-[12px] font-medium"
                            style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
                          >
                            {kc.kind}
                          </td>
                          <td
                            className="px-4 py-2.5 text-[12px] tabular-nums"
                            style={{ color: "var(--color-text-secondary)" }}
                          >
                            {kc.count.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {lastRefreshed !== null && (
            <p className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
              Actualizado {lastRefreshed.toLocaleTimeString()}
            </p>
          )}
        </>
      )}

      {!loading && metrics === null && error === null && (
        <p className="text-[13px]" style={{ color: "var(--color-text-faint)" }}>
          Sin datos disponibles.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Impact Analysis section
// ---------------------------------------------------------------------------

function ImpactAnalysisSection() {
  const [symbol, setSymbol] = useState("");
  const [direction, setDirection] = useState<ImpactDirection>("both");
  const [edges, setEdges] = useState<CodeEdge[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runAnalysis = useCallback(async (sym: string, dir: ImpactDirection) => {
    if (sym.trim().length === 0) return;
    setLoading(true);
    setError(null);
    setEdges(null);
    try {
      const result = (await invoke("memory_impact_analysis", {
        symbol: sym.trim(),
        direction: dir,
        limit: 100,
        project: null,
      })) as CodeEdge[];
      setEdges(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void runAnalysis(symbol, direction);
    },
    [runAnalysis, symbol, direction],
  );

  return (
    <section className="space-y-4">
      <SectionHeader>Analisis de impacto (callers / callees)</SectionHeader>

      <form onSubmit={handleSubmit} className="flex flex-wrap gap-2 items-end">
        <div className="flex flex-col gap-1">
          <label
            className="text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
            htmlFor="cg-symbol"
          >
            Simbolo
          </label>
          <input
            id="cg-symbol"
            ref={inputRef}
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="ej. memory_graph_metrics"
            className="rounded px-3 py-1.5 text-[12px] w-72"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              outline: "none",
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label
            className="text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
            htmlFor="cg-direction"
          >
            Direccion
          </label>
          <select
            id="cg-direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as ImpactDirection)}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
            }}
          >
            <option value="both">both (callers + callees)</option>
            <option value="callers">callers (quien me llama)</option>
            <option value="callees">callees (a quien llamo)</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={loading || symbol.trim().length === 0}
          className="rounded px-4 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-on-accent, #fff)",
            border: "none",
          }}
        >
          {loading ? "Buscando..." : "Analizar"}
        </button>
      </form>

      {error !== null && <InlineError message={error} />}

      {edges !== null && (
        <>
          {edges.length === 0 ? (
            <p className="text-[13px]" style={{ color: "var(--color-text-faint)" }}>
              Sin edges para <code style={{ fontFamily: "var(--font-mono)" }}>{symbol}</code> en
              direccion {direction}.
            </p>
          ) : (
            <div>
              <p className="mb-2 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
                {edges.length} edge{edges.length !== 1 ? "s" : ""} encontrado
                {edges.length !== 1 ? "s" : ""}
              </p>
              <div
                className="overflow-x-auto overflow-hidden rounded-lg"
                style={{ border: "1px solid var(--color-border)", background: "var(--color-surface-2)" }}
              >
                <table className="w-full table-auto text-left">
                  <thead>
                    <tr
                      style={{
                        borderBottom: "1px solid var(--color-border)",
                        background: "var(--color-surface-1)",
                      }}
                    >
                      {["Dir", "Source", "Target", "Kind", "Archivo", "Linea"].map((h) => (
                        <th
                          key={h}
                          className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap"
                          style={{ color: "var(--color-text-tertiary)" }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {edges.map((edge) => {
                      const sym = symbol.trim();
                      const isCallee = edge.source === sym;
                      return (
                        <tr key={edge.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                          <td className="px-4 py-2.5">
                            <span
                              className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                              style={{
                                background: isCallee
                                  ? "rgba(88,166,255,0.15)"
                                  : "rgba(63,185,80,0.15)",
                                color: isCallee ? "var(--color-info, #58a6ff)" : "var(--color-success)",
                              }}
                            >
                              {isCallee ? "callee" : "caller"}
                            </span>
                          </td>
                          <td
                            className="px-4 py-2.5 text-[11px] max-w-[180px] truncate"
                            style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
                            title={edge.source}
                          >
                            {edge.source}
                          </td>
                          <td
                            className="px-4 py-2.5 text-[11px] max-w-[180px] truncate"
                            style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
                            title={edge.target}
                          >
                            {edge.target}
                          </td>
                          <td
                            className="px-4 py-2.5 text-[11px]"
                            style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}
                          >
                            {edge.kind}
                          </td>
                          <td
                            className="px-4 py-2.5 text-[11px] max-w-[160px] truncate"
                            style={{ color: "var(--color-text-faint)" }}
                            title={edge.file ?? ""}
                          >
                            {edge.file ?? "—"}
                          </td>
                          <td
                            className="px-4 py-2.5 text-[11px] tabular-nums"
                            style={{ color: "var(--color-text-faint)" }}
                          >
                            {edge.line_from !== null ? edge.line_from : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Drain Unresolved section
// ---------------------------------------------------------------------------

function DrainUnresolvedSection() {
  const [result, setResult] = useState<DrainResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runDrain = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = (await invoke("memory_drain_unresolved")) as DrainResult;
      setResult(r);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <SectionHeader>Promover unresolved refs</SectionHeader>
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--color-text-faint)" }}>
            Promueve referencias no resueltas cuyo target ya existe en{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>memory_items</code> a edges completos.
            Operacion idempotente y segura.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void runDrain()}
          disabled={loading}
          className="shrink-0 rounded px-4 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
        >
          {loading ? "Ejecutando..." : "Drain unresolved"}
        </button>
      </div>

      {error !== null && <InlineError message={error} />}

      {result !== null && (
        <div className="grid grid-cols-2 gap-3">
          <MetricCard
            label="Promovidas"
            value={String(result.promoted)}
            sub="refs promovidas a edge en esta ejecucion"
          />
          <MetricCard
            label="Restantes"
            value={String(result.remaining)}
            sub="refs cuyo target aun no existe"
            accent={result.remaining > 0}
          />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function CodeGraph() {
  return (
    <div className="space-y-8 p-6">
      <div>
        <h1 className="text-[15px] font-semibold" style={{ color: "var(--color-text)" }}>
          Code Graph
        </h1>
        <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--color-text-faint)" }}>
          Visualizacion del grafo de codigo vivo (ingesta automatica). Solo lectura salvo la
          promocion de refs no resueltas, que es idempotente.
        </p>
      </div>

      <GraphMetricsSection />

      <hr style={{ border: "none", borderTop: "1px solid var(--color-border)" }} />

      <ImpactAnalysisSection />

      <hr style={{ border: "none", borderTop: "1px solid var(--color-border)" }} />

      <DrainUnresolvedSection />
    </div>
  );
}
