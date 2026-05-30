// Last backup status — pulls from `backup_status`.
//
// v2.7 redesign: this is one of the "important" cards — bigger Force Backup
// CTA, larger timestamp, explicit destination + folder count, status pill.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Card, SmallButton, relativeTime } from "./Card";

interface MaintenanceResult {
  kind: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  elapsed_ms: number;
}

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

function statusColor(status: string): string {
  if (status === "ok") return "var(--color-success)";
  if (status === "stale") return "var(--color-warn)";
  if (status === "cold") return "var(--color-danger)";
  return "var(--color-text-tertiary)";
}

export function BackupCard() {
  const [report, setReport] = useState<BackupStatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const r = await invoke<BackupStatusReport>("backup_status");
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await invoke<BackupStatusReport>("backup_status");
        if (!cancelled) setReport(r);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runBackupNow() {
    setRunning(true);
    setRunMsg(null);
    try {
      const result = await invoke<MaintenanceResult>("run_backup_now");
      if (result.success) {
        setRunMsg("Backup finalizado correctamente.");
        window.setTimeout(() => setRunMsg(null), 4000);
        await loadStatus();
      } else {
        const detail = result.stderr.trim() || result.stdout.trim() || "sin detalle";
        setError(`Backup falló (código ${result.exit_code ?? "?"}) — ${detail}`);
      }
    } catch (e) {
      setError(`Backup failed: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  // Newest entry across all sources.
  const latest = report?.entries
    .filter((e) => e.last_modified)
    .sort((a, b) => {
      const at = a.last_modified ?? "";
      const bt = b.last_modified ?? "";
      return at < bt ? 1 : at > bt ? -1 : 0;
    })[0];

  const accent = accentFor(report?.overall_status ?? "");
  const folderCount = report?.entries.length ?? 0;
  const okCount = report?.entries.filter((e) => e.status === "ok").length ?? 0;

  async function openRoot() {
    if (!report?.root) return;
    // Si el espejo aún no existe (p.ej. la unidad no está montada o no se ha
    // ejecutado el primer backup), abrir la carpeta fallaría en silencio.
    // Avisamos en vez de no hacer nada.
    if (report.root_exists === false) {
      setError(
        `La carpeta de backup no existe todavía: ${report.root}. Ejecuta "Force Backup" o verifica que la unidad está montada.`,
      );
      return;
    }
    try {
      await openPath(report.root);
    } catch (e) {
      // Antes se tragaba el error y "no abría nada". Ahora lo mostramos.
      setError(`No se pudo abrir la carpeta de backup: ${String(e)}`);
    }
  }

  return (
    <Card
      title="Backup"
      subtitle="Local mirror status"
      accent={accent}
      loading={loading}
      error={error}
      empty={
        !loading && !error && (!report || report.entries.length === 0)
          ? "No backup mirrors configured."
          : null
      }
      action={
        <div className="flex items-center gap-2">
          {report?.root && (
            <SmallButton
              onClick={() => void openRoot()}
              size="md"
              title="Open backup root in file explorer"
            >
              Folder
            </SmallButton>
          )}
          <SmallButton
            onClick={() => void runBackupNow()}
            disabled={running}
            variant="accent"
            size="md"
            title="Run weekly-backup script now"
          >
            {running ? "Running…" : "Force Backup"}
          </SmallButton>
        </div>
      }
    >
      {runMsg && (
        <div
          className="mb-3 rounded px-2 py-1 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            color: "var(--color-success)",
          }}
        >
          {runMsg}
        </div>
      )}
      {report && report.entries.length > 0 && (
        <div className="space-y-3">
          {/* Hero: last backup time + status pill */}
          <div className="flex items-baseline gap-3">
            <span
              className="text-[22px] font-semibold leading-none"
              style={{ color: "var(--color-text)" }}
            >
              {latest ? relativeTime(latest.last_modified) : "never"}
            </span>
            <span
              className="rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide"
              style={{
                background: "color-mix(in srgb, " + statusColor(report.overall_status) + " 12%, transparent)",
                color: statusColor(report.overall_status),
              }}
            >
              {report.overall_status}
            </span>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Folders"
              value={`${okCount} / ${folderCount}`}
              hint={folderCount === 1 ? "mirror" : "mirrors ok"}
            />
            <Stat
              label="Newest"
              value={latest ? latest.name : "—"}
              hint={
                latest && latest.age_hours !== null
                  ? `${Math.round(latest.age_hours)}h old`
                  : undefined
              }
            />
          </div>

          {/* Destination */}
          <div className="space-y-1">
            <div
              className="text-[11.5px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Destination
            </div>
            <div
              className="truncate text-[12.5px]"
              style={{
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono, ui-monospace)",
              }}
              title={report.root}
            >
              {report.root}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      className="rounded p-2.5"
      style={{
        background: "var(--color-surface-3)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="text-[10.5px] uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div
        className="mt-1 truncate text-[14px] font-semibold tabular-nums"
        style={{ color: "var(--color-text)" }}
        title={value}
      >
        {value}
      </div>
      {hint && (
        <div
          className="mt-0.5 text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
