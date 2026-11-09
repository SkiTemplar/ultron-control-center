// La tarjeta de Backup enseña el resultado real del último run
// (backup-last-run.json) y no solo la fecha de las carpetas.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { BackupCard } from "../BackupCard";
import {
  backupRootIssue,
  forceBackupMessage,
  lastRunView,
  type BackupLastRun,
} from "../backupLastRun";

const FAILED_RUN: BackupLastRun = {
  last_run: "2026-10-11T23:01:38+02:00",
  dry_run: false,
  backup_root: "D:\\BACKUP",
  sources: [
    { source: ".ultron", dest_name: "dot-ultron", code: 11, skipped: false, failed: true },
    { source: ".claude", dest_name: "dot-claude", code: 3, skipped: false, failed: false },
  ],
  failed_sources: [".ultron"],
  brain_snapshot: false,
  failed: true,
  aborted: false,
  error_code: null,
  error: null,
  log: "C:\\logs\\backup-2026-10-11.log",
  robocopy_log: "C:\\logs\\backup-2026-10-11.robocopy.log",
  summary:
    "Último run 2026-10-11T23:01:38+02:00: fallaron 1 de 2 fuentes (.ultron); el snapshot de brain.db falló.",
};

const OK_RUN: BackupLastRun = {
  ...FAILED_RUN,
  sources: [FAILED_RUN.sources[1]],
  failed_sources: [],
  brain_snapshot: true,
  failed: false,
  summary: "Último run 2026-10-11T23:01:38+02:00: 1 de 1 fuentes OK; snapshot de brain.db OK.",
};

/** Lo que deja weekly-backup.ps1 cuando aborta sin destino (N1, 2026-10-23). */
const ABORTED_RUN: BackupLastRun = {
  ...FAILED_RUN,
  backup_root: null,
  sources: [],
  failed_sources: [],
  brain_snapshot: null,
  aborted: true,
  error_code: "no_destination",
  error: "No backup destination configured: ...",
  log: null,
  robocopy_log: null,
  summary:
    "Último run 2026-10-25T10:00:00+01:00 abortado: no hay destino de backup configurado; elige una carpeta en otra unidad en Ajustes → Backups. No se copió nada.",
};

describe("lastRunView", () => {
  it("un run fallido va en rojo con su log", () => {
    const v = lastRunView(FAILED_RUN);
    expect(v.tone).toBe("danger");
    expect(v.text).toMatch(/fallaron 1 de 2/);
    expect(v.logPath).toBe(FAILED_RUN.log);
    expect(v.robocopyLogPath).toBe(FAILED_RUN.robocopy_log);
  });

  it("un run limpio va en verde (caso negativo)", () => {
    expect(lastRunView(OK_RUN).tone).toBe("ok");
  });

  it("sin registro lo dice en vez de dar el backup por bueno", () => {
    const v = lastRunView(null);
    expect(v.tone).toBe("neutral");
    expect(v.text).toMatch(/no ha registrado ninguna ejecución/);
  });

  it("un fichero ilegible es un aviso, no un silencio", () => {
    expect(lastRunView(null, "JSON inválido").tone).toBe("warn");
  });
});

describe("forceBackupMessage", () => {
  it("el código 1 enseña el resumen del run, no «Backup finished»", () => {
    const m = forceBackupMessage({ success: false, exit_code: 1 }, FAILED_RUN);
    expect(m.tone).toBe("danger");
    expect(m.text).toMatch(/código 1/);
    expect(m.text).toMatch(/fallaron 1 de 2/);
  });

  it("si el script muere antes de escribir el JSON, enseña su stderr", () => {
    const m = forceBackupMessage(
      { success: false, exit_code: 1, stderr: "Exception: Access denied\r\n at line 12" },
      OK_RUN,
    );
    expect(m.tone).toBe("danger");
    expect(m.text).toMatch(/stderr: Exception: Access denied at line 12/);
    // Sin stderr no se añade nada (caso negativo).
    expect(forceBackupMessage({ success: false, exit_code: 1 }, FAILED_RUN).text).not.toMatch(
      /stderr/,
    );
  });

  it("un run correcto es ok", () => {
    expect(forceBackupMessage({ success: true, exit_code: 0 }, OK_RUN).tone).toBe("ok");
  });

  it("el código 2 enseña el motivo del aborto que dejó el script", () => {
    const m = forceBackupMessage({ success: false, exit_code: 2 }, ABORTED_RUN);
    expect(m.tone).toBe("danger");
    expect(m.text).toMatch(/no hay destino de backup configurado/);
  });

  it("el código 2 sin aborto registrado da la lista de causas (caso negativo)", () => {
    const m = forceBackupMessage({ success: false, exit_code: 2 }, OK_RUN);
    expect(m.text).toMatch(/no arrancó \(código 2\)/);
  });
});

describe("backupRootIssue", () => {
  it("sin destino configurado: danger aunque haya un run bueno anterior", () => {
    const issue = backupRootIssue({ root: "", root_configured: false, root_exists: false, last_run: OK_RUN });
    expect(issue?.tone).toBe("danger");
    expect(issue?.text).toMatch(/No hay destino de backup configurado/);
    expect(issue?.expected).toBe("D:\\BACKUP");
  });

  it("unidad desconectada: danger con la ruta del último run real", () => {
    const issue = backupRootIssue({
      root: "E:\\BACKUP",
      root_configured: true,
      root_exists: false,
      last_run: OK_RUN,
    });
    expect(issue?.tone).toBe("danger");
    expect(issue?.expected).toBe("D:\\BACKUP");
    expect(issue?.text).toMatch(/el destino configurado ahora es E:\\BACKUP/);
  });

  it("destino sin montar ni run previo también es danger, con la ruta leída", () => {
    const issue = backupRootIssue({
      root: "D:\\BACKUP",
      root_configured: true,
      root_exists: false,
      last_run: null,
    });
    expect(issue?.tone).toBe("danger");
    expect(issue?.expected).toBe("D:\\BACKUP");
  });

  it("otro destino mientras el último run fue a D: → aviso", () => {
    const issue = backupRootIssue({
      root: "E:\\BACKUP",
      root_configured: true,
      root_exists: true,
      last_run: OK_RUN,
    });
    expect(issue?.tone).toBe("warn");
    expect(issue?.expected).toBe("D:\\BACKUP");
  });

  it("mismo destino (con otra grafía) no es un problema (caso negativo)", () => {
    expect(
      backupRootIssue({ root: "d:/backup/", root_configured: true, root_exists: true, last_run: OK_RUN }),
    ).toBeNull();
  });

  it("una simulación no fija la ruta esperada (caso negativo)", () => {
    const dry = { ...OK_RUN, dry_run: true, backup_root: "E:\\OTRA" };
    expect(
      backupRootIssue({ root: "D:\\BACKUP", root_configured: true, root_exists: true, last_run: dry }),
    ).toBeNull();
  });
});

describe("BackupCard", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("un mirror con mtime reciente no tapa un run fallido", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "D:\\BACKUP",
      root_configured: true,
      root_exists: true,
      overall_status: "failed",
      last_run: FAILED_RUN,
      last_run_error: null,
      entries: [
        {
          name: "dot-ultron",
          path: "D:\\BACKUP\\dot-ultron",
          last_modified: new Date().toISOString(),
          age_hours: 1,
          exists: true,
          status: "failed",
          last_result: "failed",
        },
      ],
    });
    render(<BackupCard />);
    await waitFor(() => expect(screen.getByText(/fallaron 1 de 2/)).toBeTruthy());
    expect(screen.getByText("fallido")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ver log" })).toBeTruthy();
  });

  it("con la unidad desconectada pinta el destino esperado, no «No hay espejos de backup configurados.»", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "E:\\BACKUP",
      root_configured: true,
      root_exists: false,
      overall_status: "missing",
      last_run: OK_RUN,
      last_run_error: null,
      entries: [],
    });
    render(<BackupCard />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/No se encuentra el destino/));
    expect(screen.getByText("Esperado: D:\\BACKUP")).toBeTruthy();
    expect(screen.queryByText("No hay espejos de backup configurados.")).toBeNull();
  });

  it("sin destino configurado lo dice en rojo con el motivo del aborto", async () => {
    vi.mocked(invoke).mockResolvedValue({
      root: "",
      root_configured: false,
      root_exists: false,
      overall_status: "unconfigured",
      last_run: ABORTED_RUN,
      last_run_error: null,
      entries: [],
    });
    render(<BackupCard />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/No hay destino de backup configurado/),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/abortado/);
    expect(screen.queryByText(/^Esperado:/)).toBeNull();
    expect(screen.queryByText("No hay espejos de backup configurados.")).toBeNull();
  });
});
