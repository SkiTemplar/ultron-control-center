// Resultado real del último backup (crate::backup_status::last_run).
//
// La tarjeta de Backup y Settings → Backups se deducían solo del mtime de las
// carpetas espejo: un run que falló en 6 de 8 fuentes y en el snapshot de
// brain.db se pintaba «ok». Este módulo traduce `last_run` del informe a lo
// que se enseña: tono, texto y log que abrir.

export interface BackupSourceResult {
  source: string;
  dest_name: string;
  code: number | null;
  skipped: boolean;
  failed: boolean;
}

export interface BackupLastRun {
  last_run: string | null;
  dry_run: boolean;
  backup_root: string | null;
  sources: BackupSourceResult[];
  failed_sources: string[];
  brain_snapshot: boolean | null;
  failed: boolean;
  /** El script abortó antes de copiar (exit 2). */
  aborted: boolean;
  /** `no_destination` | `drive_missing` | `same_volume` cuando `aborted`. */
  error_code: string | null;
  error: string | null;
  log: string | null;
  robocopy_log: string | null;
  summary: string;
}

export type BackupTone = "ok" | "warn" | "danger" | "neutral";

export interface BackupLastRunView {
  tone: BackupTone;
  text: string;
  /** Log principal del run (líneas FAIL/OK por fuente). */
  logPath: string | null;
  /** Log de robocopy con los errores por fichero. */
  robocopyLogPath: string | null;
}

export function lastRunView(
  lastRun: BackupLastRun | null | undefined,
  readError?: string | null,
): BackupLastRunView {
  if (readError) {
    return {
      tone: "warn",
      text: `No se pudo leer el resultado del último backup: ${readError}`,
      logPath: null,
      robocopyLogPath: null,
    };
  }
  if (!lastRun) {
    return {
      tone: "neutral",
      text: "El script de backup no ha registrado ninguna ejecución todavía; el estado sale solo de la fecha de las carpetas.",
      logPath: null,
      robocopyLogPath: null,
    };
  }
  let tone: BackupTone = "ok";
  if (lastRun.failed) tone = "danger";
  if (lastRun.dry_run) tone = "neutral";
  return {
    tone,
    text: lastRun.summary,
    logPath: lastRun.log ?? lastRun.robocopy_log,
    robocopyLogPath: lastRun.log ? lastRun.robocopy_log : null,
  };
}

/** Lo mínimo del informe que hace falta para juzgar el destino. */
interface BackupRootLike {
  root: string;
  /** Hay destino en backup-root.txt o ULTRON_BACKUP_ROOT. */
  root_configured: boolean;
  root_exists: boolean;
  last_run: BackupLastRun | null;
}

export interface BackupRootIssue {
  tone: BackupTone;
  text: string;
  /** Ruta donde se esperaba el espejo (la del último run real, si la hay). */
  expected: string;
}

function normalizeRoot(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}

/**
 * Problema con el destino del backup, o `null` si el destino es coherente.
 *
 * Desde el 2026-10-23 no hay destino por defecto: sin `backup-root.txt` ni
 * `ULTRON_BACKUP_ROOT` el script aborta, y la tarjeta lo dice en rojo en vez
 * de enseñar «No hay espejos» en gris. La ruta esperada sale del último run
 * real (no de una simulación).
 */
export function backupRootIssue(report: BackupRootLike): BackupRootIssue | null {
  const run = report.last_run && !report.last_run.dry_run ? report.last_run : null;
  const lastRoot = run?.backup_root?.trim() || null;
  if (!report.root_configured) {
    return {
      tone: "danger",
      text: "No hay destino de backup configurado: la copia semanal aborta sin copiar nada hasta que elijas una carpeta en otra unidad en Ajustes → Backups.",
      expected: lastRoot ?? "",
    };
  }
  const differs = lastRoot !== null && normalizeRoot(lastRoot) !== normalizeRoot(report.root);
  if (!report.root_exists) {
    const expected = lastRoot ?? report.root;
    const detail = differs
      ? `El último run escribió en ${lastRoot}, pero el destino configurado ahora es ${report.root}, que no existe.`
      : `Conecta la unidad del backup o elige otra carpeta en Ajustes → Backups.`;
    return { tone: "danger", text: `No se encuentra el destino del backup: ${expected}. ${detail}`, expected };
  }
  if (differs && lastRoot) {
    return {
      tone: "warn",
      text: `Se muestra ${report.root}, pero el último run escribió en ${lastRoot}. Si has cambiado el destino, estos espejos no son todavía tu última copia.`,
      expected: lastRoot,
    };
  }
  return null;
}

export function toneColor(tone: BackupTone): string {
  if (tone === "ok") return "var(--color-success)";
  if (tone === "warn") return "var(--color-warn)";
  if (tone === "danger") return "var(--color-danger)";
  return "var(--color-text-tertiary)";
}

interface RunResultLike {
  success: boolean;
  exit_code: number | null;
  /** Salida de error del script: una excepción de PowerShell solo queda aquí. */
  stderr?: string;
}

const STDERR_MAX = 300;

/**
 * Mensaje tras «Force backup». El código 1 del script es «terminó, pero con
 * fuentes fallidas»: el detalle está en el resumen del último run, no en un
 * genérico «see logs». Si el script murió antes de escribir el JSON, el
 * resumen es el del run anterior, así que también se enseña su stderr.
 */
export function forceBackupMessage(
  result: RunResultLike,
  lastRun: BackupLastRun | null | undefined,
): { tone: BackupTone; text: string } {
  if (result.success && !lastRun?.failed) {
    return { tone: "ok", text: lastRun?.summary ?? "Backup terminado sin errores." };
  }
  const stderr = (result.stderr ?? "").trim().replace(/\s+/g, " ");
  const stderrTail = stderr
    ? ` stderr: ${stderr.length > STDERR_MAX ? `${stderr.slice(0, STDERR_MAX)}…` : stderr}`
    : "";
  if (result.exit_code === 2) {
    // El script escribe el motivo del aborto en backup-last-run.json.
    const reason = lastRun?.aborted
      ? lastRun.summary
      : `El backup no arrancó (código 2): falta el destino, la unidad no está montada o está en el mismo disco que las fuentes.${stderrTail}`;
    return { tone: "danger", text: reason };
  }
  const code = result.exit_code ?? "?";
  const detail = lastRun?.summary ?? "sin resumen de la ejecución; revisa el log en ~/.ultron/logs.";
  return { tone: "danger", text: `Backup con errores (código ${code}). ${detail}${stderrTail}` };
}
