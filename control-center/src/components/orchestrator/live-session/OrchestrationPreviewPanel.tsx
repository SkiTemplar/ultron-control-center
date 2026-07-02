// ULTRON Control Center — sección "Previsualizar orquestacion" del panel
// LiveSessionMonitor (F2.1 — la insignia): qué haría el orquestador con un
// prompt dado, SIN ejecutar nada. invoke('orchestrate_prompt').

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SectionLabel } from "../../sessions/orchShared";
import type { OrchestrationPreview } from "./types";

export function OrchestrationPreviewPanel() {
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
      <SectionLabel>Previsualizar orquestacion</SectionLabel>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={previewInput}
          onChange={(e) => setPreviewInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runPreview();
          }}
          placeholder="Escribe un prompt y ve que haria el orquestador…"
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
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="rounded px-2 py-0.5 text-[10px] font-semibold"
              style={{
                background: "rgba(88,166,255,0.10)",
                color: "var(--color-accent)",
                border: "1px solid rgba(88,166,255,0.28)",
              }}
              title="Intent detectado"
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
              budget {preview.token_budget}t
            </span>
          </div>
          {preview.workflow && preview.workflow.steps.length > 0 && (
            <p className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
              pasos: {preview.workflow.steps.join(" → ")}
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
