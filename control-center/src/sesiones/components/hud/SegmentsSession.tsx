// Segmentos del HUD que actúan sobre la sesión: modelo, effort, contexto,
// uso del plan, socrático y modo de permisos.

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { addNote, loadSettings, reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { ENGINE_LABEL } from "../../engines";
import { formatTokens } from "../../parse";
import { useStore } from "../../store";
import type { Effort, OpResult, PermissionMode, PlanUsage, PlanWindowUsage, SessionId, SessionInfo, SocraticMode, StatusPayload, UsoWindow } from "../../types";
import { insertInComposer, openInspector, requestSessionSettings } from "../../ui";
import { recoverNote } from "../composer/recover-note";
import { Dropdown, type DropdownOption } from "../Dropdown";
import { limitLine, pct, tone } from "../inspector/uso-format";
import { sourceNote, usePace, usePaceError, type PlanPace } from "../inspector/uso-state";
import { prettyModel } from "../TopBar";
import {
  EFFORT_OPTIONS, MODEL_OPTIONS, PERMISSION_OPTIONS, SOCRATIC_OPTIONS, isOutOfCycle, isRiskyPermission, pctTone, permissionLabel,
} from "./hud-data";

/** Porcentaje compacto con espacio fino (U+202F) para el HUD. */
function pctText(v: number): string {
  return `${Math.round(v)} %`;
}

/** `opt`: clase que la línea de estado oculta por prioridad cuando no cabe (hud.css). */
export function SegLabel({ k, v, tone, opt }: { k: string; v: ReactNode; tone?: string; opt?: string }) {
  const extra = opt ? ` ${opt}` : "";
  return (
    <>
      {k && <span className={`hk${extra}`}>{k}</span>}
      <span className={`hv${tone ? ` ${tone}` : ""}${extra}`}>{v}</span>
    </>
  );
}

export function Meter({ pct, tone, label }: { pct: number; tone: string; label: string }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <span className="hbar" role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <i className={tone} style={{ width: `${v}%` }} />
    </span>
  );
}

/**
 * Ejecuta un atajo del HUD (el mismo comando que en el chat), deja su resultado
 * en el chat como nota y recarga los ajustes. `pending`: el resultado llega por
 * `sesiones://op-result`.
 */
function useApply(id: SessionId) {
  const api = useApi();
  return async (fn: () => Promise<OpResult | void>) => {
    try {
      const out = await fn();
      if (out && !out.ok && !out.pending) reportError(out.error ?? out.text ?? "La CLI no aplicó el cambio.");
      else if (out?.pending) addNote(id, "info", "Aplicando el cambio: el resultado aparecerá aquí.");
      else if (out?.text) addNote(id, "info", out.text);
    } catch (e) {
      reportError(e);
    } finally {
      void loadSettings(api, id);
    }
  };
}

export function ModelSeg({ id, model }: { id: SessionId; model: string | null }) {
  const api = useApi();
  const apply = useApply(id);
  const base = model?.replace(/\[1m\]$/, "") ?? null;
  const value = MODEL_OPTIONS.find((o) => o.value === model)?.value ?? base;
  return (
    <Dropdown label="Modelo" value={value} options={MODEL_OPTIONS} placement="up" width={300} triggerClass="hseg model" testId="hud-model"
      triggerTitle="Modelo de la sesión: escribe /model en el PTY"
      onSelect={(m) => void apply(() => api.setModel({ id, model: m }))}
      trigger={<SegLabel k="" v={prettyModel(model)} />} />
  );
}

export function EffortSeg({ id, effort }: { id: SessionId; effort: Effort | null }) {
  const api = useApi();
  const apply = useApply(id);
  return (
    <Dropdown label="Effort" value={effort} options={EFFORT_OPTIONS} placement="up" width={300} triggerClass="hseg hud-opt-3" testId="hud-effort"
      triggerTitle="Esfuerzo de razonamiento"
      // El cambio va por `/effort`, que Claude Code guarda también como predeterminado de sus ajustes.
      header={<p className="dd-note warn-text" data-testid="hud-effort-global">Cambiarlo aquí usa /effort: Claude Code lo guarda también como predeterminado y lo heredan las sesiones nuevas que no fijen otro.</p>}
      onSelect={(e) => void apply(() => api.setEffort({ id, effort: e }))}
      trigger={<SegLabel k="effort" v={effort ?? "—"} />} />
  );
}

export function ContextSeg({ id, status }: { id: SessionId; status: StatusPayload | null }) {
  const pct = status && status.contextWindow > 0 ? (status.contextTokens / status.contextWindow) * 100 : null;
  const tone = pct === null ? "" : pctTone(pct);
  const header = !status ? (
    <p className="dd-note">Sin datos de contexto.</p>
  ) : (
    <div className="dd-detail">
      <div className="dd-big num">{formatTokens(status.contextTokens)} <small>de {formatTokens(status.contextWindow)} · {Math.round(pct ?? 0)} %</small></div>
      <Meter pct={pct ?? 0} tone={tone} label="Contexto usado" />
      <p className="dd-note">Quedan {formatTokens(status.contextWindow - status.contextTokens)} tokens.</p>
      <div className="dd-acts">
        <button className="btn sm" onClick={() => insertInComposer(id, "/compact ")}>Escribir /compact</button>
        <button className="btn sm" onClick={() => insertInComposer(id, "/relevo ")}>Escribir /relevo</button>
        <button className="btn sm ghost" onClick={() => openInspector("contexto")}>Ver reparto</button>
      </div>
    </div>
  );
  return (
    <Dropdown label="Contexto" placement="up" width={320} triggerClass="hseg" testId="hud-context" triggerTitle="Contexto usado de la ventana"
      header={header}
      trigger={<><SegLabel k="ctx" v={pct === null ? "—" : pctText(pct)} tone={tone} />{pct !== null && <Meter pct={pct} tone={tone} label="Contexto" />}</>} />
  );
}

/**
 * Ventana del HUD: la del ritmo del puente (misma cifra y tono que la pestaña
 * Uso, uso-format.ts) o, si el puente no ha respondido, solo el porcentaje.
 */
function UsageRow({ label, w, fallback }: { label: string; w: UsoWindow | null; fallback: PlanWindowUsage | null }) {
  if (!w && !fallback) return <p className="dd-note">{label}: sin dato.</p>;
  const used = w ? w.used : fallback?.percent ?? 0;
  const t = w ? tone(w) : "";
  return (
    <>
      <div className="dd-row">
        <span>{label}</span>
        <span className="num">{pct(used)}</span>
        <Meter pct={used} tone={t} label={label} />
      </div>
      {w && <p className="dd-note num">{limitLine(w)}</p>}
    </>
  );
}

const windowOf = (windows: readonly UsoWindow[], kind: string): UsoWindow | null => windows.find((w) => w.kind.startsWith(kind)) ?? null;

/**
 * Ritmo que puede pintar el HUD. `refreshPace` conserva el último ritmo cuando
 * el puente falla: si falla y hay uso vigente, manda el uso (el ritmo viejo
 * taparía las cifras nuevas durante horas).
 */
export function hudPace(pace: PlanPace | null, paceError: string | null, usage: PlanUsage | null): PlanPace | null {
  return paceError && usage ? null : pace;
}

export function UsageSeg() {
  const usage = useStore((s) => s.usage);
  const paceError = usePaceError();
  const pace = hudPace(usePace(), paceError, usage);
  const fiveW = windowOf(pace?.windows ?? [], "five_hour");
  const weekW = windowOf(pace?.windows ?? [], "seven_day");
  const fiveUsed = fiveW?.used ?? usage?.fiveHour?.percent ?? null;
  const weekUsed = weekW?.used ?? usage?.weekly?.percent ?? null;
  const rate = weekW?.projectedPct ?? null;
  const note = sourceNote(pace, Date.now());
  const header = (
    <div className="dd-detail">
      <UsageRow label="Ventana de 5 h" w={fiveW} fallback={usage?.fiveHour ?? null} />
      <UsageRow label="Semana" w={weekW} fallback={usage?.weekly ?? null} />
      {paceError && <p className="dd-note warn-text" data-testid="hud-pace-error">No se pudo leer el ritmo: {paceError}</p>}
      {note ? <p className={`dd-note${note.isError ? " warn-text" : ""}`}>{note.text}</p> : usage?.stale && <p className="dd-note">Datos en caché.</p>}
      <div className="dd-acts"><button className="btn sm ghost" onClick={() => openInspector("uso")}>Abrir Uso</button></div>
    </div>
  );
  return (
    <Dropdown label="Uso del plan" placement="up" width={300} triggerClass="hseg" testId="hud-usage" triggerTitle="Cuota del plan: 5 h, semana y ritmo" header={header}
      trigger={<>
        <SegLabel k="5h" v={fiveUsed === null ? "—" : pctText(fiveUsed)} tone={fiveW ? tone(fiveW) : ""} />
        <SegLabel k="sem" v={weekUsed === null ? "—" : pctText(weekUsed)} tone={weekW ? tone(weekW) : ""} opt="hud-opt-2" />
        <SegLabel k="ritmo" v={rate === null ? "—" : pct(rate)} tone={weekW ? tone(weekW) : ""} opt="hud-opt-1" />
      </>} />
  );
}

export function SocraticSeg({ id, projectId, mode }: { id: SessionId; projectId: string | null; mode: SocraticMode | null }) {
  const api = useApi();
  const apply = useApply(id);
  const options: DropdownOption<SocraticMode>[] = SOCRATIC_OPTIONS.map((o) => ({
    ...o, disabled: !projectId, disabledReason: projectId ? undefined : "La sesión no pertenece a un proyecto registrado",
  }));
  return (
    <Dropdown label="Protocolo socrático" value={mode} options={options} placement="up" width={340} triggerClass="hseg hud-opt-1" testId="hud-socratic"
      triggerTitle="Modo socrático del proyecto (projects.json)"
      onSelect={(m) => projectId && void apply(() => api.setSocratic({ projectId, mode: m }))}
      trigger={<SegLabel k="socr" v={mode ?? "—"} />} />
  );
}

/**
 * Modo de permisos real (AC-21): bypass en color de aviso. Elegir un modo lo
 * cambia en caliente; si no está en el ciclo de Shift+Tab, se ofrece reiniciar la
 * sesión en ese modo con un aviso pegado al segmento (dentro del desplegable no se
 * veía: se cierra al elegir). «Ajustes de la sesión» abre Ajustes → Sesión actual.
 */
/**
 * Posición fija encima del segmento: el HUD recorta su contenido (`overflow: hidden`
 * y contención de layout), así que el aviso va en un portal al `body`.
 */
function useAnchorAbove(open: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const r = el.getBoundingClientRect();
    setStyle({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 6 });
  }, [open]);
  return { ref, style };
}

export function PermSeg({ info, mode }: { info: SessionInfo; mode: string | null }) {
  const api = useApi();
  const risky = isRiskyPermission(mode);
  const [restartIn, setRestartIn] = useState<PermissionMode | null>(null);
  const anchor = useAnchorAbove(restartIn !== null);
  const id = info.id;
  const engine = info.engine ?? null;

  async function choose(m: PermissionMode) {
    setRestartIn(null);
    try {
      const out = await api.setPermissionMode({ id, mode: m });
      if (out.ok || out.pending) return;
      // Una sesión de motor no tiene ciclo de Shift+Tab ni reinicio: el motivo va tal cual.
      if (engine) return reportError(out.error ?? out.text ?? "No se pudo cambiar el modo.");
      if (isOutOfCycle(out.error ?? out.text)) setRestartIn(m);
      else reportError(out.error ?? out.text ?? "No se pudo cambiar el modo.");
    } catch (e) {
      if (isOutOfCycle(String(e instanceof Error ? e.message : e))) setRestartIn(m);
      else reportError(e);
    }
  }

  /** Reinicia en `m`; un fallo o una conversación nueva (sin transcript) no quedan en silencio. */
  async function restartWith(m: PermissionMode) {
    try {
      const out = await api.recover({ id, action: "restart", opts: { permissionMode: m } });
      const note = recoverNote(out);
      if (note?.level === "error") reportError(note.text);
      else if (note) addNote(id, note.level, note.text);
    } catch (e) {
      reportError(e);
    }
  }

  const header = (
    <div className="dd-detail">
      <p className="dd-note">Modo actual: <b className={risky ? "err-text" : undefined}>{permissionLabel(mode)}</b>.{risky ? " La sesión va sin confirmación de permisos." : ""} Lanzada en {permissionLabel(info.launchPermissionMode)}.{engine ? ` Se traduce a la política de ${ENGINE_LABEL[engine]}.` : ""}</p>
      <div className="dd-acts">
        {!engine && <button className="btn sm" onClick={() => api.key({ id, key: "shiftTab" }).catch(reportError)}>Rotar modo</button>}
        <button className="btn sm ghost" onClick={() => requestSessionSettings(id)}>Ajustes de la sesión</button>
      </div>
    </div>
  );
  return (
    <span className="perm-wrap" ref={anchor.ref}>
      <Dropdown label="Modo de permisos" value={mode} options={PERMISSION_OPTIONS} placement="up" align="end" width={320}
        triggerClass={`hseg perm${risky ? " perm-bypass" : ""}`} testId="hud-perm" triggerTitle="Modo de permisos real de la sesión" header={header}
        onSelect={(m) => void choose(m as PermissionMode)}
        trigger={<SegLabel k="perm" v={permissionLabel(mode)} tone={risky ? "err" : mode === "plan" ? "info" : ""} />} />
      {restartIn && createPortal(
        <span className="perm-restart" role="alert" data-testid="hud-perm-restart" style={anchor.style}>
          «{permissionLabel(restartIn)}» no está en el ciclo de Shift+Tab de esta sesión.
          <button className="btn sm" onClick={() => {
            setRestartIn(null);
            void restartWith(restartIn);
          }}>Reiniciar en {permissionLabel(restartIn)}</button>
          <button className="btn sm ghost" aria-label="Cerrar aviso" onClick={() => setRestartIn(null)}>×</button>
        </span>,
        document.body,
      )}
    </span>
  );
}
