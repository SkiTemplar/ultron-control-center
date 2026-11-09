// Motores (E8, E10): estado de Codex y Gemini (`sesiones_engines`) con el
// modelo activo y avisos de cada CLI, nueva intervención (un motor o el
// Tribunal con los dos) con plantillas y con o sin el contexto del hilo,
// segunda opinión automática de la sesión y lista de tareas de esta sesión
// con «Traer a Claude», «Contrastar en Claude» (Tribunal), cancelar y
// «Limpiar» las terminadas.

import { useEffect, useRef, useState } from "react";
import { reportError } from "../../bootstrap";
import { AUTO_REVIEW_MIN_FILES, reviewKey } from "../../auto-review-core";
import { setAutoReview, useAutoReview } from "../../auto-review";
import { useApi } from "../../context";
import { applyTemplate, ENGINE_TEMPLATES } from "../../engine-templates";
import { ENGINE_IDS, ENGINE_LABEL, engineBlockReason, engineOfTarget, groupTribunals, refreshEngines, runEngine, runTribunal } from "../../engines";
import { interventions } from "../../engine-session";
import { usePrefs } from "../../prefs";
import { store, useStore } from "../../store";
import type { EngineId, EngineTask, SendTarget, SessionInfo } from "../../types";
import { useUi } from "../../ui";
import { EngineModelDropdown } from "../composer/EngineModelDropdown";
import { Dropdown, type DropdownOption } from "../Dropdown";
import { IconChevronDown, IconRefresh } from "../icons";
import { TaskCard } from "./MotoresTaskCard";
import { TribunalCard } from "./MotoresTribunal";

const ENGINES: readonly EngineId[] = ENGINE_IDS;
type EngineTarget = Exclude<SendTarget, "claude"> | "tribunal";

function EngineList() {
  const api = useApi();
  const list = useStore((s) => s.engineStatus);
  const models = usePrefs().engineModels;
  return (
    <>
      <div className="sect">
        Motores
        <button className="act" onClick={() => void refreshEngines(api, { force: true })} title="Volver a detectar codex, agy y opencode"><IconRefresh /> Detectar</button>
      </div>
      {!list && <p className="note">Sin detectar.</p>}
      {list && ENGINES.map((id) => {
        const st = list.find((e) => e.id === id);
        return (
          <div key={id} className={`engine-row ${id}`} data-available={Boolean(st?.available)}>
            <span className={`dot ${st?.available ? id : "error"}`} />
            <span className="t">{ENGINE_LABEL[id]}</span>
            <span className="v num">{st?.available ? st.version ?? "disponible" : "no disponible"}</span>
            {st?.available && (
              <span className="meta" data-testid={`engine-active-model-${id}`}>
                Modelo <b>{models[id] ?? "predeterminado"}</b>
              </span>
            )}
            {!st?.available && <span className="why">{st?.reason ?? "No aparece en la detección"}</span>}
            {st?.note && <span className="why" data-testid={`engine-note-${id}`}>{st.note}</span>}
          </div>
        );
      })}
    </>
  );
}

const TARGETS: { id: EngineTarget; label: string; description: string; tone: string }[] = [
  { id: "codexLocal", label: "Codex local", description: "codex exec en el cwd de la sesión", tone: "codex" },
  { id: "codexCloud", label: "Codex Cloud", description: "Tarea en la nube (requiere entorno)", tone: "codex" },
  { id: "gemini", label: "Gemini", description: "agy en modo no interactivo", tone: "gemini" },
  { id: "opencode", label: "OpenCode", description: "opencode run con el modelo elegido", tone: "opencode" },
  { id: "tribunal", label: "Tribunal", description: "Codex local y Gemini a la vez, lado a lado", tone: "codex" },
];

/** Motivo por el que un destino no se puede usar; el Tribunal necesita los dos motores. */
function targetBlock(status: ReturnType<typeof store.getState>["engineStatus"], target: EngineTarget): string | null {
  if (target === "tribunal") return engineBlockReason(status, "codex") ?? engineBlockReason(status, "gemini");
  return engineBlockReason(status, engineOfTarget(target) ?? "codex");
}

function TemplatePicker({ onPick }: { onPick: (id: string) => void }) {
  const options: DropdownOption<string>[] = ENGINE_TEMPLATES.map((t) => ({ value: t.id, label: t.label, description: t.description }));
  return (
    <Dropdown label="Plantilla" value="" options={options} onSelect={onPick} width={280} triggerClass="chipbtn"
      trigger={<>Plantilla <IconChevronDown /></>} />
  );
}

function NewTask({ session }: { session: SessionInfo | null }) {
  const api = useApi();
  const status = useStore((s) => s.engineStatus);
  const focusTick = useUi((s) => s.engineFocusTick);
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState<EngineTarget>("codexLocal");
  const [withContext, setWithContext] = useState(true);
  const [busy, setBusy] = useState(false);
  const engineRequest = useUi((s) => s.engineTaskRequest);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusTick > 0) ta.current?.focus();
  }, [focusTick]);
  useEffect(() => {
    if (engineRequest) setTarget(engineRequest.engine === "gemini" ? "gemini" : "codexLocal");
  }, [engineRequest]);
  const tribunal = target === "tribunal";
  const engine = tribunal ? "codex" : engineOfTarget(target) ?? "codex";
  const cloud = target === "codexCloud";
  const reason = targetBlock(status, target);
  const options: DropdownOption<EngineTarget>[] = TARGETS.map((t) => {
    const why = targetBlock(status, t.id);
    return { value: t.id, label: t.label, description: t.description, tone: t.tone, disabled: Boolean(why), disabledReason: why ?? undefined };
  });

  function pickTemplate(id: string) {
    const t = ENGINE_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setPrompt((p) => applyTemplate(p, t));
    ta.current?.focus();
  }

  async function start() {
    if (!session || !prompt.trim() || reason) return;
    setBusy(true);
    try {
      const args = { sessionId: session.id, prompt: prompt.trim(), includeContext: withContext };
      const ok = tribunal
        ? (await runTribunal(api, args)).length > 0
        : (await runEngine(api, { ...args, engine, kind: "task", cloud })) !== null;
      if (ok) setPrompt("");
    } finally {
      setBusy(false);
    }
  }

  const who = tribunal ? "Codex y Gemini" : ENGINE_LABEL[engine];
  return (
    <div className="cx-new">
      <label className="sect" htmlFor="engine-prompt">Nueva intervención</label>
      <textarea id="engine-prompt" ref={ta} value={prompt} disabled={!session} onChange={(e) => setPrompt(e.target.value)}
        placeholder={session ? `En ${session.projectName}: qué tiene que hacer ${who}` : "Elige una sesión para fijar el proyecto"} />
      <div className="cx-acts">
        <Dropdown label="Motor" value={target} options={options} onSelect={setTarget} width={280} triggerClass="chipbtn"
          trigger={<><span className={`dd-dot ${engine}`} aria-hidden="true" />{TARGETS.find((t) => t.id === target)?.label} <IconChevronDown /></>} />
        {!cloud && !tribunal && <EngineModelDropdown engine={engine} placement="down" />}
        <TemplatePicker onPick={pickTemplate} />
        <label className="check"><input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} /> Contexto del hilo</label>
        <span className="spacer" />
        <button className="btn sm pri" disabled={!session || !prompt.trim() || busy || Boolean(reason)} title={reason ?? undefined} onClick={() => void start()}>Lanzar</button>
      </div>
      {reason && <p className="err-text">{tribunal ? "Tribunal" : ENGINE_LABEL[engine]} no disponible: {reason}</p>}
    </div>
  );
}

function AutoReviewToggle({ session }: { session: SessionInfo }) {
  const key = reviewKey(session);
  const on = useAutoReview(key);
  return (
    <label className="check" title={`Al terminar un turno que edite ${AUTO_REVIEW_MIN_FILES} o más ficheros, Codex lo revisa en segundo plano. Solo avisa en el chat si encuentra algo.`}>
      <input type="checkbox" checked={on} data-testid="auto-review-toggle" onChange={(e) => setAutoReview(key, e.target.checked)} />
      {" "}Segunda opinión automática ({AUTO_REVIEW_MIN_FILES}+ ficheros)
    </label>
  );
}

/**
 * Tareas de la sesión (las antiguas sin sesión también, hasta que se limpien).
 * Sin sesión no hay ninguna: antes salían las de todas las sesiones guardadas.
 * Los turnos `chat` de una sesión de motor no son intervenciones: no salen nunca.
 */
export function tasksOfSession(tasks: EngineTask[], session: SessionInfo | null): EngineTask[] {
  if (!session) return [];
  return interventions(tasks).filter((t) => !t.sessionId || t.sessionId === session.id);
}

function ClearButton({ session, tasks }: { session: SessionInfo; tasks: EngineTask[] }) {
  const api = useApi();
  const finished = tasks.filter((t) => t.status !== "running").length;
  async function clear() {
    try {
      store.dispatch({ type: "engineList", tasks: await api.engineClear(session.id) });
    } catch (e) {
      reportError(e);
    }
  }
  return (
    <button className="act" disabled={finished === 0} onClick={() => void clear()}
      title={finished === 0 ? "No hay tareas terminadas que limpiar" : "Borra las tareas terminadas de esta sesión (las que siguen en curso y los tribunales a medias se quedan)"}>
      Limpiar
    </button>
  );
}

export function Motores({ session }: { session: SessionInfo | null }) {
  const api = useApi();
  const all = useStore((s) => s.engines);
  const tasks = tasksOfSession(all, session);
  useEffect(() => {
    void refreshEngines(api);
  }, [api]);
  // Una sesión de Codex o Gemini ya habla con su motor: las intervenciones
  // y la segunda opinión son de las sesiones de Claude.
  if (session?.engine) {
    return (
      <>
        <EngineList />
        <p className="note">Esta sesión ya es de {ENGINE_LABEL[session.engine]}: las intervenciones de motores se lanzan desde una sesión de Claude.</p>
      </>
    );
  }
  return (
    <>
      <EngineList />
      <NewTask session={session} />
      {session && <AutoReviewToggle session={session} />}
      <div className="sect">
        Tareas · {tasks.length}
        {session && <ClearButton session={session} tasks={tasks} />}
      </div>
      {tasks.length === 0 && <p className="note">{session ? "Sin intervenciones en esta sesión." : "Elige una sesión para ver sus intervenciones."}</p>}
      {groupTribunals(tasks).map((x) => (Array.isArray(x)
        ? <TribunalCard key={x[0].group} group={x} session={session} />
        : <TaskCard key={x.id} task={x} session={session} />))}
    </>
  );
}
