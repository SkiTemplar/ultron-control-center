// Piezas del composer: chips de adjuntos, destino «Enviar a», barra de una fila
// con Interrumpir junto a Encolar (R18), «Enviar ya» e «Interrumpir y enviar»
// con Claude trabajando y borrador (§3.4), y la confirmación de `/exit`.

import { useRef } from "react";
import { ENGINE_LABEL, engineBlockReason, engineOfTarget } from "../../engines";
import { useStore } from "../../store";
import type { EngineId, SendTarget, SessionId, SessionInfo } from "../../types";
import { Dropdown, type DropdownOption } from "../Dropdown";
import { IconAgent, IconChevronDown, IconClip, IconClose, IconFile, IconMic, IconSend, IconSlash, IconStop } from "../icons";
import { EngineModelDropdown } from "./EngineModelDropdown";
import type { DictationStatus } from "./useDictation";
import type { Attachment } from "./useAttachments";

const TARGETS: { id: SendTarget; label: string; hint: string; tone: string }[] = [
  { id: "claude", label: "Claude", hint: "Escribe en esta sesión de Claude Code (el conductor)", tone: "claude" },
  { id: "codexLocal", label: "Codex", hint: "Intervención en el mismo cwd con el contexto del hilo", tone: "codex" },
  { id: "codexCloud", label: "Codex Cloud", hint: "Tarea en la nube de Codex (requiere entorno)", tone: "codex" },
  { id: "gemini", label: "Gemini", hint: "Consulta a Gemini (agy) con el contexto del hilo", tone: "gemini" },
  { id: "opencode", label: "OpenCode", hint: "OpenCode con DeepSeek u otro proveedor con key, en el mismo cwd", tone: "opencode" },
];

/** Motor cuyo modelo se elige en el composer; Codex Cloud usa el de su entorno. */
export function modelEngineOfTarget(t: SendTarget): EngineId | null {
  return t === "codexCloud" ? null : engineOfTarget(t);
}

export function targetLabel(t: SendTarget): string {
  return TARGETS.find((x) => x.id === t)?.label ?? "Claude";
}

export function TargetDropdown({ value, onChange }: { value: SendTarget; onChange: (t: SendTarget) => void }) {
  const status = useStore((s) => s.engineStatus);
  const options: DropdownOption<SendTarget>[] = TARGETS.map((t) => {
    const engine = engineOfTarget(t.id);
    const reason = engine ? engineBlockReason(status, engine) : null;
    return { value: t.id, label: t.label, description: t.hint, tone: t.tone, disabled: Boolean(reason), disabledReason: reason ?? undefined };
  });
  const current = TARGETS.find((t) => t.id === value) ?? TARGETS[0];
  return (
    <Dropdown label="Enviar a" value={value} options={options} onSelect={onChange} placement="up" width={330}
      triggerClass={`chipbtn target ${current.tone}`} triggerTitle="Motor que recibe el siguiente mensaje" testId="send-target"
      trigger={<><span className={`dd-dot ${current.tone}`} aria-hidden="true" /><span className="chip-label">Enviar a:</span> {current.label} <IconChevronDown /></>} />
  );
}

export function AttachmentChips({ items, onRemove }: { items: Attachment[]; onRemove: (path: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="attach" aria-label="Adjuntos">
      {items.map((a) => (
        <span className="att" key={a.path} title={a.isPathOnly ? `Se envía solo la ruta: ${a.path}` : a.path}>
          {a.previewDataUrl ? <img src={a.previewDataUrl} alt="" /> : <span className="file-i"><IconFile /></span>}
          <span className="an">{a.name}</span>
          <button className="icon-btn" aria-label={`Quitar ${a.name}`} onClick={() => onRemove(a.path)}>
            <IconClose />
          </button>
        </span>
      ))}
    </div>
  );
}

/** `/exit` cierra la CLI: siempre con confirmación (cambio de diseño del 2026-10-08). */
export function ExitConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="cnotice waiting" role="alertdialog" aria-label="Cerrar la sesión" data-testid="exit-confirm">
      <span><b>/exit cierra Claude Code</b> y la sesión termina; podrás reiniciarla con la misma conversación.</span>
      <button className="btn sm danger" onClick={onConfirm}>Cerrar la sesión</button>
      <button className="btn sm ghost" onClick={onCancel}>Cancelar</button>
    </div>
  );
}

interface BarProps {
  sessionId: SessionId;
  info: SessionInfo | null;
  target: SendTarget;
  onTarget: (t: SendTarget) => void;
  delegate: boolean;
  onDelegate: () => void;
  dictation: { status: DictationStatus; pending: number; toggle: () => void };
  attBusy: boolean;
  canSend: boolean;
  onAttach: (files: File[]) => void;
  onSlash: () => void;
  onSubmit: () => void;
  /** «Enviar ya» (Ctrl+Enter): a la cola nativa de la CLI aunque Claude trabaje. */
  onSubmitNow: () => void;
  /** «Interrumpir y enviar» (Ctrl+Mayús+Enter). */
  onInterruptSend: () => void;
  onRecover: (action: "interrupt" | "exitMenu") => void;
}

export const SEND_NOW_TITLE =
  "Enviar ya (Ctrl+Enter): Claude lo lee al terminar la herramienta en curso, por larga que sea; con Ctrl+B la pasa a segundo plano y lo lee antes. " +
  "La CLI no lo hace sola en este equipo: los hooks PostToolUse y los mods que enganchan tool.call desactivan su paso automático a segundo plano";
export const ENGINE_SEND_NOW_TITLE = "Enviar ya (Ctrl+Enter): Codex lo recibe dentro del turno en curso, sin esperar a que termine";

export const INTERRUPT_SEND_TITLE =
  "Interrumpir y enviar (Ctrl+Mayús+Enter): para el turno y manda este mensaje por delante de la cola";

/** Botón de envío: «Enviar» con la sesión libre, «Encolar» si trabaja, espera o arranca. */
function sendLabel(info: SessionInfo | null, isEngine: boolean, target: SendTarget): { label: string; title?: string; queue: boolean } {
  if (isEngine) return { label: `Enviar a ${targetLabel(target)}`, queue: false };
  const free = info?.status === "idle" && info.waiting === null;
  if (free || info?.status === "exited") return { label: "Enviar", queue: false };
  return { label: "Encolar", queue: true, title: "Sale de uno en uno, en orden, al terminar cada turno (Enter); Ctrl+Enter lo envía ya y Ctrl+Mayús+Enter interrumpe y lo envía" };
}

/** Botón de envío de una sesión de motor: «Enviar» libre, «Encolar» con un turno en curso. */
function sessionSendLabel(info: SessionInfo | null, engine: EngineId): { label: string; title?: string; queue: boolean } {
  if (info?.status !== "working") return { label: "Enviar", title: `Enviar a ${ENGINE_LABEL[engine]} (Enter)`, queue: false };
  return { label: "Encolar", queue: true, title: `Sale al terminar el turno de ${ENGINE_LABEL[engine]}, de uno en uno y en orden (Enter); Ctrl+Mayús+Enter interrumpe y lo envía` };
}

/** Modelo de una sesión de motor: se fija al crearla (no hay selector de destino). */
function SessionModelChip({ info, engine }: { info: SessionInfo; engine: EngineId }) {
  return (
    <span className={`chipbtn target ${engine}`} data-testid="engine-session-model"
      title="El modelo se fija al crear la sesión; el de las sesiones nuevas se elige en «+ Codex», «+ Gemini» y «+ OpenCode» o en Motores">
      <span className={`dd-dot ${engine}`} aria-hidden="true" /><span className="chip-label">{ENGINE_LABEL[engine]}:</span> {info.model ?? "modelo predeterminado"}
    </span>
  );
}

export function ComposerBar(p: BarProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  // Sesión de motor: el composer habla con su motor. `isEngine` es una intervención a otro motor desde Claude.
  const sessionEngine = p.info?.engine ?? null;
  const isEngine = p.target !== "claude" && !sessionEngine;
  const waitKind = p.info?.status === "waiting" ? p.info.waiting?.kind : undefined;
  const menu = waitKind === "menu" || (p.info?.screen === "dialog" && p.info.status !== "exited" && waitKind !== "trust");
  const canInterrupt = sessionEngine
    ? p.info?.status === "working"
    : !isEngine && !menu && (p.info?.status === "working" || (p.info?.status === "waiting" && waitKind !== "trust"));
  const send = sessionEngine ? sessionSendLabel(p.info, sessionEngine) : sendLabel(p.info, isEngine, p.target);
  const modelEngine = sessionEngine ? null : modelEngineOfTarget(p.target);
  // Forzar solo tiene sentido con borrador y el motor ocupado (§3.4). «Enviar ya» en una
  // sesión de motor solo con Codex (turn/steer); Gemini y OpenCode no lo admiten.
  const canForce = !isEngine && p.canSend;
  const showNow = canForce && !menu && p.info?.status === "working" && (!sessionEngine || sessionEngine === "codex");
  const showInterruptSend = canForce && canInterrupt;
  return (
    <div className={`cbar${showNow || showInterruptSend ? " forcing" : ""}`}>
      <button className="chipbtn" onClick={() => fileInput.current?.click()} title="Adjuntar cualquier fichero: imágenes, PDF y texto se leen; del resto se envía la ruta"><IconClip /> <span className="chip-label">Adjuntar</span></button>
      {/* Los comandos son de Claude Code: con destino Codex o Gemini no se ofrecen. */}
      {!isEngine && <button className="chipbtn" onClick={p.onSlash} title="Paleta de comandos y skills; lo ya escrito pasa a ser el argumento"><IconSlash /> <span className="chip-label">Comandos</span></button>}
      <button className="chipbtn mic" aria-pressed={p.dictation.status !== "off"} onClick={p.dictation.toggle}
        title={p.dictation.status === "off" ? "Dictar por voz: el audio se transcribe en Groq (Ctrl+Espacio); vuelve a pulsar para pausar" : "Pausar el dictado (Ctrl+Espacio)"}>
        <IconMic /> <span className="chip-label">{p.dictation.status === "listening" ? "Escuchando" : p.dictation.status === "starting" ? "Micro…" : "Voz"}</span>
        {p.dictation.pending > 0 && <span className="spin" aria-label="Transcribiendo" />}
      </button>
      {sessionEngine && p.info ? <SessionModelChip info={p.info} engine={sessionEngine} /> : <TargetDropdown value={p.target} onChange={p.onTarget} />}
      {modelEngine && <EngineModelDropdown engine={modelEngine} />}
      {!isEngine && !sessionEngine && (
        <button className="chipbtn" aria-pressed={p.delegate} onClick={p.onDelegate} aria-label="Subagente"
          title="El siguiente mensaje se encarga a un subagente en segundo plano (Ctrl+Mayús+D)"><IconAgent /> <span className="chip-label">Subagente</span></button>
      )}
      {p.attBusy && <span className="live-tag"><span className="spin" /> Guardando adjunto…</span>}
      <div className="send-group">
        {menu && !isEngine && (
          <button className="send stop" onClick={() => p.onRecover("exitMenu")} title="Cierra el menú de la TUI (Esc)" data-testid="exit-menu">
            <IconClose /> Salir del menú
          </button>
        )}
        {/* Único dueño de Interrumpir (con Esc): ni la línea de estado ni las
            tarjetas de permiso, pregunta o plan lo repiten. Con borrador pasa
            a «Interrumpir y enviar». */}
        {canInterrupt && !showInterruptSend && (
          <button className="send stop" onClick={() => p.onRecover("interrupt")} title="Interrumpir el turno (Esc con el composer vacío)" data-testid="interrupt">
            <IconStop /> Interrumpir
          </button>
        )}
        {showInterruptSend && (
          <button className="send stop" onClick={p.onInterruptSend} title={INTERRUPT_SEND_TITLE} data-testid="interrupt-send">
            <IconStop /> Interrumpir y enviar
          </button>
        )}
        {showNow && (
          <button className="send alt" onClick={p.onSubmitNow} title={sessionEngine ? ENGINE_SEND_NOW_TITLE : SEND_NOW_TITLE} data-testid="send-now">
            Enviar ya <IconSend />
          </button>
        )}
        <button className="send" disabled={!p.canSend} onClick={p.onSubmit} title={send.title} data-testid={send.queue ? "enqueue" : "send"}>
          {send.label} <IconSend />
        </button>
      </div>
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
        p.onAttach([...(e.target.files ?? [])]);
        e.target.value = "";
      }} />
    </div>
  );
}
