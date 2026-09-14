// Vista final del asistente: resultado del `create` (exito con pasos +
// atajos, o error con el detalle de los pasos que se llegaron a ejecutar).

import { invoke } from "@tauri-apps/api/core";
import { ErrorBox } from "./ErrorBox";
import type { CreateResult } from "./types";

export interface ResultViewProps {
  result: CreateResult;
  onClose: () => void;
  onRetry: () => void;
}

export function ResultView({ result, onClose, onRetry }: ResultViewProps) {
  async function openIdeManual() {
    if (!result.ok) return;
    try {
      await invoke("open_project_in_ide", { path: result.data.projectPath, preferredIde: null });
    } catch {
      /* el usuario ya ve el error si algo falla via lastAction global */
    }
  }
  async function openClaudeSession() {
    if (!result.ok) return;
    try {
      await invoke("spawn_session", {
        provider: "claude",
        cwd: result.data.projectPath,
        prompt: null,
        flags: { dangerouslySkipPermissions: false },
      });
    } catch {
      /* idem */
    }
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-4">
      {result.ok ? (
        <>
          <p className="text-[12.5px] font-medium" style={{ color: "var(--color-success)" }}>Proyecto creado.</p>
          <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}>
            {result.data.projectPath}
          </p>
          <ul className="space-y-1">
            {result.data.steps.map((s, i) => (
              <li key={`${s.step}-${i}`} className="flex items-center gap-2 text-[11.5px]">
                <span style={{ color: s.ok ? "var(--color-success)" : "var(--color-danger)" }}>{s.ok ? "✓" : "✗"}</span>
                <span style={{ color: "var(--color-text-secondary)" }}>{s.step}: {s.message}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 pt-2">
            <button type="button" onClick={() => void openIdeManual()} className="rounded px-3 py-1.5 text-[12px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}>
              Abrir en IDE
            </button>
            <button type="button" onClick={() => void openClaudeSession()} className="rounded px-3 py-1.5 text-[12px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}>
              Abrir sesión de Claude
            </button>
            <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-[12px] font-medium" style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
              Cerrar
            </button>
          </div>
        </>
      ) : (
        <>
          <ErrorBox message={`${result.error.code}: ${result.error.message}`} />
          {result.steps && result.steps.length > 0 && (
            <ul className="space-y-1">
              {result.steps.map((s, i) => (
                <li key={`${s.step}-${i}`} className="flex items-center gap-2 text-[11.5px]">
                  <span style={{ color: s.ok ? "var(--color-success)" : "var(--color-danger)" }}>{s.ok ? "✓" : "✗"}</span>
                  <span style={{ color: "var(--color-text-secondary)" }}>{s.step}: {s.message}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onRetry} className="rounded px-3 py-1.5 text-[12px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}>
              Volver a intentar
            </button>
            <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-[12px]" style={{ background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border-strong)" }}>
              Cerrar
            </button>
          </div>
        </>
      )}
    </div>
  );
}
