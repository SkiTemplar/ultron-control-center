// ULTRON Control Center — sección "Previsualizar orquestacion" del panel
// LiveSessionMonitor (F2.1 — la insignia): qué haría la orquestación COMPLETA
// (ULTRON_ORCHESTRATE=full) con un prompt dado, SIN ejecutar nada.
// invoke('orchestrate_prompt'). En el modo de producción (ligero) la sesión
// solo recibe el tono; el panel lo etiqueta así y separa las dos cosas.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SectionLabel } from "../../sessions/orchShared";
import type { OrchestrateMode } from "../../sessions/sessionTypes";
import type { OrchestrationPreview } from "./types";

interface OrchestrationPreviewPanelProps {
  /** Modo real del hook en sesión. */
  mode: OrchestrateMode;
  /** `ULTRON_DENSE` de la app: sin él, recall solo FTS5 y delegación por reglas. */
  denseEnabled: boolean;
}

/** Qué entra de verdad en sesión con este prompt, según el modo del hook. */
export function sessionInjectionSummary(mode: OrchestrateMode, preview: OrchestrationPreview): string {
  if (mode === "full") return "En sesión (modo full) se inyecta todo lo de abajo.";
  const tone = preview.tone ? `el tono «${preview.tone.name}»` : "nada (tono por defecto)";
  return `En sesión (modo ligero, el de producción) solo entra ${tone}. Lo de abajo es la orquestación full, apagada.`;
}

/** Etiqueta del modo que simula el Preview. */
export function previewModeLabel(denseEnabled: boolean): string {
  return denseEnabled
    ? "Simula el modo full (ULTRON_ORCHESTRATE=full) con recall híbrido."
    : "Simula el modo full (ULTRON_ORCHESTRATE=full) con el denso apagado (ULTRON_DENSE=0): recall solo FTS5 y delegación por reglas.";
}

export function OrchestrationPreviewPanel({ mode, denseEnabled }: OrchestrationPreviewPanelProps) {
  const [previewInput, setPreviewInput] = useState("");
  const [preview, setPreview] = useState<OrchestrationPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const runPreview = useCallback(async () => {
    const prompt = previewInput.trim();
    if (!prompt || previewBusy) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const ctx = await invoke<OrchestrationPreview>("orchestrate_prompt", {
        prompt,
        projectId: null,
      });
      if (!mountedRef.current) return;
      setPreview(ctx);
    } catch (e) {
      if (!mountedRef.current) return;
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setPreviewBusy(false);
    }
  }, [previewInput, previewBusy]);

  return (
    <div>
      <SectionLabel>Previsualizar orquestación (modo full)</SectionLabel>
      <p className="mb-1.5 text-[10px]" style={{ color: "var(--color-text-faint)" }}>
        {previewModeLabel(denseEnabled)}
      </p>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={previewInput}
          onChange={(e) => setPreviewInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runPreview();
          }}
          placeholder="Escribe un prompt y mira qué haría la orquestación full…"
          className="min-w-0 flex-1 rounded px-2 py-1 text-[11px]"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text)",
          }}
        />
        <button
          type="button"
          onClick={() => void runPreview()}
          disabled={previewBusy || !previewInput.trim()}
          className="shrink-0 rounded px-2 py-1 text-[10px] font-medium disabled:opacity-50"
          style={{
            background: "rgba(88,166,255,0.10)",
            color: "var(--color-accent)",
            border: "1px solid rgba(88,166,255,0.28)",
          }}
        >
          {previewBusy ? "…" : "Previsualizar"}
        </button>
      </div>
      {previewError && (
        <p className="mt-1 text-[10px]" style={{ color: "var(--color-danger, #ef4444)" }}>
          {previewError}
        </p>
      )}
      {preview && (
        <div
          className="mt-2 flex flex-col gap-1.5 rounded px-2 py-2"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
          }}
        >
          <p
            className="text-[10.5px] font-medium"
            style={{ color: mode === "full" ? "var(--color-text-secondary)" : "#ca8a04" }}
          >
            {sessionInjectionSummary(mode, preview)}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="rounded px-2 py-0.5 text-[10px] font-semibold"
              style={{
                background: "rgba(88,166,255,0.10)",
                color: "var(--color-accent)",
                border: "1px solid rgba(88,166,255,0.28)",
              }}
              title="Intención detectada"
            >
              {preview.route}
            </span>
            {preview.workflow && (
              <span
                className="rounded px-2 py-0.5 text-[10px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title={preview.workflow.description}
              >
                wf: {preview.workflow.label}
              </span>
            )}
            <span className="text-[10px] tabular-nums" style={{ color: "var(--color-text-faint)" }}>
              presupuesto {preview.token_budget} t
            </span>
          </div>
          {preview.workflow && preview.workflow.steps.length > 0 && (
            <p className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
              pasos: {preview.workflow.steps.join(" → ")}
            </p>
          )}
          {preview.step_plans && preview.step_plans.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {preview.step_plans.map((sp, i) => (
                <p
                  key={`sp-${i}`}
                  className="truncate text-[10px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                  title={sp.frame}
                >
                  paso {i + 1} · {sp.agent} ({sp.sub_intent}): {sp.frame}
                </p>
              ))}
            </div>
          )}
          {preview.delegation_directive && (
            <p
              className="text-[10.5px]"
              style={{ color: "var(--color-text-secondary)" }}
              title={preview.delegation_directive.objective}
            >
              delegaría en{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {preview.delegation_directive.agent}
              </span>
              {preview.delegation_directive.model_hint
                ? ` (${preview.delegation_directive.model_hint})`
                : ""}
              : {preview.delegation_directive.reason}
            </p>
          )}
          {preview.delegate_agents.length > 0 && (
            <p
              className="text-[10.5px]"
              style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
            >
              agentes:{" "}
              {preview.delegate_agents.map((a) => `${a.name} (${a.score.toFixed(2)})`).join(" · ")}
            </p>
          )}
          {preview.delegate_skills.length > 0 && (
            <p
              className="text-[10.5px]"
              style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
            >
              skills:{" "}
              {preview.delegate_skills
                .map((s) => `${s.name} (${s.kind}, ${s.score.toFixed(2)})`)
                .join(" · ")}
            </p>
          )}
          {preview.memories.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {preview.memories.slice(0, 5).map((m, i) => (
                <div
                  key={`pm-${i}`}
                  className="truncate text-[10px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                  title={m.summary ?? m.title ?? undefined}
                >
                  <span style={{ color: "var(--color-text-faint)" }}>[{m.scope}]</span>{" "}
                  {m.title ?? m.summary ?? ""}
                </div>
              ))}
            </div>
          )}
          {preview.warnings.length > 0 && (
            <p className="text-[10px]" style={{ color: "#ca8a04" }}>
              {preview.warnings.join(" · ")}
            </p>
          )}
          {preview.prompt_plan && (
            <div
              className="mt-1 flex flex-col gap-1 rounded px-2 py-1.5"
              style={{
                background: "var(--color-surface-2)",
                border: "1px dashed var(--color-border-strong)",
              }}
            >
              <div className="flex items-center gap-1.5">
                <SectionLabel>Prompt mejorado</SectionLabel>
                <span
                  className="mb-1.5 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                  style={{
                    background: "rgba(168,85,247,0.12)",
                    color: "#a855f7",
                    border: "1px solid rgba(168,85,247,0.3)",
                  }}
                  title="Modo ULTRON sugerido por el paso de mejora"
                >
                  {preview.prompt_plan.suggested_mode}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-[10.5px]" style={{ color: "var(--color-text-secondary)" }}>
                {preview.prompt_plan.improved_prompt}
              </p>
              {preview.prompt_plan.clarifying_questions.length > 0 && (
                <p className="text-[10px]" style={{ color: "#ca8a04" }}>
                  Aclarar antes: {preview.prompt_plan.clarifying_questions.join(" · ")}
                </p>
              )}
              {preview.prompt_plan.success_criteria.length > 0 && (
                <p className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
                  Éxito: {preview.prompt_plan.success_criteria.join(" · ")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
