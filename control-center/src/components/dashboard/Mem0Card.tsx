// Mem0 connection status card. v2.7 redesign: bigger, more prominent.
//   - Status pill with semantic color.
//   - Latency surfaced as a metric chip.
//   - API-key mask and last-error inline.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Mem0Status } from "../../types";
import { Card, SmallButton } from "./Card";

interface Mem0CardProps {
  onOpenMemory?: () => void;
}

export function Mem0Card({ onOpenMemory }: Mem0CardProps) {
  const [status, setStatus] = useState<Mem0Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const r = await invoke<Mem0Status>("mem0_status");
        if (!cancelled) setStatus(r);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const accent = status?.connected
    ? "ok"
    : status && !status.connected
      ? "warn"
      : "neutral";

  return (
    <Card
      title="Mem0"
      subtitle="Memory backend"
      accent={accent}
      loading={loading}
      error={error}
      action={
        <SmallButton
          onClick={onOpenMemory}
          size="md"
          title="Open Memory tab"
        >
          Open
        </SmallButton>
      }
    >
      {status && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{
                background: status.connected
                  ? "var(--color-success)"
                  : "var(--color-warn)",
              }}
            />
            <span
              className="text-[18px] font-semibold leading-none"
              style={{ color: "var(--color-text)" }}
            >
              {status.connected ? "Connected" : "Disconnected"}
            </span>
            {status.latency_ms !== null && (
              <span
                className="ml-auto tabular-nums text-[11px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {status.latency_ms}ms
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <div
              className="text-[12.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              API key
            </div>
            <code
              className="block truncate text-[13px]"
              style={{
                color: "var(--color-text)",
                fontFamily: "var(--font-mono, ui-monospace)",
              }}
            >
              {status.api_key_masked ?? "not set"}
            </code>
          </div>

          {status.error && (
            <div
              className="rounded p-2 text-[12px]"
              style={{
                background: "rgba(210, 153, 34, 0.08)",
                border: "1px solid rgba(210, 153, 34, 0.22)",
                color: "var(--color-warn)",
              }}
            >
              {status.error}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
