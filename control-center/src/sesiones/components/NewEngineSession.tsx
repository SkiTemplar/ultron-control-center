// «+ Codex», «+ Gemini» y «+ OpenCode»: sesión de motor sin Claude en el proyecto actual, en
// otro registrado o retomando una cerrada del mismo motor. Mismo desplegable que
// «+ Claude»; deshabilitado con el motivo si el motor no está disponible.

import { useState } from "react";
import { reportError } from "../bootstrap";
import { useApi } from "../context";
import { openEngineSession, type SessionEngine } from "../engine-session";
import { ENGINE_LABEL, engineBlockReason } from "../engines";
import { formatAgo } from "../parse";
import { usePrefs } from "../prefs";
import { arrangeProjects, shortPath } from "../project-groups";
import { useStore } from "../store";
import type { EngineSessionPast, ProjectRef, SessionId } from "../types";
import { Dropdown, type DropdownOption } from "./Dropdown";

const HERE = "__actual__";
/** Prefijo del valor de las sesiones de motor cerradas para retomar. */
const RESUME = "__resume__:";
/** Se piden más de las que se enseñan: la lista mezcla los tres motores. */
const PAST_FETCH = 30;
const PAST_SHOWN = 6;

/** Motivo del bloqueo de «+ OpenCode» sin modelo elegido. */
export const NO_OPENCODE_MODEL = "elige antes un modelo de OpenCode en Motores (sin él, la CLI no tiene uno que funcione)";

const TRIGGER_CLASS: Record<SessionEngine, string> = { codex: "x", gemini: "g", opencode: "o" };

export function NewEngineSession({ engine, focusedId }: { engine: SessionEngine; focusedId: SessionId | null }) {
  const api = useApi();
  const status = useStore((s) => s.engineStatus);
  const sessions = useStore((s) => s.sessions);
  const model = usePrefs().engineModels[engine];
  const [projects, setProjects] = useState<ProjectRef[] | null>(null);
  const [past, setPast] = useState<EngineSessionPast[]>([]);
  const label = ENGINE_LABEL[engine];
  // OpenCode sin modelo cae al de su config, que aquí no hay (o es uno sin
  // credenciales en el entorno del motor): el primer turno fallaría.
  const reason = engineBlockReason(status, engine) ?? (engine === "opencode" && !model ? NO_OPENCODE_MODEL : null);
  const current = sessions.find((x) => x.id === focusedId) ?? sessions[sessions.length - 1] ?? null;
  const { recent, groups } = arrangeProjects(projects ?? []);
  const options: DropdownOption[] = [
    ...(current ? [{ value: HERE, label: `Aquí · ${current.projectName}`, description: shortPath(current.cwd), group: "Nueva" }] : []),
    ...recent.map((p) => ({ value: p.id, label: p.name, description: shortPath(p.path), hint: p.lastActive ? formatAgo(p.lastActive) : undefined, group: "Recientes" })),
    ...groups.flatMap((g) => g.projects.map((p) => ({ value: p.id, label: p.name, description: shortPath(p.path), group: g.scope }))),
    ...past.map((p) => ({
      value: `${RESUME}${p.id}`,
      label: p.title || "(sin título)",
      description: `${p.projectName} · ${p.turns} ${p.turns === 1 ? "turno" : "turnos"} · ${formatAgo(p.lastActivityAt)}`,
      group: `Retomar sesión de ${label}`,
    })),
  ];

  function onPick(v: string) {
    if (v === HERE && current) return openEngineSession(api, engine, { kind: "here", projectId: current.projectId, cwd: current.cwd });
    const resumed = v.startsWith(RESUME) ? past.find((p) => p.id === v.slice(RESUME.length)) : undefined;
    if (resumed) return openEngineSession(api, engine, { kind: "resume", past: resumed });
    return openEngineSession(api, engine, { kind: "project", projectId: v });
  }

  return (
    <Dropdown
      label={`Sesión nueva de ${label}`}
      triggerClass={TRIGGER_CLASS[engine]}
      triggerTitle={reason ? `${label} no disponible: ${reason}` : `Sesión de ${label} sin Claude: conversa directamente con ${label}`}
      disabled={Boolean(reason)}
      testId={`new-engine-${engine}`}
      width={400}
      options={options}
      searchable="Filtrar proyectos y sesiones…"
      header={
        <>
          <p className="dd-note">
            <span className={`dd-dot ${engine}`} aria-hidden="true" /> Modelo: <b>{model ?? "el predeterminado de la CLI"}</b>
            <span className="faint"> · se cambia en Motores</span>
          </p>
          {projects === null && <p className="dd-note">Cargando proyectos…</p>}
        </>
      }
      onOpen={() => {
        if (projects === null) void api.projects().then(setProjects, (e) => { setProjects([]); reportError(e); });
        void api.engineSessionPast(PAST_FETCH).then((list) => setPast(list.filter((p) => p.engine === engine).slice(0, PAST_SHOWN)), reportError);
      }}
      onSelect={(v) => void onPick(v)}
      trigger={<span>+ {label}</span>}
    />
  );
}
