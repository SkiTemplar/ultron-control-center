// Library → Routing — inspector del routing REAL.
//
// Hasta 2026-08-15 esta pestaña llamaba a `catalog_search`: similitud coseno
// cruda contra la colección `ultron_catalog`. Eso NO es el routing — es una de
// sus entradas. De ahí la discrepancia que reportó el usuario: para "corregir
// este código, el coche va muy lento" la pestaña ofrecía ultron-refactor/docs/
// test/changelog mientras el hook (que sí pasa por el orquestador) resolvía
// performance-engineer / debugger / ultron-perf. La pestaña prometía routing y
// enseñaba búsqueda.
//
// Ahora invoca `orchestrate_prompt`, el MISMO motor que ejecuta el hook
// (intent -> workflow -> agentes -> skills -> directiva de delegación), con
// recall semántico denso activado. Lo que se ve aquí es lo que va a pasar.
//
// Se conserva el reindexado manual del catálogo: sigue siendo la herramienta
// para cuando un skill/agente nuevo no aparece porque el warm-up falló.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, Loader, Bot, Sparkle } from "./icons";

type AgentChoice = { name: string; description: string; score: number };
type SkillChoice = { name: string; description: string; kind: string; score: number };
type WorkflowChoice = { id: string; label: string; description: string; steps: string[] };
type DelegationDirective = {
  agent: string;
  objective: string;
  return_format: string;
  model_hint: string | null;
  reason: string;
} | null;
type ToneChoice = {
  id: string;
  name: string;
  matched_signals: string[];
  reason: string;
  explicit: boolean;
} | null;

type OrchestrationContext = {
  prompt: string;
  route: string;
  project_id: string | null;
  workflow: WorkflowChoice | null;
  delegate_agents: AgentChoice[];
  delegate_skills: SkillChoice[];
  constraints: string[];
  warnings: string[];
  cross_project: boolean;
  delegation_directive: DelegationDirective;
  tone: ToneChoice;
};

type ReindexResult = {
  indexed_agents?: number;
  indexed_skills?: number;
  errors?: number;
  skill_error?: string | null;
  collection?: string;
};

type EntityFilter = "any" | "agent" | "skill";

const FILTERS: { id: EntityFilter; label: string }[] = [
  { id: "any", label: "All" },
  { id: "agent", label: "Agents" },
  { id: "skill", label: "Skills" },
];

function scoreColor(score: number): string {
  if (score >= 0.85) return "var(--color-success)";
  if (score >= 0.8) return "var(--color-warn)";
  return "var(--color-text-tertiary)";
}

export function RoutingCatalog() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EntityFilter>("any");
  const [plan, setPlan] = useState<OrchestrationContext | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState<"full" | "skills" | null>(null);
  const [reindexResult, setReindexResult] = useState<string | null>(null);
  const [reindexOk, setReindexOk] = useState(true);

  async function runRouting() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      const res = (await invoke("orchestrate_prompt", {
        prompt: q,
        projectId: null,
      })) as OrchestrationContext;
      setPlan(res);
    } catch (e) {
      setError(String(e));
      setPlan(null);
    } finally {
      setSearching(false);
    }
  }

  async function runReindex(mode: "full" | "skills") {
    if (reindexing) return;
    setReindexing(mode);
    setError(null);
    setReindexResult(null);
    setReindexOk(true);
    try {
      const cmd = mode === "full" ? "catalog_reindex" : "catalog_reindex_skills";
      const r = (await invoke(cmd)) as ReindexResult;
      const parts: string[] = [];
      if (typeof r.indexed_agents === "number") {
        parts.push(`${r.indexed_agents} agents`);
      }
      if (typeof r.indexed_skills === "number") {
        parts.push(`${r.indexed_skills} skills`);
      }
      if (typeof r.errors === "number" && r.errors > 0) parts.push(`${r.errors} errores`);
      if (r.collection) parts.push(r.collection);
      if (r.skill_error) parts.push(`skill error: ${r.skill_error}`);
      // Un reindex que no indexa nada, o que indexa con errores, NO es un
      // "hecho" verde: con Qdrant caído el backend devuelve 0/0 y la caja verde
      // decía que todo fue bien.
      const indexados = (r.indexed_agents ?? 0) + (r.indexed_skills ?? 0);
      const fallido = indexados === 0 || (r.errors ?? 0) > 0 || Boolean(r.skill_error);
      setReindexOk(!fallido);
      setReindexResult(
        fallido
          ? `Reindex sin efecto util: ${parts.join(" · ") || "0 indexados"} — revisa que Qdrant responda.`
          : `Reindexado: ${parts.join(" · ")}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setReindexing(null);
    }
  }

  const agents = plan && filter !== "skill" ? plan.delegate_agents : [];
  const skills = plan && filter !== "agent" ? plan.delegate_skills : [];
  const vacio = plan !== null && agents.length === 0 && skills.length === 0 && !plan.workflow;

  return (
    <div className="h-full overflow-auto px-6 py-4">
      {/* Reindex row */}
      <div
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded p-3"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div>
          <div className="text-[12.5px] font-medium">Routing catalog index</div>
          <p
            className="mt-0.5 text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Qdrant <span style={{ fontFamily: "var(--font-mono, monospace)" }}>ultron_catalog</span>{" "}
            (E5) · el warm-up automático corre al arrancar; usa Reindex si un
            skill/agente nuevo no aparece en el routing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void runReindex("skills")}
            disabled={reindexing !== null}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {reindexing === "skills" ? "Reindexing…" : "Reindex skills"}
          </button>
          <button
            type="button"
            onClick={() => void runReindex("full")}
            disabled={reindexing !== null}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {reindexing === "full" ? "Reindexing…" : "Reindex all"}
          </button>
        </div>
      </div>

      {reindexResult && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={
            reindexOk
              ? {
                  background: "rgba(63, 185, 80, 0.06)",
                  border: "1px solid rgba(63, 185, 80, 0.22)",
                  color: "var(--color-success)",
                }
              : {
                  background: "rgba(210, 153, 34, 0.06)",
                  border: "1px solid rgba(210, 153, 34, 0.24)",
                  color: "var(--color-warn)",
                }
          }
        >
          {reindexResult}
        </div>
      )}

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Prompt row */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runRouting();
        }}
        className="mb-3 flex items-center gap-2"
      >
        <div
          className="flex flex-1 items-center gap-2 rounded px-3 py-2"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          <Search size={14} className="shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="¿Cómo rutearía el sistema este prompt? (p.ej. «corrige este código, el coche va muy lento»)"
            className="w-full bg-transparent text-[12.5px] outline-none"
            style={{ color: "var(--color-text)" }}
          />
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className="rounded px-2.5 py-1.5 text-[11.5px] transition-colors"
              style={{
                background: filter === f.id ? "var(--color-surface-3)" : "transparent",
                color: filter === f.id ? "var(--color-text)" : "var(--color-text-secondary)",
                border: `1px solid ${
                  filter === f.id ? "var(--color-border-strong)" : "var(--color-border)"
                }`,
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="submit"
          disabled={searching || !query.trim()}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {searching ? <Loader size={13} /> : "Route"}
        </button>
      </form>

      {/* Veredicto del orquestador */}
      {plan && (
        <div
          className="mb-3 flex flex-wrap items-center gap-2 rounded p-3 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <span style={{ color: "var(--color-text-tertiary)" }}>intent</span>
          <span
            className="rounded px-2 py-0.5 font-medium"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text)" }}
          >
            {plan.route || "—"}
          </span>
          {plan.tone?.id && (
            <>
              <span style={{ color: "var(--color-text-tertiary)" }}>tono</span>
              <span
                className="rounded px-2 py-0.5"
                style={{ background: "var(--color-surface-3)", color: "var(--color-text)" }}
              >
                {plan.tone.name || plan.tone.id}
              </span>
            </>
          )}
          {plan.cross_project && (
            <span style={{ color: "var(--color-warn)" }}>cross-project</span>
          )}
          {plan.delegation_directive ? (
            <span style={{ color: "var(--color-success)" }}>
              delega en {plan.delegation_directive.agent || "un especialista"}
            </span>
          ) : (
            <span style={{ color: "var(--color-text-tertiary)" }}>sin delegación</span>
          )}
        </div>
      )}

      {plan?.warnings?.length ? (
        <div
          className="mb-3 rounded p-3 text-[11.5px]"
          style={{
            background: "rgba(210, 153, 34, 0.05)",
            border: "1px solid rgba(210, 153, 34, 0.18)",
            color: "var(--color-warn)",
          }}
        >
          {plan.warnings.join(" · ")}
        </div>
      ) : null}

      {/* Workflow propuesto */}
      {plan?.workflow && filter === "any" && (
        <div
          className="mb-3 rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-medium">{plan.workflow.label}</span>
            <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-faint)" }}>
              workflow
            </span>
          </div>
          {plan.workflow.steps.length > 0 && (
            <p className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
              {plan.workflow.steps.join(" → ")}
            </p>
          )}
        </div>
      )}

      {vacio && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(210, 153, 34, 0.05)",
            border: "1px solid rgba(210, 153, 34, 0.18)",
            color: "var(--color-warn)",
          }}
        >
          El orquestador no propone especialistas para este prompt. Puede ser
          abstención deliberada (prompts cortos o triviales no delegan) o que el
          catálogo esté vacío — prueba Reindex all y repite.
        </div>
      )}

      {(agents.length > 0 || skills.length > 0) && (
        <div className="space-y-1.5">
          {agents.map((a, i) => (
            <div
              key={`agent-${a.name}-${i}`}
              className="flex items-start gap-3 rounded p-3"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span className="mt-0.5 shrink-0" style={{ color: "var(--color-text-tertiary)" }} title="agent">
                <Bot size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium">{a.name}</span>
                  <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-faint)" }}>
                    agent
                  </span>
                </div>
                {a.description && (
                  <p
                    className="mt-0.5 truncate text-[11.5px]"
                    style={{ color: "var(--color-text-secondary)" }}
                    title={a.description}
                  >
                    {a.description}
                  </p>
                )}
              </div>
              <span
                className="shrink-0 text-[12px] font-semibold tabular-nums"
                style={{ color: scoreColor(a.score) }}
                title="Score del orquestador"
              >
                {a.score.toFixed(3)}
              </span>
            </div>
          ))}
          {skills.map((s, i) => (
            <div
              key={`skill-${s.name}-${i}`}
              className="flex items-start gap-3 rounded p-3"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span className="mt-0.5 shrink-0" style={{ color: "var(--color-text-tertiary)" }} title="skill">
                <Sparkle size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium">{s.name}</span>
                  <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-faint)" }}>
                    skill{s.kind ? ` · ${s.kind}` : ""}
                  </span>
                </div>
                {s.description && (
                  <p
                    className="mt-0.5 truncate text-[11.5px]"
                    style={{ color: "var(--color-text-secondary)" }}
                    title={s.description}
                  >
                    {s.description}
                  </p>
                )}
              </div>
              <span
                className="shrink-0 text-[12px] font-semibold tabular-nums"
                style={{ color: scoreColor(s.score) }}
                title="Score del orquestador"
              >
                {s.score.toFixed(3)}
              </span>
            </div>
          ))}
        </div>
      )}

      {plan === null && !error && (
        <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Escribe un prompt y pulsa Route para ver la decisión REAL del
          orquestador — intent, workflow, agentes y skills con sus scores. Es el
          mismo motor que corre en cada prompt del chat, no una búsqueda del
          índice.
        </p>
      )}
    </div>
  );
}
