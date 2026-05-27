// GraphifyControls — index project + list known projects pane.
// Extracted from Memory.tsx (1151 L) as part of the P1 split refactor.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GraphifyCardStatus, IndexResult } from "./memoryTypes";

export function GraphifyControls() {
  const [status, setStatus] = useState<GraphifyCardStatus | null>(null);
  const [path, setPath] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<IndexResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = (await invoke("memory_status_graphify")) as GraphifyCardStatus;
      setStatus(s);
    } catch (e) {
      setStatus({ healthy: false, installed: false, version: null, project_count: null, projects: [], error: String(e) });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const runIndex = useCallback(async () => {
    if (!path.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      const r = (await invoke("memory_graphify_index", { path: path.trim() })) as IndexResult;
      setResult(r);
      void refresh();
    } catch (e) {
      setResult({ ok: false, exit_code: null, stdout: "", stderr: String(e), duration_ms: 0 });
    } finally {
      setRunning(false);
    }
  }, [path, refresh]);

  const installed = Boolean(status?.installed);

  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Graphify controls</h3>
        <span className="text-xs text-[var(--color-text-tertiary)]">
          {installed ? `installed${status?.version ? ` · ${status.version}` : ""}` : "not installed"}
        </span>
      </div>

      {!installed && (
        <p className="text-xs text-[var(--color-text-tertiary)]">
          Graphify CLI was not found in PATH. Install it (npm i -g graphify or equivalent) and refresh.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Project path to index (e.g. C:\\Users\\USER\\proyectos\\foo)"
          className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        />
        <button
          onClick={() => void runIndex()}
          disabled={!installed || running || !path.trim()}
          className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
        >
          {running ? "Indexing…" : "Index project"}
        </button>
      </div>

      {result && (
        <div className="rounded-md border p-2 text-xs"
          style={{ borderColor: result.ok ? "var(--color-success)" : "var(--color-danger)" }}>
          Index · exit {result.exit_code ?? "?"} · {result.duration_ms}ms
          {result.stdout && <pre className="mt-1 whitespace-pre-wrap">{result.stdout.slice(0, 400)}</pre>}
          {result.stderr && (
            <pre className="mt-1 whitespace-pre-wrap text-[var(--color-text-tertiary)]">
              {result.stderr.slice(0, 400)}
            </pre>
          )}
        </div>
      )}

      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          Indexed projects ({status?.project_count ?? 0})
        </div>
        {status && status.projects.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-xs">
            {status.projects.map((p) => (
              <li key={p} className="rounded-md bg-[var(--color-surface-2)] px-2 py-0.5 font-mono">{p}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--color-text-tertiary)]">No graphify projects detected.</p>
        )}
      </div>
    </section>
  );
}
