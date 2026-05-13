import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { McpInfo, McpStatus } from "../types";

// ---------------------------------------------------------------------------
// Status visuals
// ---------------------------------------------------------------------------

const HIDE_KEY = "ultron.cc.hidden_mcps.v1";

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function saveHidden(s: Set<string>) {
  try {
    localStorage.setItem(HIDE_KEY, JSON.stringify(Array.from(s)));
  } catch {}
}

function statusColor(s: McpStatus, expectedOffline: boolean): string {
  if (s === "ok") return "var(--color-success)";
  if (s === "degraded" || s === "missing") {
    return expectedOffline ? "var(--color-text-tertiary)" : "var(--color-warn)";
  }
  return "var(--color-text-faint)";
}

function statusLabel(s: McpStatus, expectedOffline: boolean): string {
  if (s === "ok") return "connected";
  if (s === "degraded") return expectedOffline ? "offline" : "degraded";
  if (s === "missing") return "missing";
  if (s === "unknown") return "unknown";
  return s;
}

// ---------------------------------------------------------------------------
// MCP card
// ---------------------------------------------------------------------------

type Action = "retry" | "diagnose" | "hide";

function Card({
  mcp,
  hidden,
  onAction,
  busy,
}: {
  mcp: McpInfo;
  hidden: boolean;
  onAction: (a: Action) => void;
  busy: boolean;
}) {
  const color = statusColor(mcp.status, mcp.expected_offline);
  const label = statusLabel(mcp.status, mcp.expected_offline);

  return (
    <div
      className="rounded p-4 transition-opacity"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        opacity: hidden ? 0.45 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <h3 className="text-[14px] font-semibold leading-none">{mcp.name}</h3>
            <span
              className="text-[10.5px] uppercase tracking-[0.06em]"
              style={{ color }}
            >
              {label}
            </span>
            {mcp.expected_offline && (
              <span
                className="text-[10px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                expected offline
              </span>
            )}
          </div>

          <div
            className="mt-2 flex items-center gap-3 text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            <span>
              <span style={{ color: "var(--color-text-faint)" }}>transport</span> {mcp.transport}
            </span>
            {mcp.last_checked && (
              <span>
                <span style={{ color: "var(--color-text-faint)" }}>checked</span>{" "}
                {mcp.last_checked.slice(0, 16).replace("T", " ")}
              </span>
            )}
          </div>

          {/* command / url preview */}
          <div className="mt-2 truncate text-[11.5px]" style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }} title={mcp.command || mcp.url || ""}>
            {mcp.url ? mcp.url : (mcp.command ? mcp.command + (mcp.args_preview ? ` ${mcp.args_preview}` : "") : "—")}
          </div>

          {/* fallback message */}
          {mcp.fallback_message && mcp.status !== "ok" && (
            <p
              className="mt-3 text-[12px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {mcp.fallback_message}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onAction("retry")}
            disabled={busy}
            className="rounded px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title="Re-run health check for all MCPs"
          >
            {busy ? "Probing…" : "Retry"}
          </button>
          <button
            type="button"
            onClick={() => onAction("hide")}
            className="rounded px-2.5 py-1 text-[11px] transition-colors"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title={hidden ? "Show again" : "Hide from list (UI only, settings.json untouched)"}
          >
            {hidden ? "Unhide" : "Hide"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function MCPs() {
  const [mcps, setMcps] = useState<McpInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden());
  const [showHidden, setShowHidden] = useState(false);
  const [probing, setProbing] = useState(false);

  useEffect(() => saveHidden(hidden), [hidden]);

  async function fetchList() {
    try {
      const list = (await invoke("list_mcps")) as McpInfo[];
      setMcps(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runProbe() {
    setProbing(true);
    try {
      const list = (await invoke("run_mcp_health_check")) as McpInfo[];
      setMcps(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  }

  useEffect(() => {
    fetchList();
    const t = setInterval(fetchList, 30_000);
    return () => clearInterval(t);
  }, []);

  function toggleHidden(name: string) {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setHidden(next);
  }

  const visible = mcps.filter((m) => !hidden.has(m.name) || showHidden);
  const okCount = mcps.filter((m) => m.status === "ok").length;
  const issueCount = mcps.filter(
    (m) => (m.status === "degraded" || m.status === "missing") && !m.expected_offline,
  ).length;

  return (
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">MCPs</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            {mcps.length} servers · {okCount} connected · {issueCount} need attention
          </p>
        </div>
        <button
          type="button"
          onClick={runProbe}
          disabled={probing}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {probing ? "Probing…" : "Run health check"}
        </button>
      </header>

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

      {hidden.size > 0 && (
        <div className="mb-4 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          {hidden.size} hidden ·{" "}
          <button
            type="button"
            onClick={() => setShowHidden(!showHidden)}
            className="underline-offset-2 hover:underline"
          >
            {showHidden ? "hide them" : "show them"}
          </button>
        </div>
      )}

      {loading && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </div>
      )}

      {!loading && mcps.length === 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          No MCPs configured in ~/.claude/settings.json mcpServers.
        </div>
      )}

      <div className="space-y-2">
        {visible.map((m) => (
          <Card
            key={m.name}
            mcp={m}
            hidden={hidden.has(m.name)}
            busy={probing}
            onAction={(a) => {
              if (a === "retry" || a === "diagnose") runProbe();
              else if (a === "hide") toggleHidden(m.name);
            }}
          />
        ))}
      </div>
    </div>
  );
}
