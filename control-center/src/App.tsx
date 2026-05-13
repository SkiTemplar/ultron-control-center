import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type CmdResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
};

type QdrantHealth = {
  status: string;
  message: string;
  elapsed_sec: number;
  timestamp: string;
};

function StatusDot({ status }: { status: "ok" | "warn" | "down" | "loading" }) {
  const color =
    status === "ok"
      ? "bg-[var(--color-ultron-success)]"
      : status === "warn"
        ? "bg-[var(--color-ultron-warn)]"
        : status === "down"
          ? "bg-[var(--color-ultron-danger)]"
          : "bg-[var(--color-ultron-text-faint)]";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

export default function App() {
  const [statusOutput, setStatusOutput] = useState<CmdResult | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [qdrant, setQdrant] = useState<QdrantHealth | null>(null);
  const [qdrantErr, setQdrantErr] = useState<string | null>(null);

  async function refreshQdrant() {
    try {
      const h = (await invoke("qdrant_health")) as QdrantHealth;
      setQdrant(h);
      setQdrantErr(null);
    } catch (e) {
      setQdrantErr(String(e));
      setQdrant(null);
    }
  }

  async function runStatus() {
    setStatusLoading(true);
    try {
      const r = (await invoke("ultron_status")) as CmdResult;
      setStatusOutput(r);
    } catch (e) {
      setStatusOutput({
        success: false,
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setStatusLoading(false);
    }
  }

  useEffect(() => {
    refreshQdrant();
    const t = setInterval(refreshQdrant, 15_000);
    return () => clearInterval(t);
  }, []);

  const qdrantStatus: "ok" | "warn" | "down" | "loading" = !qdrant
    ? qdrantErr
      ? "down"
      : "loading"
    : qdrant.status === "up"
      ? "ok"
      : "down";

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-[var(--color-ultron-border)] bg-[var(--color-ultron-surface)] p-4">
        <div className="mb-6 flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-gradient-to-br from-[var(--color-ultron-accent)] to-[var(--color-ultron-purple)]" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">ULTRON</div>
            <div className="text-xs text-[var(--color-ultron-text-faint)]">Control Center</div>
          </div>
        </div>

        <nav className="space-y-1 text-sm">
          {[
            { label: "Dashboard", active: true },
            { label: "MCPs", soon: true },
            { label: "Skills", soon: true },
            { label: "Projects", soon: true },
            { label: "Memory", soon: true },
            { label: "Plans", soon: true },
            { label: "Logs", soon: true },
            { label: "Settings", soon: true },
          ].map((item) => (
            <div
              key={item.label}
              className={`flex items-center justify-between rounded-md px-3 py-1.5 ${
                item.active
                  ? "bg-[var(--color-ultron-accent)]/15 text-[var(--color-ultron-text)]"
                  : "text-[var(--color-ultron-text-dim)] hover:bg-[var(--color-ultron-surface-hover)]"
              }`}
            >
              <span>{item.label}</span>
              {item.soon && (
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-ultron-text-faint)]">
                  v15.1
                </span>
              )}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto p-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-[var(--color-ultron-text-faint)]">
            Estado general del sistema ULTRON · v15.1 Foundation
          </p>
        </header>

        {/* Status cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-[var(--color-ultron-border)] bg-[var(--color-ultron-surface)] p-5">
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-[var(--color-ultron-text-faint)]">
              <StatusDot status={qdrantStatus} />
              Qdrant
            </div>
            <div className="font-medium">
              {qdrant?.status ?? (qdrantErr ? "no health.json" : "...")}
            </div>
            <div className="mt-1 text-xs text-[var(--color-ultron-text-dim)]">
              {qdrant?.message ?? qdrantErr ?? ""}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--color-ultron-border)] bg-[var(--color-ultron-surface)] p-5">
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-[var(--color-ultron-text-faint)]">
              <StatusDot status="loading" />
              MCPs
            </div>
            <div className="font-medium">próximamente</div>
            <div className="mt-1 text-xs text-[var(--color-ultron-text-dim)]">
              Fase 3 · ficha por MCP, retry, diagnose
            </div>
          </div>

          <div className="rounded-lg border border-[var(--color-ultron-border)] bg-[var(--color-ultron-surface)] p-5">
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-[var(--color-ultron-text-faint)]">
              <StatusDot status="loading" />
              Memory
            </div>
            <div className="font-medium">próximamente</div>
            <div className="mt-1 text-xs text-[var(--color-ultron-text-dim)]">
              Fase 5 · vault sync, brain query, recall
            </div>
          </div>
        </div>

        {/* Sidecar test */}
        <div className="mt-8 rounded-lg border border-[var(--color-ultron-border)] bg-[var(--color-ultron-surface)] p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="font-medium">Test: invoke ultron status</div>
              <div className="text-xs text-[var(--color-ultron-text-dim)]">
                Sidecar a PowerShell · prueba la cadena IPC frontend ↔ Rust ↔ ultron.ps1
              </div>
            </div>
            <button
              type="button"
              onClick={runStatus}
              disabled={statusLoading}
              className="rounded-md bg-[var(--color-ultron-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-ultron-accent-hover)] disabled:opacity-50"
            >
              {statusLoading ? "ejecutando…" : "ejecutar"}
            </button>
          </div>
          {statusOutput && (
            <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-[var(--color-ultron-bg)] p-3 font-mono text-xs leading-relaxed text-[var(--color-ultron-text-dim)]">
              {statusOutput.stdout || statusOutput.stderr || "(sin output)"}
              {statusOutput.exit_code !== null && (
                <div className="mt-2 text-[var(--color-ultron-text-faint)]">
                  exit code: {statusOutput.exit_code}
                </div>
              )}
            </pre>
          )}
        </div>
      </main>
    </div>
  );
}
