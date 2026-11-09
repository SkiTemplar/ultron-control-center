// Columna izquierda: crear sesión y sesiones abiertas (con sus subagentes en el inspector).

import { useEffect, useRef, useState } from "react";
import { killRisk } from "../actions";
import { lastUsedProfile, launchWithProfile, profilesStore, resolveProfile, useLaunchProfiles } from "../launch-profiles";
import { LaunchProfileSelect, ProfilesDialog } from "./ProfilesDialog";
import { useApi } from "../context";
import { interventions } from "../engine-session";
import { ENGINE_LABEL } from "../engines";
import { useFocused } from "../hooks/useFocused";
import { formatAgo } from "../parse";
import { arrangeProjects, shortPath } from "../project-groups";
import { backgroundText, displayStatus, hasBackground, NO_BACKGROUND, useBackgroundWork, type BackgroundWork, type DisplayStatus } from "../background";
import { usePrefs } from "../prefs";
import { useStore } from "../store";
import type { EngineId, PastSession, PermissionMode, ProjectRef, SessionId, SessionInfo } from "../types";
import { Dropdown } from "./Dropdown";
import { NewEngineSession } from "./NewEngineSession";
import { PERMISSION_MODES } from "./SettingsDialog";
import { setUi } from "../ui";
import { useUnread } from "../unread";
import { showInFocused, updateWorkspace } from "../workspace";
import { UnreadDot } from "./UnreadDot";
import { IconClose, IconExpand } from "./icons";
import { reportError } from "../bootstrap";
import { useRailReport } from "../rail-rects";

/** Estado de la sesión en castellano para lectores de pantalla (el punto de color no se lee). */
export const STATUS_LABEL: Record<DisplayStatus, string> = {
  starting: "arrancando",
  idle: "libre",
  background: "turno acabado con trabajo en segundo plano",
  working: "trabajando",
  waiting: "espera tu respuesta",
  exited: "terminada",
};

export function sessionMeta(s: SessionInfo, bg: BackgroundWork = NO_BACKGROUND): { text: string; warn: boolean } {
  if (s.status === "waiting") return { text: `${s.projectName} · espera tu respuesta`, warn: true };
  if (s.status === "starting" && s.stalled) return { text: `${s.projectName} · no arranca`, warn: true };
  if (s.status === "starting") return { text: `${s.projectName} · arrancando…`, warn: false };
  if (s.status === "exited") return { text: `${s.projectName} · terminó`, warn: false };
  if (s.status === "working") return { text: `${s.projectName} · ${hasBackground(bg) ? backgroundText(bg) : "trabajando"}`, warn: false };
  if (hasBackground(bg)) return { text: `${s.projectName} · en segundo plano: ${backgroundText(bg)}`, warn: false };
  // Última actividad, no la hora de arranque: dice cuándo respondió por última vez.
  return { text: `${s.projectName} · ${formatAgo(s.lastActivityAt || s.startedAt)}`, warn: false };
}

function LiveRow({ s, active, onPicked }: { s: SessionInfo; active: boolean; onPicked: () => void }) {
  const api = useApi();
  const bg = useBackgroundWork(s.id);
  const meta = sessionMeta(s, bg);
  const dot = displayStatus(s.status, bg);
  const confirmKill = usePrefs().confirmKill;
  // Con un turno en curso, envíos en cola o motores en marcha se confirma siempre, aunque
  // Ajustes lo tenga desactivado: terminar corta el turno, pierde la cola y cancela los motores.
  const risk = useStore((st) => killRisk(s.status, st.bySession[s.id]?.queue, interventions(st.engines).filter((t) => t.sessionId === s.id && t.status === "running").length));
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), risk ? 6000 : 3000);
    return () => window.clearTimeout(t);
  }, [armed, risk]);
  const warning = armed && risk ? `Terminar: ${risk}` : null;
  const unread = useUnread(s.id);
  return (
    <div className="sess-wrap" data-session-id={s.id}>
      <button
        className={`sess${active ? " on" : ""}`}
        aria-current={active || undefined}
        onClick={() => {
          updateWorkspace((ws) => showInFocused(ws, s.id));
          onPicked();
        }}
      >
        <span className={`dot ${dot}`} role="img" aria-label={STATUS_LABEL[dot]} />
        {/* Título y marca de no leído en la misma celda: suelta, la marca ocupaba
            la columna del motor y lo desplazaba a la segunda fila. */}
        <span className="tt">
          <span className="t">{s.title}</span>
          {unread && <UnreadDot />}
        </span>
        {s.engine
          ? <span className={`eng ${ENGINE_BADGE[s.engine].cls}`} title={`Sesión de ${ENGINE_LABEL[s.engine]}`} data-testid="sess-engine">{ENGINE_BADGE[s.engine].text}</span>
          : <span className="eng c" title="Claude Code">CC</span>}
        <span className={`m${meta.warn || warning ? " warn" : ""}`} role={warning ? "status" : undefined}>{warning ?? meta.text}</span>
      </button>
      <button
        className="icon-btn sess-pop"
        title="Abrir en una ventana nueva"
        aria-label={`Abrir ${s.title} en una ventana nueva`}
        onClick={() => void api.newWindow(s.id).catch(reportError)}
      >
        <IconExpand />
      </button>
      <button
        className={`icon-btn sess-kill${armed ? " armed" : ""}`}
        title={armed ? `${risk ? `${risk}. ` : ""}Pulsa otra vez para terminar` : "Terminar la sesión"}
        aria-label={armed ? `Confirmar: terminar ${s.title}` : `Terminar ${s.title}`}
        onClick={() => {
          if ((confirmKill || risk) && !armed) {
            setArmed(true);
            return;
          }
          void api.kill(s.id).catch(reportError);
        }}
        onBlur={() => setArmed(false)}
      >
        <IconClose />
      </button>
    </div>
  );
}

/** Insignia de la fila de una sesión de motor: clase de color y siglas. */
const ENGINE_BADGE: Record<EngineId, { cls: string; text: string }> = {
  codex: { cls: "x", text: "CX" },
  gemini: { cls: "g", text: "GM" },
  opencode: { cls: "o", text: "OC" },
};

const HERE = "__actual__";
/** Prefijo del valor de las conversaciones para retomar en «+ Claude». */
const RESUME = "__resume__:";
const RECENT_PAST = 6;

/**
 * Modo de permisos de la sesión nueva; parte del de Ajustes → Sesiones nuevas.
 * Grupo de botones (sin `<select>` nativo, como el resto de la ventana).
 */
function LaunchModeSelect({ value, failed, onChange }: { value: PermissionMode | null; failed: boolean; onChange: (m: PermissionMode) => void }) {
  return (
    <div className="dd-note new-mode">
      <span>Permisos</span>
      {value === null && failed ? (
        <span className="warn-text" role="status">No se pudo leer el modo: la sesión usará el de Ajustes → Sesiones nuevas.</span>
      ) : value === null ? (
        <span className="faint">Cargando…</span>
      ) : (
        <div className="seg" role="radiogroup" aria-label="Modo de permisos de la sesión nueva" data-testid="new-session-permission-mode">
          {PERMISSION_MODES.map((m) => (
            <button key={m.value} role="radio" aria-checked={value === m.value} aria-pressed={value === m.value} title={m.description}
              className={m.value === "bypassPermissions" ? "warn" : undefined} onClick={() => onChange(m.value)}>
              {m.short}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** «+ Claude»: sesión nueva en el proyecto de la sesión actual o en otro registrado. */
function NewClaude({ focusedId }: { focusedId: SessionId | null }) {
  const api = useApi();
  const sessions = useStore((st) => st.sessions);
  const [projects, setProjects] = useState<ProjectRef[] | null>(null);
  const [past, setPast] = useState<PastSession[]>([]);
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [modeFailed, setModeFailed] = useState(false);
  // Modo pulsado en el desplegable para este lanzamiento; manda sobre el del perfil y el de Ajustes.
  const [modeChoice, setModeChoice] = useState<PermissionMode | null>(null);
  const profilesState = useLaunchProfiles();
  const [profileId, setProfileId] = useState(() => lastUsedProfile().id);
  const [managing, setManaging] = useState(false);
  const profile = resolveProfile(profilesState, profileId);
  const effectiveMode = modeChoice ?? profile.permissionMode ?? mode;
  const current = sessions.find((x) => x.id === focusedId) ?? sessions[sessions.length - 1] ?? null;
  const { recent, groups } = arrangeProjects(projects ?? []);
  const options = [
    ...(current ? [{ value: HERE, label: `Aquí · ${current.projectName}`, hint: "Ctrl+T", group: "Nueva" }] : []),
    ...recent.map((p) => ({
      value: p.id,
      label: p.name,
      description: shortPath(p.path),
      hint: p.lastActive ? formatAgo(p.lastActive) : undefined,
      group: "Recientes",
    })),
    ...groups.flatMap((g) => g.projects.map((p) => ({ value: p.id, label: p.name, description: shortPath(p.path), group: g.scope }))),
    ...past.map((p) => ({
      value: `${RESUME}${p.claudeSessionId}`,
      label: p.preview || "(sin texto)",
      description: `${p.projectName} · ${formatAgo(p.lastActivity)}`,
      group: "Retomar conversación",
    })),
  ];
  const onPick = (v: string) => {
    if (v === HERE) return launchWithProfile(api, { kind: "here", focusedId }, profile, effectiveMode);
    const resumed = v.startsWith(RESUME) ? past.find((p) => p.claudeSessionId === v.slice(RESUME.length)) : undefined;
    if (resumed) return launchWithProfile(api, { kind: "resume", past: resumed }, profile, effectiveMode);
    return launchWithProfile(api, { kind: "project", projectId: v }, profile, effectiveMode);
  };
  return (
    <>
    <Dropdown
      label="Sesión nueva de Claude Code"
      triggerClass="c"
      width={400}
      options={options}
      searchable="Filtrar proyectos y conversaciones…"
      header={
        <>
          <LaunchProfileSelect value={profile} onChange={(id) => { setProfileId(id); setModeChoice(null); }} onManage={() => setManaging(true)} />
          <LaunchModeSelect value={effectiveMode} failed={modeFailed} onChange={setModeChoice} />
          {projects === null && <p className="dd-note">Cargando proyectos…</p>}
        </>
      }
      onOpen={() => {
        if (projects === null) void api.projects().then(setProjects, (e) => { setProjects([]); reportError(e); });
        void api.past(undefined, RECENT_PAST).then(setPast, reportError);
        setModeFailed(false);
        setModeChoice(null);
        setProfileId(profilesStore.getState().lastUsed);
        void api.prefsGet().then((p) => setMode(p.launchPermissionMode), (e: unknown) => {
          // Sin esto el selector se quedaba en «Cargando…» para siempre.
          setModeFailed(true);
          reportError(e);
        });
      }}
      onSelect={(v) => void onPick(v)}
      trigger={<span>+ Claude</span>}
    />
    {managing && <ProfilesDialog onClose={() => setManaging(false)} />}
    </>
  );
}

export function Sidebar({ onPicked }: { onPicked: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const { session: focused } = useFocused();
  const railRef = useRef<HTMLElement>(null);
  useRailReport(railRef, sessions.map((s) => s.id).join("|")); // Pupus señala la fila (rail-rects.ts)

  return (
    <aside className="rail" aria-label="Sesiones" ref={railRef}>
      <div className="new">
        <NewClaude focusedId={focused?.id ?? null} />
        <NewEngineSession engine="codex" focusedId={focused?.id ?? null} />
        <NewEngineSession engine="gemini" focusedId={focused?.id ?? null} />
        <NewEngineSession engine="opencode" focusedId={focused?.id ?? null} />
        <button
          className="x motor"
          title="Intervención de Codex, Gemini u OpenCode dentro de la sesión de Claude (pestaña Motores)"
          onClick={() => setUi((s) => ({ ...s, inspectorTab: "motores", engineFocusTick: s.engineFocusTick + 1 }))}
        >
          + Motor
        </button>
      </div>
      <div className="group">
        <h3>Abiertas <span className="num">{sessions.length || ""}</span></h3>
        {sessions.length === 0 && <p className="rail-empty">Sin sesiones abiertas.</p>}
        {sessions.map((s) => (
          <LiveRow key={s.id} s={s} active={s.id === focused?.id} onPicked={onPicked} />
        ))}
      </div>
    </aside>
  );
}
