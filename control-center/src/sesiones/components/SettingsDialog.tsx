// Ajustes de ULTRON Sessions: tema, interfaz, avisos sin foco, sesiones nuevas (modelo, effort
// y modo de permisos), sesión actual (modo de permisos en caliente o reinicio
// en otro modo), motores externos, detección de colgado y diagnóstico.

import { useEffect, useRef, useState } from "react";
import { addNote, reportError } from "../bootstrap";
import { useApi } from "../context";
import { ENGINE_IDS, ENGINE_LABEL } from "../engines";
import { EFFORTS, NEW_SESSION_MODELS, SCALES, setPrefs, usePrefs } from "../prefs";
import { useSessionInfo } from "../store";
import { THEMES, applyTheme, loadThemeId, saveThemeId, type ThemeId } from "../themes";
import type { Effort, PermissionMode, SessionId, SessionPrefs } from "../types";
import { EngineEffortDropdown } from "./composer/EngineEffortDropdown";
import { EngineModelDropdown } from "./composer/EngineModelDropdown";
import { recoverNote } from "./composer/recover-note";
import { Dropdown, type DropdownOption } from "./Dropdown";
import { prettyModel } from "./TopBar";
import { IconClose } from "./icons";

const DEFAULT = "__defecto__";

export const PERMISSION_MODES: { value: PermissionMode; label: string; short: string; description: string }[] = [
  { value: "default", label: "Preguntar", short: "Preguntar", description: "Pide permiso antes de editar o ejecutar" },
  { value: "acceptEdits", label: "Aceptar ediciones", short: "Ediciones", description: "Edita sin preguntar; pide permiso para ejecutar" },
  { value: "plan", label: "Plan", short: "Plan", description: "Solo lee y planifica" },
  { value: "auto", label: "Auto", short: "Auto", description: "Decide Claude Code según el riesgo" },
  { value: "dontAsk", label: "No preguntar", short: "No preguntar", description: "Rechaza lo que no esté permitido" },
  { value: "bypassPermissions", label: "Sin permisos (bypass)", short: "Bypass", description: "Aviso: ejecuta y edita sin ninguna confirmación" },
];

export function permissionLabel(mode: PermissionMode | null | undefined): string {
  return PERMISSION_MODES.find((m) => m.value === mode)?.label ?? "—";
}

/** ¿El backend rechazó el cambio porque el modo no está en el ciclo de Shift+Tab? */
export function isOutOfCycle(message: string | null | undefined): boolean {
  return /fuera del ciclo/i.test(message ?? "");
}

const modeOptions: DropdownOption<PermissionMode>[] = PERMISSION_MODES.map((m) => ({
  value: m.value,
  label: m.label,
  description: m.description,
  tone: m.value === "bypassPermissions" ? "warn" : undefined,
}));

function ThemeCard({ id, current, onPick }: { id: ThemeId; current: ThemeId; onPick: (id: ThemeId) => void }) {
  const theme = THEMES.find((t) => t.id === id);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !theme) return;
    el.style.setProperty("--sw-bg", theme.tokens.bg);
    el.style.setProperty("--sw-panel", theme.tokens.raised);
    el.style.setProperty("--sw-fg", theme.tokens.fg);
    el.style.setProperty("--sw-accent", theme.tokens.accent);
  }, [theme]);
  if (!theme) return null;
  return (
    <button ref={ref} className="theme-card" aria-pressed={current === id} onClick={() => onPick(id)} title={theme.description}>
      <span className="sw" aria-hidden="true"><i /><i /><i /></span>
      <span className="nm">{theme.label}</span>
    </button>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="set-row">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function ModeDropdown({ label, value, onSelect, testId }: { label: string; value: PermissionMode | null; onSelect: (m: PermissionMode) => void; testId: string }) {
  return (
    <Dropdown label={label} triggerClass={`tbtn${value === "bypassPermissions" ? " warn" : ""}`} value={value} options={modeOptions}
      align="end" width={300} onSelect={onSelect} testId={testId} trigger={<span>{permissionLabel(value)}</span>} />
  );
}

/** Preferencias de lanzamiento del backend (`SessionPrefs`). */
function useSessionPrefs(): [SessionPrefs | null, (patch: Partial<SessionPrefs>) => void] {
  const api = useApi();
  const [prefs, setLocal] = useState<SessionPrefs | null>(null);
  useEffect(() => {
    let alive = true;
    api.prefsGet().then((p) => alive && setLocal(p), reportError);
    return () => {
      alive = false;
    };
  }, [api]);
  const update = (patch: Partial<SessionPrefs>) => {
    if (!prefs) return;
    api.prefsSet({ ...prefs, ...patch }).then(setLocal, reportError);
  };
  return [prefs, update];
}

function NewSessions() {
  const prefs = usePrefs();
  const [launch, setLaunch] = useSessionPrefs();
  const modelOptions = [
    { value: DEFAULT, label: "Por defecto de Claude Code" },
    ...NEW_SESSION_MODELS.map((m) => ({ value: m, label: m.endsWith("[1m]") ? `${prettyModel(m)} · 1M` : prettyModel(m) })),
  ];
  const effortOptions = [{ value: DEFAULT, label: "Por defecto de Claude Code" }, ...EFFORTS.map((e) => ({ value: e, label: e }))];
  const pickModel = (v: string) => {
    const model = v === DEFAULT ? null : v;
    setPrefs({ newModel: model });
    setLaunch({ launchModel: model ?? undefined });
  };
  const pickEffort = (v: string) => {
    const effort = v === DEFAULT ? null : (v as Effort);
    setPrefs({ newEffort: effort });
    setLaunch({ launchEffort: effort ?? undefined });
  };
  return (
    <section>
      <h3>Sesiones nuevas</h3>
      <div className="set-row">
        <span>Modelo</span>
        <Dropdown label="Modelo de las sesiones nuevas" triggerClass="tbtn" value={prefs.newModel ?? DEFAULT} options={modelOptions}
          align="end" width={240} onSelect={pickModel} trigger={<span>{modelOptions.find((o) => o.value === (prefs.newModel ?? DEFAULT))?.label}</span>} />
      </div>
      <div className="set-row">
        <span>Effort</span>
        <Dropdown label="Effort de las sesiones nuevas" triggerClass="tbtn" value={prefs.newEffort ?? DEFAULT} options={effortOptions}
          align="end" width={240} onSelect={pickEffort} trigger={<span>{prefs.newEffort ?? "Por defecto de Claude Code"}</span>} />
      </div>
      <div className="set-row">
        <span>Modo de permisos</span>
        {launch ? (
          <ModeDropdown label="Modo de permisos de las sesiones nuevas" value={launch.launchPermissionMode} testId="launch-permission-mode"
            onSelect={(m) => setLaunch({ launchPermissionMode: m })} />
        ) : <span className="faint">Cargando…</span>}
      </div>
      {launch && (
        <label className="set-row">
          <span>Aviso de colgado sin eventos (s)</span>
          <input type="number" min={60} max={600} step={30} value={launch.stallSeconds} aria-label="Segundos sin eventos antes del aviso de colgado"
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (n >= 60 && n <= 600) setLaunch({ stallSeconds: n });
            }} />
        </label>
      )}
    </section>
  );
}

function AutomaticRelaySetting() {
  const [prefs, setPrefs] = useSessionPrefs();
  if (!prefs) return <div className="set-row"><span>Relevo automatico</span><span className="faint">Cargando…</span></div>;
  return <Toggle label="Relevo automático al llegar al límite" checked={prefs.automaticRelay ?? true}
    onChange={(automaticRelay) => setPrefs({ automaticRelay })} />;
}

/** Modo de permisos de una sesión viva: en caliente o, si no está en el ciclo, reiniciando. */
function CurrentSession({ sessionId }: { sessionId: SessionId | null }) {
  const api = useApi();
  const session = useSessionInfo(sessionId);
  const [restartTo, setRestartTo] = useState<PermissionMode | null>(null);
  const [busy, setBusy] = useState(false);
  if (!session) return null;
  const mode = session.permissionMode ?? session.launchPermissionMode ?? null;

  async function change(next: PermissionMode) {
    if (!session) return;
    setBusy(true);
    setRestartTo(null);
    try {
      const r = await api.setPermissionMode({ id: session.id, mode: next });
      if (!r.ok && isOutOfCycle(r.error ?? r.text)) setRestartTo(next);
      else if (!r.ok) reportError(r.error ?? r.text ?? "No se pudo cambiar el modo de permisos");
    } catch (e) {
      if (isOutOfCycle(String(e))) setRestartTo(next);
      else reportError(e);
    } finally {
      setBusy(false);
    }
  }

  async function restart(next: PermissionMode) {
    if (!session) return;
    setBusy(true);
    try {
      const r = await api.recover({ id: session.id, action: "restart", opts: { permissionMode: next } });
      if (!r.ok) {
        reportError(`No se pudo reiniciar la sesión: ${r.steps.join(" → ")}`);
        return;
      }
      setRestartTo(null);
      const note = recoverNote(r);
      if (note) addNote(session.id, note.level, note.text);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="ajustes-sesion-actual" data-testid="settings-current-session">
      <h3>Sesión actual · {session.title}</h3>
      <div className="set-row">
        <span>Modo de permisos</span>
        <ModeDropdown label="Modo de permisos de la sesión actual" value={mode} testId="current-permission-mode" onSelect={(m) => void change(m)} />
      </div>
      {restartTo && (
        <div className="set-row">
          <span className="err-text">{permissionLabel(restartTo)} no se alcanza con Shift+Tab en esta sesión.</span>
          <button className="btn sm pri" disabled={busy} onClick={() => void restart(restartTo)}>Reiniciar en {permissionLabel(restartTo)}</button>
        </div>
      )}
    </section>
  );
}

function Diagnostics() {
  const api = useApi();
  const openLogs = async () => {
    try {
      await api.revealPath(await api.logDir());
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <section>
      <h3>Diagnóstico</h3>
      <div className="set-row">
        <span>Registros de Sessions</span>
        <button className="tbtn" onClick={() => void openLogs()}>Abrir logs</button>
      </div>
    </section>
  );
}

interface Props {
  onClose: () => void;
  /** Sesión de «Sesión actual» (la enfocada o la que pidió los ajustes). */
  sessionId?: SessionId | null;
  /** Lleva la vista a «Sesión actual» al abrir. */
  focusCurrent?: boolean;
}

export function SettingsDialog({ onClose, sessionId = null, focusCurrent = false }: Props) {
  const prefs = usePrefs();
  const [theme, setTheme] = useState<ThemeId>(loadThemeId);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    if (focusCurrent) document.getElementById("ajustes-sesion-actual")?.scrollIntoView({ block: "start" });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, focusCurrent]);

  const pickTheme = (id: ThemeId) => {
    setTheme(id);
    applyTheme(id);
    saveThemeId(id);
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-label="Ajustes" tabIndex={-1} ref={box}>
        <header>
          <h2>Ajustes</h2>
          <button className="icon-btn" aria-label="Cerrar ajustes" onClick={onClose}><IconClose /></button>
        </header>
        <CurrentSession sessionId={sessionId} />
        <section>
          <h3>Tema</h3>
          <div className="theme-grid">
            {THEMES.map((t) => <ThemeCard key={t.id} id={t.id} current={theme} onPick={pickTheme} />)}
          </div>
        </section>
        <section>
          <h3>Interfaz</h3>
          <div className="set-row">
            <span>Escala</span>
            <div className="seg" role="group" aria-label="Escala de la interfaz">
              {SCALES.map((s) => (
                <button key={s} aria-pressed={prefs.scale === s} onClick={() => setPrefs({ scale: s })}>{s} %</button>
              ))}
            </div>
          </div>
          <Toggle label="Plegar herramientas en el chat" checked={prefs.compactTools} onChange={(v) => setPrefs({ compactTools: v })} />
          <Toggle label="Mostrar el razonamiento" checked={prefs.showThinking} onChange={(v) => setPrefs({ showThinking: v })} />
          <Toggle label="Confirmar antes de terminar una sesión" checked={prefs.confirmKill} onChange={(v) => setPrefs({ confirmKill: v })} />
        </section>
        <section>
          <h3>Avisos sin foco (turno terminado, pregunta o permiso)</h3>
          <Toggle label="Notificación de Windows" checked={prefs.attentionToast} onChange={(v) => setPrefs({ attentionToast: v })} />
          <Toggle label="Parpadeo en la barra de tareas" checked={prefs.attentionFlash} onChange={(v) => setPrefs({ attentionFlash: v })} />
        </section>
        <NewSessions />
        <section>
          <h3>Motores</h3>
          <AutomaticRelaySetting />
          {ENGINE_IDS.map((engine) => (
            <div className="set-row" key={engine}>
              <span>{ENGINE_LABEL[engine]}</span>
              <EngineModelDropdown engine={engine} placement="down" align="end" triggerClass="tbtn" />
            </div>
          ))}
          <div className="set-row">
            <span>Effort de Codex</span>
            <EngineEffortDropdown />
          </div>
        </section>
        <Diagnostics />
      </div>
    </div>
  );
}
