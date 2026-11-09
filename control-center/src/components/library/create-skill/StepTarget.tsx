// Step 4 — Target picker (Global / Project) + final confirm summary.

import type { TargetScope } from "../../../types";
import type { SkillTemplateId } from "../creatorTemplates";
import { FieldLabel, HelperText, ScopeRadio, SummaryRow } from "../wizard-ui";

type StepTargetProps = {
  scope: TargetScope;
  setScope: (s: TargetScope) => void;
  projects: { id: string; name: string }[];
  projectId: string | null;
  setProjectId: (v: string | null) => void;
  targetValid: boolean;
  summary: {
    name: string;
    description: string;
    body: string;
    tags: string[];
    model: string;
    toolsSelected: string[];
    templateId: SkillTemplateId;
  };
};

export function StepTarget(props: StepTargetProps) {
  const { scope, setScope, projects, projectId, setProjectId, targetValid, summary } = props;
  return (
    <div className="space-y-4">
      <FieldLabel label="Ámbito de instalación">
        <div className="flex gap-3">
          <ScopeRadio
            label="Global"
            sub="~/.claude/skills/"
            active={scope === "global"}
            onClick={() => setScope("global")}
          />
          <ScopeRadio
            label="Proyecto"
            sub="<proyecto>/.claude/skills/"
            active={scope === "project"}
            onClick={() => setScope("project")}
          />
        </div>
      </FieldLabel>

      {scope === "project" && (
        <FieldLabel label="Proyecto">
          <select
            className="w-full rounded border bg-[var(--color-surface-2)] px-2 py-1 text-sm"
            style={{
              borderColor: !projectId
                ? "var(--color-error)"
                : "var(--color-border)",
            }}
            value={projectId ?? ""}
            onChange={(e) => setProjectId(e.target.value || null)}
          >
            <option value="">(elige proyecto)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!projectId && (
            <HelperText error>El ámbito de proyecto necesita un proyecto.</HelperText>
          )}
        </FieldLabel>
      )}

      <div
        className="rounded border p-3 text-xs"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
        }}
      >
        <div className="mb-2 font-semibold">Resumen</div>
        <SummaryRow k="Plantilla" v={summary.templateId} />
        <SummaryRow k="Nombre" v={summary.name || "(falta)"} />
        <SummaryRow k="Descripción" v={summary.description || "(falta)"} />
        {summary.tags.length > 0 && (
          <SummaryRow k="Tags" v={summary.tags.join(", ")} />
        )}
        {summary.model && <SummaryRow k="Modelo" v={summary.model} />}
        {summary.toolsSelected.length > 0 && (
          <SummaryRow k="Herramientas" v={summary.toolsSelected.join(", ")} />
        )}
        <SummaryRow k="Cuerpo" v={`${summary.body.trim().length} caracteres`} />
      </div>

      {!targetValid && (
        <HelperText error>Elige un destino antes de crear.</HelperText>
      )}
    </div>
  );
}
