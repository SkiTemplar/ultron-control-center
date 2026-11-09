// Last backup status — pulls from `backup_status`.
//
// v2.7 redesign: this is one of the "important" cards — bigger Force Backup
// CTA, larger timestamp, explicit destination + folder count, status pill.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Card, SmallButton, relativeTime } from "./Card";
import {
  backupRootIssue,
  forceBackupMessage,
  lastRunView,
  toneColor,
  type BackupLastRun,
  type BackupTone,
} from "./backupLastRun";

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
  last_result: string | null;
}

interface BackupStatusReport {
  /** Vacío si no hay destino configurado. */
  root: string;
  root_configured: boolean;
  root_exists: boolean;
  entries: BackupEntry[];
  overall_status: string;
  last_run: BackupLastRun | null;
  last_run_error: string | null;
}

function accentFor(status: string): "ok" | "warn" | "danger" | "neutral" {
  if (status === "ok") return "ok";
  if (status === "stale") return "warn";
  if (status === "cold" || status === "failed") return "danger";
  return "neutral";
}

/** Etiqueta visible del estado global del backup (los valores vienen del backend). */
const BACKUP_STATUS_LABELS: Record<string, string> = {
  ok: "al día",
  stale: "desfasado",
  cold: "antiguo",
  failed: "fallido",
  missing: "no encontrado",
  unconfigured: "sin destino",
  empty: "vacío",
  unknown: "desconocido",
};

function backupStatusLabel(status: string): string {
  return BACKUP_STATUS_LABELS[status] ?? status;
}

function statusColor(status: string): string {
  if (status === "ok") return "var(--color-success)";
  if (status === "stale") return "var(--color-warn)";
  if (status === "cold" || status === "failed") return "var(--color-danger)";
  return "var(--color-text-tertiary)";
}

export function BackupCard() {
  const [report, setReport] = useState<BackupStatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<{ tone: BackupTone; text: string } | null>(null);

  async function loadStatus(): Promise<BackupStatusReport | null> {
    setLoading(true);
    setError(null);
    try {
      const r = await invoke<BackupStatusReport>("backup_status");
      setReport(r);
      return r;
    } catch (e) {
      setError(String(e));
      return null;
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
      // El script deja el resultado por fuente en backup-last-run.json: se
      // recarga siempre para que la tarjeta enseñe qué falló, no solo «falló».
      const fresh = await loadStatus();
      const msg = forceBackupMessage(result, fresh?.last_run);
      setRunMsg(msg);
      if (msg.tone === "ok") window.setTimeout(() => setRunMsg(null), 4000);
    } catch (e) {
      setError(`El backup ha fallado: ${String(e)}`);
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

  const rootIssue = report ? backupRootIssue(report) : null;
  // Un destino que no existe es un fallo, no un «sin configurar» en gris.
  const accent = rootIssue?.tone === "danger" ? "danger" : accentFor(report?.overall_status ?? "");
  const folderCount = report?.entries.length ?? 0;
  const okCount = report?.entries.filter((e) => e.status === "ok").length ?? 0;

  async function openLog(path: string) {
    try {
      await openPath(path);
    } catch (e) {
      setError(`No se pudo abrir el log: ${String(e)}`);
    }
  }

  const runView = report ? lastRunView(report.last_run, report.last_run_error) : null;
  // Una simulación (-DryRun) no copia nada: no cuenta como último backup.
  const lastRunAt = report?.last_run && !report.last_run.dry_run ? report.last_run.last_run : null;

  async function openRoot() {
    if (!report?.root) return;
    // Si el espejo aún no existe (p.ej. la unidad no está montada o no se ha
    // ejecutado el primer backup), abrir la carpeta fallaría en silencio.
    // Avisamos en vez de no hacer nada.
    if (report.root_exists === false) {
      setError(
        `La carpeta del backup aún no existe: ${report.root}. Pulsa «Forzar backup» o comprueba que la unidad está montada.`,
      );
      return;
    }
    try {
      await openPath(report.root);
    } catch (e) {
      // Antes se tragaba el error y "no abría nada". Ahora lo mostramos.
      setError(`No se pudo abrir la carpeta del backup: ${String(e)}`);
    }
  }

  return (
    <Card
      title="Backup"
      subtitle="Estado del espejo local"
      accent={accent}
      loading={loading}
      error={error}
      empty={
        !loading && !error && !rootIssue && (!report || report.entries.length === 0)
          ? "No hay espejos de backup configurados."
          : null
      }
      action={
        <div className="flex items-center gap-2">
          {report?.root && (
            <SmallButton
              onClick={() => void openRoot()}
              size="md"
              title="Abrir la carpeta raíz del backup en el Explorador"
            >
              Carpeta
            </SmallButton>
          )}
          <SmallButton
            onClick={() => void runBackupNow()}
            disabled={running}
            variant="accent"
            size="md"
            title="Ejecutar ahora el script weekly-backup"
          >
            {running ? "Ejecutando…" : "Forzar backup"}
          </SmallButton>
        </div>
      }
    >
      {runMsg && (
        <div
          className="mb-3 rounded px-2 py-1 text-[12px]"
          role="status"
          style={{
            background: "color-mix(in srgb, " + toneColor(runMsg.tone) + " 10%, transparent)",
            color: toneColor(runMsg.tone),
          }}
        >
          {runMsg.text}
        </div>
      )}
      {rootIssue && (
        <div
          className="mb-3 rounded px-2 py-1.5 text-[12px]"
          role="alert"
          style={{
            background: "color-mix(in srgb, " + toneColor(rootIssue.tone) + " 10%, transparent)",
            color: toneColor(rootIssue.tone),
          }}
        >
          <div>{rootIssue.text}</div>
          {rootIssue.expected && (
            <div
              className="mt-1 truncate"
              style={{ fontFamily: "var(--font-mono, ui-monospace)" }}
              title={rootIssue.expected}
            >
              Esperado: {rootIssue.expected}
            </div>
          )}
          {/* Sin espejos el bloque del último run no se pinta: su motivo
              (p. ej. el aborto del script) va aquí. */}
          {report && report.entries.length === 0 && runView && (
            <div className="mt-1">{runView.text}</div>
          )}
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
              {lastRunAt
                ? relativeTime(lastRunAt)
                : latest
                  ? relativeTime(latest.last_modified)
                  : "nunca"}
            </span>
            <span
              className="rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide"
              style={{
                background: "color-mix(in srgb, " + statusColor(report.overall_status) + " 12%, transparent)",
                color: statusColor(report.overall_status),
              }}
            >
              {backupStatusLabel(report.overall_status)}
            </span>
          </div>

          {/* Resultado real del último run (backup-last-run.json) */}
          {runView && (
            <div
              className="flex items-start justify-between gap-2 rounded px-2 py-1.5 text-[11.5px]"
              style={{
                background: "color-mix(in srgb, " + toneColor(runView.tone) + " 8%, transparent)",
                color: toneColor(runView.tone),
              }}
            >
              <span className="min-w-0">{runView.text}</span>
              {/* El texto del run se parte en líneas; el botón no (antes
                  «Ver log» se partía en dos con un resumen largo). */}
              {runView.logPath && (
                <span className="shrink-0 whitespace-nowrap">
                  <SmallButton
                    onClick={() => void openLog(runView.logPath as string)}
                    title={runView.logPath}
                  >
                    Ver log
                  </SmallButton>
                </span>
              )}
            </div>
          )}

          {/* Stats row */}
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Carpetas"
              value={`${okCount} / ${folderCount}`}
              hint={folderCount === 1 ? "espejo" : "espejos al día"}
            />
            <Stat
              label="Más reciente"
              value={latest ? latest.name : "—"}
              hint={
                latest && latest.age_hours !== null
                  ? `hace ${Math.round(latest.age_hours)} h`
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
              Destino
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
