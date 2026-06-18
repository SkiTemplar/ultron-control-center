import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_PAYLOAD } from "./constants";
import type { HookRecord, HookTestResult } from "./types";

export function TestModal({ hook, onClose }: { hook: HookRecord; onClose: () => void }) {
  const [payload, setPayload] = useState<string>(DEFAULT_PAYLOAD);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HookTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const res = (await invoke("test_hook", {
        id: hook.id,
        mockPayload: payload,
      })) as HookTestResult;
      setResult(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[700px] rounded-md border p-5 shadow-xl"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[15px] font-semibold">Test hook</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[11.5px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Close
          </button>
        </div>

        <div
          className="mb-3 rounded border px-3 py-2 text-[11.5px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Runs the command in a sandboxed PowerShell with a 5s timeout. The payload is exposed
          via the <code>CLAUDE_HOOK_PAYLOAD</code> env var. Hooks that block on stdin will hit the
          timeout.
        </div>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Mock payload (JSON)
          </div>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={5}
            className="w-full rounded px-2 py-1 font-mono text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {running ? "Running..." : "Run"}
          </button>
        </div>

        {err && (
          <div
            className="mb-3 rounded border px-2 py-1 text-[11.5px]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-danger, #f88)" }}
          >
            {err}
          </div>
        )}

        {result && (
          <div>
            {result.timed_out && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11.5px] font-semibold"
                style={{
                  borderColor: "var(--color-warn, #f80)",
                  background: "rgba(248,136,0,0.10)",
                  color: "var(--color-warn, #f80)",
                }}
              >
                TIMED OUT after 5s — the command likely blocked on stdin or an interactive prompt.
              </div>
            )}
            {!result.timed_out && !result.success && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11.5px] font-semibold"
                style={{
                  borderColor: "var(--color-danger, #f88)",
                  background: "rgba(248,113,113,0.10)",
                  color: "var(--color-danger, #f88)",
                }}
              >
                FAILED (exit code {result.exit_code ?? "?"})
              </div>
            )}
            {result.success && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11.5px] font-semibold"
                style={{
                  borderColor: "var(--color-success, #2da)",
                  background: "rgba(45,212,191,0.10)",
                  color: "var(--color-success, #2da)",
                }}
              >
                OK (exit 0) · {result.elapsed_ms}ms
              </div>
            )}
            {(["stdout", "stderr"] as const).map((ch) => (
              <div key={ch} className="mb-2">
                <div
                  className="mb-1 text-[10px] uppercase"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {ch}
                </div>
                <pre
                  className="max-h-48 overflow-auto rounded border p-2 text-[11.5px]"
                  style={{
                    borderColor: "var(--color-border)",
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {result[ch] || "(empty)"}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
