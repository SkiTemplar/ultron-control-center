// WorkdayDaySummary — 5 secciones de resumen del día en cards horizontales.
//
// Secciones:
//   1. Proyectos    — project_id + project_cwd del workday
//   2. Sesiones     — linked_sessions con resumen truncado (50 chars)
//   3. Logros       — goals con status === "done"
//   4. Actualizaciones — context.notes de kind "commit" | "release" | "milestone"
//                        + fallback a session_start entries como actividad
//   5. Otros        — context.file_changes + context.decisions
//
// NO hace fetch adicional al backend — todo viene del objeto Workday ya cargado.

import type { Workday } from "./types";

interface WorkdayDaySummaryProps {
  wd: Workday;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortenSessionId(sid: string): string {
  // Usa los primeros 8 chars del UUID como identificador visual.
  return sid.slice(0, 8);
}

function truncate(text: string, max = 50): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Extrae el nombre de un proyecto desde su cwd: último segmento del path.
function projectLabel(projectId?: string, cwd?: string): string {
  if (cwd) {
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return projectId ?? "—";
}

// ---------------------------------------------------------------------------
// Card contenedor
// ---------------------------------------------------------------------------

interface SummaryCardProps {
  title: string;
  count: number;
  children: React.ReactNode;
}

function SummaryCard({ title, count, children }: SummaryCardProps) {
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border p-4"
      style={{
        background: "var(--color-surface-1)",
        borderColor: "var(--color-border)",
        minWidth: 0,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="text-[12px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {title}
        </span>
        {count > 0 && (
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-tertiary)",
            }}
          >
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chip reutilizable
// ---------------------------------------------------------------------------

function Chip({ label }: { label: string }) {
  return (
    <span
      className="inline-block rounded px-2 py-0.5 text-[11px]"
      style={{
        background: "var(--color-surface-3)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border)",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export function WorkdayDaySummary({ wd }: WorkdayDaySummaryProps) {
  // --- 1. Proyectos ---
  // Puede ser uno solo (el project_id del workday) o varios si linked_tasks
  // referencian otros proyectos. Por ahora usamos el del propio workday.
  const projects = wd.project_id
    ? [{ id: wd.project_id, cwd: wd.project_cwd }]
    : [];

  // --- 2. Sesiones ---
  // linked_sessions son UUIDs. No tenemos metadata de títulos desde el backend
  // sin un fetch adicional (que está fuera de alcance de esta tarea). Mostramos
  // el UUID corto (8 chars) como identificador visual con hint de "abrir".
  const sessions = wd.linked_sessions;

  // --- 3. Logros ---
  const achievements = wd.goals.filter((g) => g.status === "done");

  // --- 4. Actualizaciones ---
  // Filtramos context.notes por kinds relacionados a actualizaciones.
  // La mayoría actual son "session_start". Incluimos también agent_messages
  // con kind "commit" si existieran en el futuro.
  const updateKinds = new Set(["commit", "release", "milestone", "deploy"]);
  const updates = wd.context.notes.filter((n) => updateKinds.has(n.kind));
  // Si no hay updates específicos, mostramos las session_start como actividad.
  const activityEntries =
    updates.length > 0
      ? updates
      : wd.context.notes.filter((n) => n.kind === "session_start");

  // --- 5. Otros ---
  const fileChanges = wd.context.file_changes;
  const decisions = wd.context.decisions;
  const otherCount = fileChanges.length + decisions.length;

  const emptyStyle = { color: "var(--color-text-tertiary)", fontSize: "12px" };

  return (
    <div
      className="grid gap-3 px-6 pb-4 pt-4"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
      }}
    >
      {/* 1. Proyectos */}
      <SummaryCard title="Proyectos" count={projects.length}>
        {projects.length === 0 ? (
          <span style={emptyStyle}>Sin proyecto asociado.</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {projects.map((p) => (
              <Chip key={p.id} label={projectLabel(p.id, p.cwd)} />
            ))}
          </div>
        )}
      </SummaryCard>

      {/* 2. Sesiones */}
      <SummaryCard title="Sesiones" count={sessions.length}>
        {sessions.length === 0 ? (
          <span style={emptyStyle}>Sin sesiones.</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((sid) => (
              <li
                key={sid}
                className="flex items-center gap-1.5"
                title={sid}
              >
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: "var(--color-accent, #22c55e)" }}
                />
                <span
                  className="font-mono text-[11px]"
                  style={{ color: "var(--color-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {truncate(shortenSessionId(sid), 8)}…
                  <span
                    className="ml-1 text-[10px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {sid.slice(9, 18)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SummaryCard>

      {/* 3. Logros */}
      <SummaryCard title="Logros" count={achievements.length}>
        {achievements.length === 0 ? (
          <span style={emptyStyle}>Sin logros marcados.</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {achievements.map((g) => (
              <li
                key={g.id}
                className="flex items-center gap-1.5 text-[12px]"
                style={{ color: "var(--color-text)" }}
              >
                <span style={{ color: "var(--color-accent, #22c55e)" }}>✓</span>
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={g.text}
                >
                  {truncate(g.text, 44)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SummaryCard>

      {/* 4. Actualizaciones */}
      <SummaryCard title="Actualizaciones" count={activityEntries.length}>
        {activityEntries.length === 0 ? (
          <span style={emptyStyle}>Sin actualizaciones.</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {activityEntries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-1.5 text-[11px]"
                style={{ color: "var(--color-text)" }}
              >
                <span
                  className="mt-0.5 shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  {entry.kind === "session_start" ? "sess" : entry.kind}
                </span>
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={entry.text}
                >
                  {truncate(entry.text, 40)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SummaryCard>

      {/* 5. Otros */}
      <SummaryCard title="Otros" count={otherCount}>
        {otherCount === 0 ? (
          <span style={emptyStyle}>Sin archivos ni decisiones.</span>
        ) : (
          <div className="flex flex-col gap-2">
            {fileChanges.length > 0 && (
              <div>
                <div
                  className="mb-1 text-[10px] font-semibold uppercase"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Archivos ({fileChanges.length})
                </div>
                <ul className="flex flex-col gap-0.5">
                  {fileChanges.map((f) => (
                    <li
                      key={f.id}
                      className="truncate text-[11px]"
                      style={{ color: "var(--color-text)" }}
                      title={f.text}
                    >
                      {truncate(f.text, 40)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {decisions.length > 0 && (
              <div>
                <div
                  className="mb-1 text-[10px] font-semibold uppercase"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Decisiones ({decisions.length})
                </div>
                <ul className="flex flex-col gap-0.5">
                  {decisions.map((d) => (
                    <li
                      key={d.id}
                      className="truncate text-[11px]"
                      style={{ color: "var(--color-text)" }}
                      title={d.text}
                    >
                      {truncate(d.text, 40)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </SummaryCard>
    </div>
  );
}
