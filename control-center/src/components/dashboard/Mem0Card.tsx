// Mem0 connection status card. Hits `mem0_status` once per mount.

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
      accent={accent}
      loading={loading}
      error={error}
      action={
        <SmallButton onClick={onOpenMemory} title="Open Memory tab">
          open
        </SmallButton>
      }
    >
      {status && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: status.connected
                  ? "var(--color-success)"
                  : "var(--color-warn)",
              }}
            />
            <span
              className="text-[12.5px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {status.connected ? "Connected" : "Disconnected"}
            </span>
            {status.latency_ms !== null && (
              <span
                className="ml-auto tabular-nums text-[10.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {status.latency_ms}ms
              </span>
            )}
          </div>
          <div
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Key:{" "}
            <code style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>
              {status.api_key_masked ?? "not set"}
            </code>
          </div>
          {status.error && (
            <div
              className="text-[11.5px]"
              style={{ color: "var(--color-warn)" }}
            >
              {status.error}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
