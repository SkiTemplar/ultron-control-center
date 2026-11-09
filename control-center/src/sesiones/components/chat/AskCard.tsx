// Tarjetas de permiso, pregunta y plan (§4.3), respondidas con `sesiones_answer`.
// Todas tienen salida que no es contestar: Rechazar (pregunta), Denegar (permiso)
// y Seguir planificando (plan). Interrumpir no va aquí: su único sitio es el
// composer (con Esc). Una pregunta ya resuelta (`ask_gone`) se quita con un aviso.
// «Permitir siempre» solo aparece si el puente dice qué regla guardará y dónde
// (`always`); sin eso haría lo mismo que «Permitir» y volvería a preguntar.
// Un permiso de Edit/Write/MultiEdit enseña el diff: no se aprueba a ciegas.
// Atajos: 1, 2, 3… eligen la acción numerada (Alt+número también desde el
// composer); los atiende solo la primera tarjeta del panel activo.

import { useEffect, useRef, useState } from "react";
import { addNote, reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { ENGINE_LABEL } from "../../engines";
import { toolDiffLines, toolDiffStats } from "../../parse";
import { store, useSessionInfo } from "../../store";
import type { Ask, AskAnswer, AskQuestion, PermissionAlways, PermissionMode, PermissionRuleDestination } from "../../types";
import { workspaceStore } from "../../workspace";
import { Markdown } from "./Markdown";
import { DiffView } from "./ToolRow";

type PermissionAsk = Extract<Ask, { kind: "permission" }>;
type QuestionAsk = Extract<Ask, { kind: "question" }>;
type PlanAsk = Extract<Ask, { kind: "plan" }>;

const GONE = "La pregunta ya no está pendiente (cancelada: interrumpiste el turno o la sesión siguió sin ella).";

function useAnswer(ask: Ask) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const send = (answer: AskAnswer) => {
    setBusy(true);
    api.answer({ askId: ask.askId, answer }).catch((e: unknown) => {
      setBusy(false);
      if (String(e instanceof Error ? e.message : e).includes("ask_gone")) {
        store.dispatch({ type: "askResolved", askId: ask.askId });
        addNote(ask.id, "info", GONE);
        return;
      }
      reportError(e);
    });
  };
  return { busy, send };
}

/** Panel donde está el foco del teclado o, si no hay ninguno, el panel con foco del espacio de trabajo. */
function activePaneEl(): Element | null {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active?.closest('[role="dialog"]')) return null;
  return active?.closest("[data-pane-index]") ?? document.querySelector(`[data-pane-index="${workspaceStore.getState().focused}"]`);
}

type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean };

/**
 * Número de acción (1-9) de una pulsación, o null. Sin modificadores solo cuenta
 * fuera de los campos de texto (si no, escribir «1.» en el composer contestaría);
 * con Alt vale también desde el composer.
 */
export function askKeyNumber(e: KeyLike, editable: boolean): number | null {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return null;
  if (!/^[1-9]$/.test(e.key)) return null;
  if (editable && !e.altKey) return null;
  return Number(e.key);
}

/**
 * Atajos numéricos de una tarjeta. Solo responde la primera tarjeta (`data-ask-keys`)
 * del panel activo: dos sesiones con preguntas abiertas no contestan a la vez.
 */
function useAskKeys(actions: readonly ((() => void) | null)[], enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || !ref.current) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const editable = active !== null && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
      const n = askKeyNumber(e, editable);
      if (n === null) return;
      // La tarjeta con el foco manda; si no, la primera del panel activo. Sin esto,
      // con el foco en la segunda tarjeta respondían las dos (o la primera, según
      // el orden de registro de los oyentes).
      const owner = active?.closest("[data-ask-keys]") ?? activePaneEl()?.querySelector("[data-ask-keys]");
      const act = owner === ref.current ? latest.current[n - 1] : null;
      if (!act) return;
      e.preventDefault();
      act();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
  return ref;
}

function KeyHint({ n }: { n: number }) {
  return <kbd className="ask-key" aria-hidden="true">{n}</kbd>;
}

/** Diff de la edición que pide permiso; nada si la herramienta no edita ficheros. */
function PermissionDiff({ ask }: { ask: PermissionAsk }) {
  const lines = toolDiffLines(ask.tool, ask.input);
  if (lines.length === 0) return null;
  const stats = toolDiffStats(ask.tool, ask.input);
  return (
    <>
      {stats && (
        <div className="ask-diff-stats" data-testid="ask-diff-stats">
          <span className="plus">+{stats.added}</span> <span className="minus">−{stats.removed}</span> líneas
        </div>
      )}
      <DiffView lines={lines} label="Cambios que se aplicarán" />
    </>
  );
}

function inputPreview(ask: PermissionAsk): string {
  const i = ask.input as Record<string, unknown> | null;
  if (i && typeof i.command === "string") return i.command;
  if (i && typeof i.file_path === "string") return i.file_path;
  return ask.summary || JSON.stringify(ask.input, null, 2);
}

const SCOPE_LABEL: Record<PermissionRuleDestination, string> = {
  session: "en esta sesión",
  localSettings: "en este proyecto (solo tú)",
  projectSettings: "en este proyecto (compartido)",
  userSettings: "en todos los proyectos",
};

/**
 * Regla de «Permitir siempre» que anuncia el puente, validada: el `Ask` llega por
 * un evento del backend, que lo reenvía tal cual. Null si falta o está mal formada.
 */
export function alwaysOption(ask: PermissionAsk): PermissionAlways | null {
  const raw = (ask as { always?: unknown }).always;
  if (!raw || typeof raw !== "object") return null;
  const { rules, destination } = raw as { rules?: unknown; destination?: unknown };
  if (typeof destination !== "string" || !Object.prototype.hasOwnProperty.call(SCOPE_LABEL, destination)) return null;
  if (!Array.isArray(rules) || rules.length === 0) return null;
  if (!rules.every((r): r is string => typeof r === "string" && r.trim() !== "")) return null;
  return { rules, destination: destination as PermissionRuleDestination };
}

/** Texto del botón con el alcance de la regla. */
export function alwaysLabel(always: PermissionAlways): string {
  return `Permitir siempre ${SCOPE_LABEL[always.destination]}`;
}

function PermissionCard({ ask }: { ask: PermissionAsk }) {
  const { busy, send } = useAnswer(ask);
  const always = alwaysOption(ask);
  // Codex, Gemini y OpenCode no reciben un motivo al denegar: con un motor se deniega sin pedirlo.
  const engine = useSessionInfo(ask.id)?.engine ?? null;
  const [denying, setDenyingState] = useState(false);
  const setDenying = (on: boolean) => {
    if (on && engine && !busy) send({ kind: "permission", decision: "deny" });
    else setDenyingState(on);
  };
  const [reason, setReason] = useState("");
  const deny = () => {
    // Enter en el motivo no debe mandar una segunda respuesta mientras la primera vuela.
    if (!busy) send({ kind: "permission", decision: "deny", reason: reason || undefined });
  };
  const allow = () => send({ kind: "permission", decision: "allow" });
  const allowAlways = always ? () => send({ kind: "permission", decision: "allowAlways" }) : null;
  const actions = [allow, ...(allowAlways ? [allowAlways] : []), () => setDenying(true)];
  const ref = useAskKeys(actions, !busy && !denying);
  return (
    <div className="ask" role="group" aria-label="Permiso pendiente" data-testid="ask-permission" data-ask-keys="" ref={ref}>
      <div className="q">
        <b>Permiso pendiente</b>{engine ? ` · ${ENGINE_LABEL[engine]}` : ""} · {ask.reason ?? `${ask.tool} quiere ejecutarse`}
        {ask.agentId && <> · subagente <span className="mono">{ask.agentId}</span></>}
      </div>
      <pre>{inputPreview(ask)}</pre>
      <PermissionDiff ask={ask} />
      {denying ? (
        <div className="acts">
          <input className="field" style={{ flex: 1 }} autoFocus placeholder="Motivo (opcional), se lo paso a Claude" value={reason} onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && deny()} />
          <button className="btn danger" disabled={busy} onClick={deny}>Denegar</button>
          <button className="btn ghost" onClick={() => setDenying(false)}>Volver</button>
        </div>
      ) : (
        <div className="acts">
          <button className="btn pri" disabled={busy} onClick={allow} aria-keyshortcuts="1"><KeyHint n={1} />Permitir</button>
          {always && allowAlways && (
            <button className="btn" disabled={busy} title={`Añade ${always.rules.length === 1 ? "la regla" : "las reglas"}: ${always.rules.join(", ")}`}
              onClick={allowAlways} aria-keyshortcuts="2"><KeyHint n={2} />{alwaysLabel(always)}</button>
          )}
          <button className="btn ghost" disabled={busy} onClick={() => setDenying(true)} aria-keyshortcuts={String(actions.length)}><KeyHint n={actions.length} />{engine ? "Denegar" : "Denegar…"}</button>
        </div>
      )}
    </div>
  );
}

/** «Otro» se suma a lo elegido en `multiSelect` y sustituye en selección única. */
export function questionAnswer(q: AskQuestion, picked: readonly string[], other: string): string {
  const extra = other.trim();
  if (!q.multiSelect) return extra || picked[0] || "";
  return [...picked, ...(extra ? [extra] : [])].join(", ");
}

interface Pick {
  picked: string[];
  other: string;
}

function QuestionBlock({ q, value, onChange, numbered }: { q: AskQuestion; value: Pick; onChange: (v: Pick) => void; numbered: boolean }) {
  const toggle = (label: string) => {
    if (!q.multiSelect) return onChange({ picked: [label], other: "" });
    onChange({ ...value, picked: value.picked.includes(label) ? value.picked.filter((v) => v !== label) : [...value.picked, label] });
  };
  return (
    <div className={`opts${q.multiSelect ? " multi" : ""}`} role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
      {q.header && <div className="qhead">{q.header}</div>}
      <div className="q">{q.question}{q.multiSelect && <span className="faint"> · varias opciones</span>}</div>
      {q.options.map((o, i) => (
        <button key={o.label} className="opt" role={q.multiSelect ? "checkbox" : "radio"}
          aria-checked={value.picked.includes(o.label) && (q.multiSelect || !value.other)} onClick={() => toggle(o.label)}>
          <span className="box" />
          <span className="ol">{numbered && i < 9 && <KeyHint n={i + 1} />}{o.label}</span>
          {o.description && <span className="od">{o.description}</span>}
        </button>
      ))}
      <input className="field" placeholder={q.multiSelect ? "Otro: se suma a lo elegido" : "Otro: escribe tu respuesta"} value={value.other}
        onChange={(e) => onChange({ picked: q.multiSelect ? value.picked : [], other: e.target.value })} aria-label="Otra respuesta" />
    </div>
  );
}

function QuestionCard({ ask }: { ask: QuestionAsk }) {
  const { busy, send } = useAnswer(ask);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const pickOf = (q: AskQuestion): Pick => picks[q.question] ?? { picked: [], other: "" };
  const answers = Object.fromEntries(ask.questions.map((q) => [q.question, questionAnswer(q, pickOf(q).picked, pickOf(q).other)]));
  const complete = Object.values(answers).every((a) => a.length > 0);
  const setPick = (q: AskQuestion, v: Pick) => setPicks((p) => ({ ...p, [q.question]: v }));
  // Los números van a la primera pregunta sin responder (la única, si es una sola).
  const keyed = ask.questions.find((q) => !answers[q.question]) ?? (ask.questions.length === 1 ? ask.questions[0] : null);
  const keyActions = (keyed?.options ?? []).slice(0, 9).map((o) => () => {
    if (!keyed) return;
    if (keyed.multiSelect) {
      const cur = pickOf(keyed);
      setPick(keyed, { ...cur, picked: cur.picked.includes(o.label) ? cur.picked.filter((v) => v !== o.label) : [...cur.picked, o.label] });
    } else if (ask.questions.length === 1) {
      // Como en la TUI: con una sola pregunta de opción única, el número responde.
      send({ kind: "question", answers: { [keyed.question]: o.label } });
    } else setPick(keyed, { picked: [o.label], other: "" });
  });
  const ref = useAskKeys(keyActions, !busy);
  return (
    <div className="ask" role="group" aria-label="Pregunta de Claude" data-testid="ask-question" data-ask-keys="" ref={ref}>
      <div className="q"><b>Claude pregunta</b></div>
      {ask.questions.map((q) => (
        <QuestionBlock key={q.question} q={q} value={pickOf(q)} numbered={q === keyed} onChange={(v) => setPick(q, v)} />
      ))}
      <div className="acts">
        <button className="btn pri" disabled={!complete || busy} onClick={() => send({ kind: "question", answers })}>Responder</button>
        <button className="btn" disabled={busy} onClick={() => send({ kind: "question", rejected: true })} title="Claude sigue sin esta respuesta">Rechazar</button>
      </div>
    </div>
  );
}

export interface PlanOption {
  label: string;
  mode: PermissionMode;
}

/** Opciones de aprobación de la CLI (§4.3); la primera conserva el modo previo (SC-06, SC-16). */
export function planOptions(previous: PermissionMode | null): PlanOption[] {
  const out: PlanOption[] = [];
  if (previous === "bypassPermissions") out.push({ label: "Sí, mantener sin permisos (bypass)", mode: "bypassPermissions" });
  if (previous === "auto" || previous === "dontAsk") out.push({ label: "Sí, modo auto", mode: "auto" });
  const edits: PlanOption = { label: "Sí, aceptar ediciones", mode: "acceptEdits" };
  const manual: PlanOption = { label: "Sí, aprobar a mano", mode: "default" };
  if (previous === "default") out.push(manual, edits);
  else out.push(edits, manual);
  return out;
}

function PlanCard({ ask }: { ask: PlanAsk }) {
  const { busy, send } = useAnswer(ask);
  const info = useSessionInfo(ask.id);
  const [feedback, setFeedback] = useState("");
  const [asking, setAsking] = useState(false);
  const previous = info?.permissionMode && info.permissionMode !== "plan" ? info.permissionMode : info?.launchPermissionMode ?? null;
  const options = planOptions(previous);
  const approve = (mode: PermissionMode) => send({ kind: "plan", decision: "approve", mode });
  const ref = useAskKeys([...options.map((o) => () => approve(o.mode)), () => setAsking(true)], !busy && !asking);
  return (
    <div className="ask plan" role="group" aria-label="Plan propuesto" data-testid="ask-plan" data-ask-keys="" ref={ref}>
      <div className="q"><b>Plan propuesto</b> · revisa antes de que empiece a editar</div>
      <Markdown text={ask.plan} />
      {asking && <textarea className="field" rows={3} autoFocus placeholder="Qué cambiarías del plan" value={feedback} onChange={(e) => setFeedback(e.target.value)} />}
      <div className="acts">
        {!asking && options.map((o, i) => (
          <button key={o.mode} className={`btn${i === 0 ? " pri" : ""}`} disabled={busy} data-mode={o.mode}
            onClick={() => approve(o.mode)}><KeyHint n={i + 1} />{o.label}</button>
        ))}
        {asking ? (
          <>
            <button className="btn" disabled={busy} onClick={() => send({ kind: "plan", decision: "keepPlanning", feedback: feedback.trim() || undefined })}>Enviar y seguir planificando</button>
            <button className="btn ghost" onClick={() => setAsking(false)}>Volver</button>
          </>
        ) : (
          <button className="btn" onClick={() => setAsking(true)}><KeyHint n={options.length + 1} />No, seguir planificando</button>
        )}
      </div>
    </div>
  );
}

export function AskCard({ ask, interrupting = false }: { ask: Ask; interrupting?: boolean }) {
  if (interrupting) {
    return (
      <div className="msg" data-testid="ask-interrupting">
        <p className="faint"><span className="spin" aria-hidden="true" /> Interrumpiendo…</p>
      </div>
    );
  }
  return (
    <div className="msg">
      {ask.kind === "permission" ? <PermissionCard ask={ask} /> : ask.kind === "question" ? <QuestionCard ask={ask} /> : <PlanCard ask={ask} />}
    </div>
  );
}
