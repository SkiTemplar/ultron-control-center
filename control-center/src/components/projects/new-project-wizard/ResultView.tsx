// Vista final del asistente: resultado del `create` (exito con pasos +
// atajos, o error con el detalle de los pasos que se llegaron a ejecutar).

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBox } from "./ErrorBox";
import type { CreateResult } from "./types";

export interface ResultViewProps {
  result: CreateResult;
  onClose: () => void;
  onRetry: () => void;
}

export function ResultView({ result, onClose, onRetry }: ResultViewProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  async function openIdeManual() {
    if (!result.ok) return;
    try {
      await invoke("open_project_in_ide", { path: result.data.projectPath, preferredIde: null });
    } catch (e) {
      setActionError(`No se pudo abrir el IDE: ${String(e)}`);
    }
  }
  async function openClaudeSession() {
    if (!result.ok) return;
    try {
      await invoke("spawn_session", {
        provider: "claude",
        cwd: result.data.projectPath,
        prompt: null,
        // Flujo interno sobre un proyecto propio: sin decisión explícita de
        // permisos manda el defecto de sessions.rs (resolve_dangerous).
        flags: {},
      });
    } catch (e) {
      setActionError(`No se pudo abrir la sesión: ${String(e)}`);
    }
  }

  // Un `skill-pool link` fallido no aborta `create`: se avisa aparte.
  const failedSkills = result.ok ? (result.data.skills ?? []).filter((s) => !s.ok) : [];
  // Sin --skills explícito, una pool ilegible deja `skills` vacío y solo el paso
  // `skills` con ok=false: también se avisa.
  const skillsStepFailed = result.ok && result.data.steps.some((s) => s.step === "skills" && !s.ok);

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-4">
      {result.ok ? (
        <>
          <p className="text-[12.5px] font-medium" style={{ color: "var(--color-success)" }}>Proyecto creado.</p>
          {actionError && <ErrorBox message={actionError} />}
          {failedSkills.length > 0 && (
            <ErrorBox
              message={`No se pudo enlazar: ${failedSkills.map((s) => s.name).join(", ")}. El proyecto se creó igualmente; el detalle está en la lista de pasos.`}
            />
          )}
          {skillsStepFailed && failedSkills.length === 0 && (
            <ErrorBox message="No se pudo leer la pool de skills: el proyecto se creó sin ellas; el detalle está en la lista de pasos." />
          )}
          <p className="min-w-0 break-all text-[11.5px]" style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}>
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
