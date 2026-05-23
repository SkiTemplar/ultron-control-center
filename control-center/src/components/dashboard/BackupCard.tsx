// Last backup status — pulls from `backup_status`.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Card, SmallButton, relativeTime } from "./Card";

// Mirrors crate::backup_status::{BackupStatusReport, BackupEntry}.
interface BackupEntry {
  name: string;
  path: string;
  last_modified: string | null;
  age_hours: number | null;
  exists: boolean;
  status: string;
}

interface BackupStatusReport {
  root: string;
  root_exists: boolean;
  entries: BackupEntry[];
  overall_status: string;
}

function accentFor(status: string): "ok" | "warn" | "danger" | "neutral" {
  if (status === "ok") return "ok";
  if (status === "stale") return "warn";
  if (status === "cold") return "danger";
  return "neutral";
}

export function BackupCard() {
  const [report, setReport] = useState<BackupStatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const r = await invoke<BackupStatusReport>("backup_status");
        if (!cancelled) setReport(r);
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

  // Newest entry across all sources.
  const latest = report?.entries
    .filter((e) => e.last_modified)
    .sort((a, b) => {
      const at = a.last_modified ?? "";
      const bt = b.last_modified ?? "";
      return at < bt ? 1 : at > bt ? -1 : 0;
    })[0];

  const accent = accentFor(report?.overall_status ?? "");

  async function openRoot() {
    if (report?.root) {
      try {
        await openPath(report.root);
      } catch {
        // ignore — best-effort
      }
    }
  }

  return (
    <Card
      title="Last backup"
      accent={accent}
      loading={loading}
      error={error}
      empty={
        !loading && !error && (!report || report.entries.length === 0)
          ? "No backup mirrors configured."
          : null
      }
      action={
        report?.root ? (
          <SmallButton onClick={() => void openRoot()} title="Open backup root">
            folder
          </SmallButton>
        ) : null
      }
    >
      {report && report.entries.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-baseline gap-2">
            <span
              className="text-[12.5px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {latest ? relativeTime(latest.last_modified) : "never"}
            </span>
            <span
              className="text-[10.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {report.overall_status}
            </span>
          </div>
          <div
            className="truncate text-[11px]"
            style={{
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-mono, ui-monospace)",
            }}
            title={report.root}
          >
            {report.root}
          </div>
          {latest && (
            <div
              className="text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Newest mirror: {latest.name}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
