// Mem0Diagnostics — manual sync + log viewer + endpoint test.
// Extracted from Memory.tsx (1151 L) as part of the P1 split refactor.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Mem0DiagnosticsData, Mem0Status, SyncResult } from "./memoryTypes";

// Re-export Mem0Status shape used here (sourced from ../../types originally)
// but we accept the shape inline so no cross-import is needed.

export function Mem0Diagnostics() {
  const [diag, setDiag] = useState<Mem0DiagnosticsData | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Mem0Status | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshDiag = useCallback(async () => {
    try {
      const d = (await invoke("mem0_diagnostics")) as Mem0DiagnosticsData;
      setDiag(d);
      setError(null);
    } catch (e) {
      setError(`diagnostics: ${String(e)}`);
    }
  }, []);

  useEffect(() => { void refreshDiag(); }, [refreshDiag]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const s = (await invoke("mem0_test_connection")) as Mem0Status;
      setTestResult(s);
      void refreshDiag();
    } catch (e) {
      setTestResult({ connected: false, api_key_masked: null, latency_ms: null, error: String(e) });
    } finally {
      setTesting(false);
    }
  }, [refreshDiag]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const r = (await invoke("memory_sync_mem0_manual")) as SyncResult;
      setSyncResult(r);
      void refreshDiag();
    } catch (e) {
      setSyncResult({ ok: false, exit_code: null, stdout: "", stderr: String(e), duration_ms: 0 });
    } finally {
      setSyncing(false);
    }
  }, [refreshDiag]);

  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Mem0 diagnostics</h3>
        <div className="flex gap-2">
          <button
            onClick={() => void handleSync()}
            disabled={syncing}
            className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] disabled:opacity-40"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button
            onClick={() => void handleTest()}
            disabled={testing}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)] disabled:opacity-40"
          >
            {testing ? "Testing…" : "Test endpoint"}
          </button>
          <button
            onClick={() => void refreshDiag()}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
          >
            Refresh log
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border p-2 text-xs"
          style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {testResult && (
        <div className="rounded-md border p-2 text-xs"
          style={{ borderColor: testResult.connected ? "var(--color-success)" : "var(--color-danger)" }}>
          Test:{" "}
          {testResult.connected
            ? `OK${testResult.latency_ms != null ? ` · ${testResult.latency_ms}ms` : ""}`
            : `FAIL — ${testResult.error ?? "unknown error"}`}
        </div>
      )}

      {syncResult && (
        <div className="rounded-md border p-2 text-xs"
          style={{ borderColor: syncResult.ok ? "var(--color-success)" : "var(--color-danger)" }}>
          Sync · exit {syncResult.exit_code ?? "?"} · {syncResult.duration_ms}ms
          {syncResult.stderr && (
            <pre className="mt-1 whitespace-pre-wrap text-[var(--color-text-tertiary)]">
              {syncResult.stderr.slice(0, 400)}
            </pre>
          )}
        </div>
      )}

      <div className="text-xs text-[var(--color-text-tertiary)]">
        Log: <span className="font-mono">{diag?.log_path ?? "—"}</span>
      </div>

      <div className="max-h-48 overflow-y-auto">
        {diag && diag.recent.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {diag.recent.slice(-20).reverse().map((e, i) => (
              <li key={i} className="rounded-md bg-[var(--color-surface-2)] px-2 py-1"
                style={{ color: e.ok ? "var(--color-text-primary)" : "var(--color-danger)" }}>
                <div className="flex justify-between">
                  <span>
                    {e.timestamp} · {e.op}
                    {e.status_code != null ? ` · HTTP ${e.status_code}` : ""}
                    {e.latency_ms != null ? ` · ${e.latency_ms}ms` : ""}
                  </span>
                  <span>{e.ok ? "ok" : "fail"}</span>
                </div>
                {e.error && (
                  <div className="text-[var(--color-text-tertiary)]">err: {e.error}</div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--color-text-tertiary)]">No log entries yet.</p>
        )}
      </div>
    </section>
  );
}
