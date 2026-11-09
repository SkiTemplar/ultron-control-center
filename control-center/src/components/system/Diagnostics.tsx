// Control Center 2.9.5 — Diagnostics & Fixes (rediseño P2 2026-05-27)
//
// User feedback: "Diagnostics y Fixes está muy caótico, no llego a entender a
// qué botón le tengo que dar, vendría bien una serie de errores comunes o algo
// y luego los botones para posiblemente solucionarlo."
//
// Estructura nueva:
//   1. Header: buscador "Search common errors..." + filtro por categoría
//   2. COMMON_ERRORS: 13 errores conocidos con icono severidad, título corto,
//      síntoma, botón Diagnose (corre check específico) + botón Fix
//   3. Recent Fixes: historial local (~/.ultron/cockpit/fix-history.jsonl)
//   4. App Health (kept — compacto)
//   5. Toolbox Windows (collapsible, al fondo — ya existía)
//   6. Event Log con fixes sugeridos (kept)

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout } from "../../lib/invoke-timeout";
import { errMsg } from "../../lib/errors";
import type { DiagnosticReport } from "../../types";
import { Markdown } from "../../lib/markdown";
import { DiagnosticHistoryPanel } from "./DiagnosticHistoryPanel";
import { DiagnosticSchedulePanel } from "./DiagnosticSchedulePanel";
import { confirmDialog } from "../../lib/dialog";
import { getPrompt } from "../../lib/button-prompts";

import type { CommonError, CommonErrorCheckResult, EventLogEntry, Fix, FixHistoryEntry, MaintenanceResult } from "./diagnostics/types";
import { COMMON_ERRORS, COMMON_ERROR_CATEGORIES, COMMON_ERROR_CATEGORY_LABELS, FIX_CATALOG, CATEGORY_LABELS } from "./diagnostics/catalogs";
import { loadFixHistory, saveFixHistory, pushFixHistory } from "./diagnostics/fixHistory";
import { AppHealthCard } from "./diagnostics/AppHealthCard";
import { CommonErrorRow } from "./diagnostics/CommonErrorRow";
import { RecentFixesPanel } from "./diagnostics/RecentFixesPanel";
import { ToolboxPanel } from "./diagnostics/ToolboxPanel";
import { EventLogPanel } from "./diagnostics/EventLogPanel";
import { SolveWithAiModal } from "./diagnostics/SolveWithAiModal";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/** Plazo del diagnóstico y del visor de eventos (medidos: ~4 s y ~40 ms). */
const DIAGNOSTIC_TIMEOUT_MS = 60_000;

export function Diagnostics() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsErr, setEventsErr] = useState<string | null>(null);

  // Common errors filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<typeof COMMON_ERROR_CATEGORIES[number] | "All">("All");

  // Per-common-error check state: id -> result | "running" | null
  const [checkState, setCheckState] = useState<Record<string, CommonErrorCheckResult | "running" | null>>({});

  // Per-fix execution state
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);

  // Fix history
  const [fixHistory, setFixHistory] = useState<FixHistoryEntry[]>(() => loadFixHistory());

  // Toolbox panel — "todos los comandos posibles". 2026-10-17: it used to
  // start OPEN above Common errors, which buried the Diagnose → Fix flow the
  // header describes under 51 commands. It now sits below and starts closed.
  const [toolboxOpen, setToolboxOpen] = useState(false);
  const [toolboxFilter, setToolboxFilter] = useState("");

  // Common errors — sección colapsable, ABIERTA por defecto: es el flujo que
  // explica la cabecera (Diagnose → Fix).
  const [commonErrorsOpen, setCommonErrorsOpen] = useState(true);

  // Event log panel
  const [eventLogOpen, setEventLogOpen] = useState(false);

  // Solve with AI
  const [solveOpen, setSolveOpen] = useState(false);
  const [solveProblem, setSolveProblem] = useState("");
  const [solveSending, setSolveSending] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setAnalysis(null);
    try {
      // Con plazo (auditoría 2026-10-18): sin respuesta, el botón se quedaba
      // en «Ejecutando…» para siempre. El diagnóstico tarda unos 4 s.
      const r = await invokeWithTimeout<DiagnosticReport>("run_diagnostic_native", undefined, DIAGNOSTIC_TIMEOUT_MS);
      setReport(r);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsErr(null);
    try {
      const r = await invokeWithTimeout<EventLogEntry[]>(
        "event_log_recent",
        { limit: 50, scope: "critical_and_error" },
        DIAGNOSTIC_TIMEOUT_MS,
      );
      setEvents(r);
    } catch (e) {
      setEventsErr(errMsg(e));
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    void loadEvents();
  }, [run, loadEvents]);

  async function analyze() {
    if (!report) return;
    setAnalyzing(true);
    try {
      const md = (await invoke("analyze_diagnostic_with_ai", { reportJson: JSON.stringify(report, null, 2) })) as string;
      setAnalysis(md);
    } catch (e) {
      setAnalysis(`**Error:** ${String(e)}`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function runCheck(error: CommonError) {
    setCheckState((prev) => ({ ...prev, [error.id]: "running" }));
    try {
      const result = (await invoke("diagnostics_run", { errorId: error.checkId })) as CommonErrorCheckResult;
      setCheckState((prev) => ({ ...prev, [error.id]: result }));
    } catch (e) {
      setCheckState((prev) => ({
        ...prev,
        [error.id]: { status: "fail", details: String(e), suggested_fix: null },
      }));
    }
  }

  async function runFix(fix: Fix, source: FixHistoryEntry["source"] = "toolbox", errorId?: string) {
    if (fix.confirm) {
      const ok = await confirmDialog(fix.confirm.message, { title: fix.confirm.title, kind: "warning" });
      if (!ok) return;
    }
    setFixBusy(fix.kind);
    setFixResult(null);
    try {
      const r = (await invoke("run_maintenance_command", { kind: fix.kind })) as MaintenanceResult;
      const entry: FixHistoryEntry = {
        ts: new Date().toISOString(),
        kind: fix.kind,
        label: fix.label,
        success: r.success,
        source,
        error_id: errorId,
      };
      const updated = pushFixHistory(entry);
      setFixHistory(updated);
      if (r.success) {
        setFixResult(`${fix.label}: hecho (${r.elapsed_ms} ms).`);
      } else {
        const tail = (r.stderr || r.stdout || "").trim().slice(0, 200);
        setFixResult(`${fix.label}: ha fallado (código ${r.exit_code ?? "?"}). ${tail}`);
      }
    } catch (e) {
      setFixResult(`${fix.label}: ${String(e)}`);
    } finally {
      setFixBusy(null);
    }
  }

  async function solveWithAi(problem: string) {
    setSolveSending(true);
    setSolveError(null);
    try {
      const recent = events.slice(0, 10);
      const eventsBlock = recent.length === 0
        ? "(no critical/error events in the recent window)"
        : recent.map((e) => `- [${e.level}] id=${e.event_id} src=${e.source} at=${e.time_created}\n  ${(e.message || "").replace(/\s+/g, " ").trim().slice(0, 240)}`).join("\n");

      const healthBlock = report
        ? [`projects.json: ${report.app.projects_json_ok ? "ok" : "MISSING/CORRUPT"}`, `claude in PATH: ${report.app.claude_in_path ? "yes" : "no"}`, `codex in PATH: ${report.app.codex_in_path ? "yes" : "no"}`, `qdrant running: ${report.app.qdrant_running ? "yes" : "no"}`].join("\n")
        : "(no app health snapshot loaded)";

      const fixesBlock = Object.values(FIX_CATALOG).map((f) => `- ${f.kind} (${CATEGORY_LABELS[f.category]}) — ${f.label}: ${f.detail}`).join("\n");

      const prompt = await getPrompt("diagnostics.solve_with_ai", {
        problem,
        health: healthBlock,
        events: eventsBlock,
        fixes: fixesBlock,
      });
      await invoke("spawn_session", { provider: "claude", prompt, cwd: null, flags: { dangerouslySkipPermissions: false } });
      setSolveOpen(false);
      setSolveProblem("");
      setFixResult("Resolver con IA: se ha lanzado una sesión de Claude con el contexto del diagnóstico.");
    } catch (e) {
      setSolveError(String(e));
    } finally {
      setSolveSending(false);
    }
  }

  // Filtered common errors
  const filteredErrors = COMMON_ERRORS.filter((e) => {
    const matchesCat = categoryFilter === "All" || e.category === categoryFilter;
    if (!matchesCat) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      e.title.toLowerCase().includes(q) ||
      e.symptom.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      COMMON_ERROR_CATEGORY_LABELS[e.category].toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                               */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="rounded p-3"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
              Diagnóstico y arreglos
            </div>
            <div className="mt-0.5 text-[12px] leading-snug" style={{ color: "var(--color-text-tertiary)" }}>
              Elige un error conocido, pulsa Diagnosticar para ver si te afecta y después Arreglar para corregirlo. La caja de herramientas de Windows de abajo ejecuta cualquier comando directamente.
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button type="button" className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
              onClick={() => setSolveOpen(true)}>
              Resolver con IA
            </button>
            <button type="button" className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
              onClick={() => setHistoryOpen((v) => !v)}>
              {historyOpen ? "Ocultar el historial" : "Historial"}
            </button>
            <button type="button" className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
              onClick={() => setScheduleOpen((v) => !v)}>
              {scheduleOpen ? "Ocultar la programación" : "Programación"}
            </button>
            <button type="button"
              className="rounded px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
              onClick={() => { void run(); void loadEvents(); }}
              disabled={loading || eventsLoading}>
              {loading || eventsLoading ? "Ejecutando…" : "Actualizar"}
            </button>
          </div>
        </div>
      </div>

      {err && (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-200">{err}</div>
      )}

      {fixResult && (
        <div className="rounded border px-3 py-2 text-[12px]"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}>
          {fixResult}
        </div>
      )}

      {historyOpen && <DiagnosticHistoryPanel onSelect={(r) => { setReport(r); setHistoryOpen(false); }} />}
      {scheduleOpen && <DiagnosticSchedulePanel />}

      {/* ------------------------------------------------------------------ */}
      {/* App Health (compacto)                                               */}
      {/* ------------------------------------------------------------------ */}
      {report && <AppHealthCard report={report} />}

      {/* ------------------------------------------------------------------ */}
      {/* Common Errors section (colapsable, abierta por defecto)             */}
      {/* ------------------------------------------------------------------ */}
      <section
        className="rounded"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <button
          type="button"
          onClick={() => setCommonErrorsOpen((v) => !v)}
          aria-expanded={commonErrorsOpen}
          className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors"
          style={{
            background: "var(--color-surface-1)",
            borderBottom: commonErrorsOpen ? "1px solid var(--color-border)" : "none",
          }}
        >
          <span className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Errores comunes
          </span>
          <span className="font-mono text-[12px]" style={{ color: "var(--color-text-tertiary)" }} aria-hidden>
            {commonErrorsOpen ? "▾" : "▸"}
          </span>
        </button>

        {commonErrorsOpen && (
          <>
            <div
              className="px-3 py-2.5"
              style={{ borderBottom: "1px solid var(--color-border)" }}
            >
              {/* Search + category filter */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar errores comunes…"
                  className="min-w-[200px] flex-1 rounded px-2.5 py-1 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border)",
                    outline: "none",
                  }}
                />
                <div className="flex flex-wrap items-center gap-1">
                  {(["All", ...COMMON_ERROR_CATEGORIES] as Array<"All" | typeof COMMON_ERROR_CATEGORIES[number]>).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategoryFilter(cat)}
                      className="rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
                      style={{
                        background: categoryFilter === cat ? "var(--color-accent)" : "var(--color-surface-3)",
                        color: categoryFilter === cat ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      {cat === "All" ? "Todos" : COMMON_ERROR_CATEGORY_LABELS[cat]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredErrors.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
                Ningún error coincide con «{searchQuery}».
              </div>
            )}

            <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
              {filteredErrors.map((error) => (
                <CommonErrorRow
                  key={error.id}
                  error={error}
                  checkResult={checkState[error.id] ?? null}
                  fixBusy={fixBusy}
                  onDiagnose={() => void runCheck(error)}
                  onFix={(fix, source, eid) => void runFix(fix, source, eid)}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Toolbox Windows — "todos los comandos posibles" (plegado por defecto) */}
      {/* ------------------------------------------------------------------ */}
      <ToolboxPanel
        open={toolboxOpen}
        onToggle={() => setToolboxOpen((v) => !v)}
        filter={toolboxFilter}
        onFilterChange={setToolboxFilter}
        runFix={(fix) => void runFix(fix, "toolbox")}
        fixBusy={fixBusy}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Recent Fixes                                                        */}
      {/* ------------------------------------------------------------------ */}
      {fixHistory.length > 0 && (
        <RecentFixesPanel
          entries={fixHistory}
          onClear={() => {
            saveFixHistory([]);
            setFixHistory([]);
          }}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Event Log (collapsible)                                             */}
      {/* ------------------------------------------------------------------ */}
      <EventLogPanel
        open={eventLogOpen}
        onToggle={() => setEventLogOpen((v) => !v)}
        events={events}
        loading={eventsLoading}
        error={eventsErr}
        runFix={(fix) => void runFix(fix, "event_log")}
        fixBusy={fixBusy}
        onRefresh={() => void loadEvents()}
      />

      {report && (
        <div className="flex justify-end">
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-white/10 px-3 py-1 text-[12px] hover:bg-white/5 disabled:opacity-50"
            onClick={analyze}
            disabled={analyzing}
          >
            {analyzing ? "Analizando…" : "Analizar con IA"}
          </button>
        </div>
      )}

      {analysis && (
        <div className="rounded border border-white/10 bg-[var(--color-surface-1)] p-3">
          <div className="mb-2 text-[12px] text-white/50">Análisis de la IA</div>
          <div className="prose prose-invert prose-sm max-w-none">
            <Markdown source={analysis} />
          </div>
        </div>
      )}

      {solveOpen && (
        <SolveWithAiModal
          problem={solveProblem}
          onProblemChange={setSolveProblem}
          sending={solveSending}
          error={solveError}
          eventsCount={events.length}
          hasReport={!!report}
          onCancel={() => { setSolveOpen(false); setSolveError(null); }}
          onSend={() => {
            const trimmed = solveProblem.trim();
            if (!trimmed) { setSolveError("Describe primero el problema."); return; }
            void solveWithAi(trimmed);
          }}
        />
      )}
    </div>
  );
}

export default Diagnostics;
