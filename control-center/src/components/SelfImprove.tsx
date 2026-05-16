import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ActivityTimeline } from "./ActivityTimeline";
// v15.1.6: CostWatchdog import retained for future use (e.g., metered API
// providers) but unmounted by default — user runs on subscriptions only,
// so daily-cost projection doesn't apply. Re-enable by uncommenting below.
// import { CostWatchdog } from "./CostWatchdog";

// Self-improvement panel — surfaces telemetry the system already collects
// (routing-telemetry.jsonl, skill usage counts, recent errors) and lets
// the user kick off an adversarial Codex review on the current branch.

export type TelemetryRow = {
  ts: string;
  intent: string;
  routed_to: string;
  matched: boolean;
  confidence: number | null;
};

export type HookSignal = {
  source: string;
  kind: string;
  ts: string;
  summary: string;
};

export type SelfImproveReport = {
  total_routes: number;
  matched_routes: number;
  top_intents: { intent: string; count: number }[];
  top_skills: { skill: string; count: number }[];
  recent_errors: { source: string; message: string; ts: string }[];
  session_metrics?: { label: string; value: number; unit: string }[];
  recent_memory_paths?: string[];
  hook_signals?: HookSignal[];
};

const HOOK_SOURCE_COLORS: Record<string, { bg: string; fg: string }> = {
  "hyper-plans": { bg: "rgba(88, 166, 255, 0.12)", fg: "rgb(88, 166, 255)" },
  doctor: { bg: "rgba(248, 81, 73, 0.12)", fg: "rgb(248, 81, 73)" },
  "prompt-feedback": { bg: "rgba(210, 153, 34, 0.12)", fg: "rgb(210, 153, 34)" },
  "token-usage": { bg: "rgba(63, 185, 80, 0.12)", fg: "rgb(63, 185, 80)" },
  "auto-updater": { bg: "rgba(163, 113, 247, 0.12)", fg: "rgb(163, 113, 247)" },
  "mcp-audit": { bg: "rgba(255, 138, 0, 0.14)", fg: "rgb(255, 138, 0)" },
};

function hookSourceStyle(source: string): { background: string; color: string } {
  const c = HOOK_SOURCE_COLORS[source] ?? {
    bg: "rgba(125, 133, 144, 0.14)",
    fg: "rgb(125, 133, 144)",
  };
  return { background: c.bg, color: c.fg };
}

export function SelfImprove() {
  const [data, setData] = useState<SelfImproveReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewOutput, setReviewOutput] = useState<string | null>(null);
  const [codexOpen, setCodexOpen] = useState(false);
  // v15.1.6: Table view was not useful per user feedback — Timeline only.
  const hookView: "timeline" = "timeline";

  async function load() {
    try {
      const r = (await invoke("self_improve_report")) as SelfImproveReport;
      setData(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function runAdversarial() {
    setReviewBusy(true);
    setReviewOutput(null);
    try {
      const r = (await invoke("run_codex_adversarial_review")) as {
        success: boolean;
        stdout: string;
        stderr: string;
      };
      setReviewOutput(r.stdout || r.stderr || "(no output)");
    } catch (e) {
      setReviewOutput(`Error: ${e}`);
    } finally {
      setReviewBusy(false);
    }
  }

  const matchRate = useMemo(() => {
    if (!data || data.total_routes === 0) return 0;
    return Math.round((data.matched_routes / data.total_routes) * 100);
  }, [data]);

  return (
    <div className="space-y-5">
      <header>
        <h3 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Self-improvement signals
        </h3>
        <p
          className="mt-1 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          What the orchestrator actually picked, which skills carried the load,
          and which errors keep recurring. The numbers come from the local
          telemetry the hooks already write — no upload.
        </p>
      </header>

      {error && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-3 gap-3">
          <div
            className="rounded p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div
              className="text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Routing match rate
            </div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">
              {matchRate}%
            </div>
            <div
              className="mt-1 text-[10.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {data.matched_routes} of {data.total_routes} routes resolved cleanly
            </div>
          </div>
          <div
            className="rounded p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div
              className="text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Top intent
            </div>
            <div className="mt-1 truncate text-[14px] font-semibold">
              {data.top_intents[0]?.intent ?? "—"}
            </div>
            <div
              className="mt-1 text-[10.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {data.top_intents[0]?.count ?? 0} calls
            </div>
          </div>
          <div
            className="rounded p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div
              className="text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Top skill
            </div>
            <div className="mt-1 truncate text-[14px] font-semibold">
              {data.top_skills[0]?.skill ?? "—"}
            </div>
            <div
              className="mt-1 text-[10.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {data.top_skills[0]?.count ?? 0} activations
            </div>
          </div>
        </div>
      )}

      {data && data.session_metrics && data.session_metrics.length > 0 && (
        <div>
          <div
            className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Session activity (from ~/.claude/projects)
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {data.session_metrics
              .filter((m) => m.label !== "Today")
              .map((m) => (
                <div
                  key={m.label}
                  className="rounded p-2.5"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <div
                    className="text-[9.5px] font-medium uppercase tracking-[0.06em]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {m.label}
                  </div>
                  <div
                    className="mt-0.5 text-[15px] font-semibold tabular-nums leading-tight"
                    style={{ color: "var(--color-text)" }}
                  >
                    {Number.isInteger(m.value)
                      ? m.value.toLocaleString()
                      : m.value.toFixed(1)}{" "}
                    {m.unit && (
                      <span
                        className="text-[10px] font-normal"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        {m.unit}
                      </span>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {data && data.recent_memory_paths && data.recent_memory_paths.length > 0 && (
        <div>
          <div
            className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Memory notes accessed recently
          </div>
          <ul
            className="rounded text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            {data.recent_memory_paths.slice(0, 8).map((p, i) => (
              <li
                key={p}
                className="px-3 py-1.5"
                style={{
                  borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && data.recent_errors.length > 0 && (
        <div>
          <div
            className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Recent errors (last 24h)
          </div>
          <div className="space-y-1">
            {data.recent_errors.slice(0, 6).map((er, i) => (
              <div
                key={i}
                className="rounded px-3 py-2 text-[11.5px]"
                style={{
                  background: "rgba(248, 81, 73, 0.04)",
                  border: "1px solid rgba(248, 81, 73, 0.18)",
                  color: "var(--color-text-secondary)",
                }}
              >
                <div
                  className="mb-1 flex items-baseline gap-2 text-[10px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  <span>{er.source}</span>
                  <span className="ml-auto tabular-nums">{er.ts.slice(0, 16).replace("T", " ")}</span>
                </div>
                <div className="truncate" title={er.message}>
                  {er.message}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <div className="flex items-center gap-2">
            <div
              className="text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Hook signals
            </div>
          </div>
        </div>

        {hookView === "timeline" ? (
          <ActivityTimeline />
        ) : data && data.hook_signals && data.hook_signals.length > 0 ? (
          <div
            className="overflow-hidden rounded"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <table className="w-full text-[11px]" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--color-surface-3)" }}>
                  <th
                    className="px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-[0.06em]"
                    style={{ color: "var(--color-text-tertiary)", width: 140 }}
                  >
                    Timestamp
                  </th>
                  <th
                    className="px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-[0.06em]"
                    style={{ color: "var(--color-text-tertiary)", width: 110 }}
                  >
                    Source
                  </th>
                  <th
                    className="px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-[0.06em]"
                    style={{ color: "var(--color-text-tertiary)", width: 120 }}
                  >
                    Kind
                  </th>
                  <th
                    className="px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-[0.06em]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Summary
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.hook_signals.slice(0, 30).map((h, i) => (
                  <tr
                    key={`${h.source}-${h.ts}-${i}`}
                    style={{
                      borderTop: "1px solid var(--color-border)",
                    }}
                  >
                    <td
                      className="px-3 py-1 tabular-nums"
                      style={{ color: "var(--color-text-faint)" }}
                    >
                      {h.ts.slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="px-3 py-1">
                      <span
                        className="inline-block rounded px-1.5 py-[1px] text-[9.5px] font-medium uppercase tracking-[0.04em]"
                        style={hookSourceStyle(h.source)}
                      >
                        {h.source}
                      </span>
                    </td>
                    <td
                      className="px-3 py-1"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {h.kind}
                    </td>
                    <td
                      className="px-3 py-1 truncate"
                      style={{
                        color: "var(--color-text)",
                        maxWidth: 0,
                      }}
                      title={h.summary}
                    >
                      {h.summary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div
            className="rounded px-3 py-4 text-[11px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No hook signals captured yet.
          </div>
        )}
      </div>

      <details
        className="rounded"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
        open={codexOpen}
        onToggle={(e) =>
          setCodexOpen((e.currentTarget as HTMLDetailsElement).open)
        }
      >
        <summary
          className="cursor-pointer list-none px-3 py-2 text-[11.5px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          <span style={{ color: "var(--color-text-tertiary)" }}>
            {codexOpen ? "▾" : "▸"}
          </span>{" "}
          Codex adversarial review (read-only, optional)
        </summary>
        <div
          className="px-3 pb-3"
          style={{ borderTop: "1px solid var(--color-border)" }}
        >
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <p
              className="m-0 text-[11px] leading-relaxed"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Asks Codex to challenge the recent design decisions on this
              branch. Run it after big edits if you want a second opinion.
            </p>
            <button
              type="button"
              onClick={runAdversarial}
              disabled={reviewBusy}
              className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {reviewBusy ? "Running..." : "Run review"}
            </button>
          </div>
          {reviewOutput && (
            <pre
              className="mt-3 max-h-72 overflow-auto rounded p-3 text-[11px] leading-relaxed"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-secondary)",
                whiteSpace: "pre-wrap",
              }}
            >
              {reviewOutput}
            </pre>
          )}
        </div>
      </details>

      <KirkardoCard />
    </div>
  );
}

function KirkardoCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function runKirkardo() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // Spawns a fresh Claude session that activates the repo-evaluator
      // skill (alias "Kirkardo"). Claude opens in a wt.exe tab; the user
      // continues the conversation there. We don't capture the full
      // evaluation inline because Kirkardo expects multi-turn dialogue.
      await invoke("spawn_session", {
        provider: "claude",
        prompt:
          "Kirkardo, evalua este repo (~/.ultron) al estilo de un profesor estricto: arquitectura, tests, docs, riesgos, dependencias, y dame nota final con justificacion. Empieza por la fase 0 de inventario.",
        cwd: null,
        flags: { dangerouslySkipPermissions: false },
      });
      setInfo("Kirkardo session abierta en wt.exe. Continua la evaluacion alli.");
      window.setTimeout(() => setInfo(null), 4000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium" style={{ color: "var(--color-text)" }}>
            Run Kirkardo (repo-evaluator) review
          </div>
          <p
            className="mt-1 text-[11px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Abre una sesion Claude que activa la skill repo-evaluator: corrige
            la entrega como un profesor estricto, arquitectura + tests + docs +
            riesgos + nota final. La sesion se abre en wt.exe para que sigas la
            conversacion alli.
          </p>
        </div>
        <button
          type="button"
          onClick={runKirkardo}
          disabled={busy}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {busy ? "Abriendo..." : "Run Kirkardo"}
        </button>
      </div>
      {error && (
        <div
          className="mt-2 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {info && (
        <div
          className="mt-2 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {info}
        </div>
      )}
    </div>
  );
}
