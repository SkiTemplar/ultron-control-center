// Manejadores del composer: escritura y disparadores, envío (con `/mejorar`,
// motores y menús de argumentos), recuperación (Esc o parar), teclado (paleta,
// historial, atajos de forzar §3.4) y búsqueda Ctrl+R. Cada uno recibe el
// contexto del render (`ComposerCtx`), como antes recibían el cierre del
// componente.

import { addNote, reportError } from "../../bootstrap";
import { ENGINE_LABEL, engineBlockReason, engineOfTarget, runEngine } from "../../engines";
import { selectAsks, store } from "../../store";
import type { EngineId, RelayState, SendTarget } from "../../types";
import { escAction } from "../chat/status-line";
import { outgoingPayload } from "./attachment-kind";
import { applyCompletion, findTrigger, type Trigger } from "./commands";
import { interruptEngineSession, submitEngineSession } from "./engine-session-submit";
import { backgroundNow, forceKey } from "./force";
import { caretOnFirstLine, caretOnLastLine, initialNav, stepHistory } from "./history";
import { lastToolError, parseMejorar } from "./mejorar";
import { runRecover } from "./recover-note";
import { findCommand, routeSlash, type SlashRoute } from "./route";
import { ARG_MENU_COMMANDS, bareArgCommand, findArgTrigger, type ArgTrigger } from "./session-commands";
import type { SubmitMode } from "./submit";
import type { ComposerPopups } from "./useComposerPopups";
import { moveCaretToEnd, type ComposerState } from "./useComposerState";

export type ComposerCtx = ComposerState & ComposerPopups;
type TextareaKey = React.KeyboardEvent<HTMLTextAreaElement>;

/**
 * Disparador del texto: `/`, `@` o el menú de argumentos de un comando de Sessions.
 * Una intervención a Codex o Gemini desde Claude no ofrece comandos (son de Claude Code):
 * solo `@`. Una sesión de motor ofrece los comandos de su motor, sin menús de Sessions.
 */
function triggerFor(value: string, caret: number, target: SendTarget, sessionEngine: boolean): Trigger | ArgTrigger | null {
  const t = findTrigger(value, caret);
  if (sessionEngine) return t;
  if (target !== "claude") return t?.kind === "at" ? t : null;
  return t ?? findArgTrigger(value, caret, ARG_MENU_COMMANDS);
}

export function updateText(c: ComposerCtx, value: string, caret: number) {
  c.setText(value);
  c.setTrigger(triggerFor(value, caret, c.target, Boolean(c.sessionEngine)));
  c.setActive(0);
}

export function changeTarget(c: ComposerCtx, next: SendTarget) {
  c.setTarget(next);
  c.setManualTarget(true);
  c.setTrigger(null);
}

export function pick(c: ComposerCtx, i: number) {
  const { trigger, text } = c;
  if (!trigger) return;
  if (trigger.kind === "arg") {
    // Elegir un argumento completa la orden y la ejecuta, como un menú.
    const choice = c.argItems[i];
    if (choice) void submit(c, "auto", `${text.slice(0, trigger.start)}${choice.value}`.trim());
    return;
  }
  const value = trigger.kind === "slash" ? (c.flat[i] ? `/${c.flat[i].name}` : null) : c.fileItems[i] ?? null;
  if (!value) return;
  const next = applyCompletion(text, trigger, value);
  c.setText(next.text);
  // Un comando con menú de argumentos lo abre al completarse (los de un motor no tienen).
  c.setTrigger(trigger.kind === "slash" && !c.sessionEngine ? findArgTrigger(next.text, next.caret, ARG_MENU_COMMANDS) : null);
  c.setActive(0);
  window.requestAnimationFrame(() => c.ta.current?.setSelectionRange(next.caret, next.caret));
}

/** Abre el menú en línea de `/comando` en vez de dejar una nota de uso. */
function openArgMenu(c: ComposerCtx, command: string) {
  const next = `/${command} `;
  c.setText(next);
  c.setTrigger(findArgTrigger(next, next.length, ARG_MENU_COMMANDS));
  c.setActive(0);
  moveCaretToEnd(c.ta.current, next);
}

async function improve(c: ComposerCtx, typed: string) {
  const draft = typed || c.history.entries[0] || "";
  if (!draft) return reportError("No hay borrador que mejorar: escribe /mejorar <borrador>.");
  c.setImproving(true);
  try {
    const messages = store.getState().bySession[c.sessionId]?.messages ?? [];
    const better = await c.api.mejorar({ id: c.sessionId, draft, lastError: lastToolError(messages) });
    c.setText(better);
    c.setTrigger(null);
    moveCaretToEnd(c.ta.current, better);
  } catch (e) {
    reportError(e);
  } finally {
    c.setImproving(false);
  }
}

function clearDraft(c: ComposerCtx, prompt: string) {
  c.history.push(prompt);
  c.setText("");
  c.setNav(initialNav);
  c.setDelegate(false);
  c.att.clear();
}

/** Comandos que ULTRON Sessions ejecuta sin la CLI de Claude: valen con cualquier destino. */
const CLAUDELESS_ROUTES = new Set<SlashRoute["type"]>(["export", "autoReview", "profile", "engineModel", "inspector", "engine"]);

/**
 * Qué es el texto con destino motor: `text` (va al motor), `claude` (un `/comando`
 * de la CLI de Claude: no se aplica al motor) o `sessions` (lo ejecuta la ventana).
 */
export function engineSlashKind(prompt: string, catalog: ComposerCtx["catalog"]["commands"]): "text" | "claude" | "sessions" {
  // `!bash` y los comandos locales (`/compilar`, `/probar`, `/arrancar`) se ejecutan igual que con destino Claude.
  if (prompt.startsWith("!")) return "sessions";
  const route = prompt.startsWith("/") ? routeSlash(prompt, catalog, true) : null;
  if (route === null) return "text";
  if (CLAUDELESS_ROUTES.has(route.type)) return "sessions";
  return route.type === "run" && findCommand(route.command, catalog)?.kind === "local" ? "sessions" : "claude";
}

/**
 * Tipo del envío a un motor. Un turno al motor activo del relevo es `relay`: Codex y
 * OpenCode conservan el hilo y van sin contexto; Gemini (agy) no reanuda ninguna
 * conversación, así que pide contexto y el backend antepone el traspaso y los turnos
 * previos del relevo.
 */
export function engineSendKind(relay: RelayState | null | undefined, engine: EngineId): { kind: "relay" | "task"; includeContext: boolean } {
  const relaySend = !!relay && engine === relay.activeEngine;
  if (!relaySend) return { kind: "task", includeContext: true };
  return { kind: "relay", includeContext: engine === "gemini" };
}

/** Envío a Codex, Gemini u OpenCode: adjuntos incluidos; el borrador solo se borra si arrancó. */
async function submitToEngine(c: ComposerCtx, engine: EngineId, prompt: string) {
  const { att, target, api, sessionId } = c;
  const reason = engineBlockReason(c.engineStatus, engine);
  if (reason) return reportError(`${ENGINE_LABEL[engine]} no disponible: ${reason}`);
  if (!prompt) return reportError(`Escribe qué tiene que hacer ${ENGINE_LABEL[engine]}.`);
  const cloud = target === "codexCloud";
  if (cloud && att.items.length > 0) return reportError("Codex cloud no admite adjuntos locales: quítalos o cambia el destino a Codex local.");
  const payload = outgoingPayload(prompt, att.items);
  const task = await runEngine(api, { sessionId, engine, prompt: payload.text, ...engineSendKind(c.relay, engine), cloud, attachments: payload.attachments });
  if (task) clearDraft(c, prompt);
}

/** Sesión de motor: turno nuevo o a su cola; el borrador solo se vacía si el backend lo aceptó. */
async function submitToSession(c: ComposerCtx, mode: SubmitMode, prompt: string) {
  if (!c.sessionEngine) return;
  const ok = await submitEngineSession({
    api: c.api, sessionId: c.sessionId, engine: c.sessionEngine, engineStatus: c.engineStatus,
    prompt, attachments: c.att.items, busy: c.busy, mode,
  });
  if (ok) clearDraft(c, prompt);
}

/** `override`: orden completa elegida en un menú (paleta o argumentos), en vez del borrador. */
export async function submit(c: ComposerCtx, mode: SubmitMode = "auto", override?: string) {
  if (c.sending.current) return;
  c.sending.current = true;
  try {
    await dispatchSubmit(c, mode, override);
  } finally {
    c.sending.current = false;
  }
}

async function dispatchSubmit(c: ComposerCtx, mode: SubmitMode, override?: string) {
  const { att, target, sessionId } = c;
  const prompt = (override ?? c.text).trim();
  if ((!prompt && att.items.length === 0) || att.busy || c.improving) return;
  if (c.sessionEngine) return submitToSession(c, mode, prompt);
  const draft = target === "claude" ? parseMejorar(prompt) : null;
  if (draft !== null) return improve(c, draft);
  const engine = engineOfTarget(target);
  const slash = engine ? engineSlashKind(prompt, c.catalog.commands) : "text";
  if (engine && slash === "claude") {
    return addNote(sessionId, "warn", `Los comandos de Claude no se aplican a ${ENGINE_LABEL[engine]}; cambia el destino a Claude.`);
  }
  if (engine && slash === "text") return submitToEngine(c, engine, prompt);
  const bare = att.items.length === 0 ? bareArgCommand(prompt, ARG_MENU_COMMANDS) : null;
  if (bare) return openArgMenu(c, bare);
  if (override !== undefined) c.setTrigger(null);
  if (await c.submitChat({ text: prompt, attachments: att.items, delegate: c.delegate, mode })) clearDraft(c, prompt);
}

/**
 * Esc o botón de parar: una sola recuperación en vuelo; el resultado se cuenta en el
 * chat si falla. Interrumpir oculta al momento las tarjetas pendientes con
 * «Interrumpiendo…» hasta que llega `ask-resolved`, y las devuelve si no paró.
 */
export function recover(c: ComposerCtx, action: "interrupt" | "exitMenu") {
  const { api, sessionId } = c;
  if (c.sessionEngine) {
    if (action === "interrupt") interruptEngineSession(api, sessionId, c.sessionEngine);
    return;
  }
  const askIds = action === "interrupt" ? selectAsks(store.getState().asks, sessionId).map((a) => a.askId) : [];
  if (askIds.length > 0) store.dispatch({ type: "askInterrupting", askIds });
  const restore = () => askIds.length > 0 && store.dispatch({ type: "askInterruptFailed", askIds });
  runRecover(api, sessionId, action, (note) => addNote(sessionId, note.level, note.text))
    // `null`: ya había una recuperación en vuelo y esta no se lanzó; las tarjetas vuelven.
    .then((out) => (!out || !out.ok) && restore())
    .catch((e: unknown) => {
      restore();
      reportError(e);
    });
}

/**
 * El comando escrito ya existe (nombre o alias): Enter lo ejecuta tal cual, como en la
 * TUI, aunque la paleta resalte otro (`/review` no se cambia por `/codex-review`).
 */
function isExactCommand({ trigger, text, catalog }: ComposerCtx): boolean {
  if (trigger?.kind !== "slash" || text.trim() !== trigger.query) return false;
  const typedName = trigger.query.slice(1);
  return catalog.commands.some((c) => c.name === typedName || c.aliases?.includes(typedName));
}

/** Enter sobre un comando sin argumentos obligatorios lo ejecuta; Tab solo completa. */
function runsOnEnter({ trigger, text, catalog, flat }: ComposerCtx, i: number): boolean {
  if (trigger?.kind !== "slash" || text.slice(0, trigger.start).trim() || text.slice(trigger.end).trim()) return false;
  const def = catalog.commands.find((c) => c.name === flat[i]?.name);
  return Boolean(def && !def.needsArgs && !ARG_MENU_COMMANDS.has(def.name));
}

/** Teclas de la paleta abierta; `false` si la pulsación no era suya. */
function popupMove(c: ComposerCtx, e: TextareaKey): boolean {
  const { trigger, popupCount, active, text } = c;
  if (!trigger) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    c.setActive((a) => (a + (e.key === "ArrowDown" ? 1 : popupCount - 1)) % popupCount);
  } else if (e.key === "Enter" && !e.shiftKey && runsOnEnter(c, active)) {
    void submit(c, "auto", `/${c.flat[active].name}`);
  } else if (e.key === "Tab" && trigger.kind === "arg") {
    const choice = c.argItems[active];
    if (choice) updateText(c, `${text.slice(0, trigger.start)}${choice.value}`, trigger.start + choice.value.length);
  } else if (e.key === "Enter" || e.key === "Tab") {
    pick(c, active);
  } else if (e.key === "Escape") {
    c.setTrigger(null);
  } else return false;
  e.preventDefault();
  return true;
}

function popupKeys(c: ComposerCtx, e: TextareaKey): boolean {
  const { trigger, popupCount } = c;
  if (!trigger || (popupCount === 0 && trigger.kind !== "arg")) return false;
  if (e.key === "Enter" && !e.shiftKey && isExactCommand(c)) {
    c.setTrigger(null);
    return false;
  }
  if (trigger.kind === "arg" && popupCount === 0) {
    // Sin opciones que coincidan: Enter envía lo escrito (la nota de uso explica el error).
    if (e.key !== "Escape") return false;
    c.setTrigger(null);
    e.preventDefault();
    return true;
  }
  return popupMove(c, e);
}

function historyKeys(c: ComposerCtx, e: TextareaKey): boolean {
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
  const { text } = c;
  const el = e.currentTarget;
  if (el.selectionStart !== el.selectionEnd) return false;
  const up = e.key === "ArrowUp";
  if (up ? !caretOnFirstLine(text, el.selectionStart) : !caretOnLastLine(text, el.selectionStart)) return false;
  const step = stepHistory(c.history.entries, c.nav, up ? "older" : "newer", text);
  if (!step) return false;
  e.preventDefault();
  c.setNav(step.nav);
  c.setText(step.text);
  c.setTrigger(null);
  moveCaretToEnd(el, step.text);
  return true;
}

/** Atajos de forzar (§3.4); `true` si la pulsación era uno de ellos. */
function forceKeys(c: ComposerCtx, e: TextareaKey): boolean {
  const k = forceKey(e);
  if (!k || e.nativeEvent.isComposing) return false;
  e.preventDefault();
  if (c.sessionEngine && (k === "background" || k === "delegate")) {
    addNote(c.sessionId, "info", k === "background" ? "«Segundo plano» solo se aplica a las sesiones de Claude." : "«Subagente» solo se aplica a los mensajes para Claude.");
    return true;
  }
  // Con Ctrl+B mantenido, la autorrepetición mandaría varios: solo cuenta la primera.
  if (k === "background") {
    if (!e.repeat) void backgroundNow(c.api, c.sessionId);
  }
  else if (k !== "delegate") {
    c.setTrigger(null);
    void submit(c, k);
  }
  else if (c.target === "claude") c.setDelegate((d) => !d);
  else addNote(c.sessionId, "info", "«Subagente» solo se aplica a los mensajes para Claude.");
  return true;
}

export function onKeyDown(c: ComposerCtx, e: TextareaKey) {
  // Los atajos de forzar llevan Ctrl: mandan sobre la paleta abierta (Enter elige).
  if (forceKeys(c, e)) return;
  if (popupKeys(c, e)) return;
  if (e.ctrlKey && !e.altKey && e.code === "Space") {
    e.preventDefault();
    c.dictation.toggle();
    return;
  }
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "r") {
    e.preventDefault();
    c.setSearch({ query: "", active: 0 });
    return;
  }
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && historyKeys(c, e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    void submit(c);
  } else if (e.key === "Escape") {
    const action = escAction(c.info, !c.text.trim() && c.att.items.length === 0);
    if (action) {
      e.preventDefault();
      recover(c, action);
    }
  }
}

export function closeSearch(c: ComposerCtx, value?: string) {
  c.setSearch(null);
  if (value !== undefined) {
    c.setText(value);
    c.setNav(initialNav);
  }
  moveCaretToEnd(c.ta.current, value ?? c.text);
}

export function onSearchKey(c: ComposerCtx, e: React.KeyboardEvent<HTMLInputElement>) {
  const { search, results, text } = c;
  if (!search) return;
  const n = results.length;
  if (e.key === "Escape") closeSearch(c);
  else if (e.key === "Enter") closeSearch(c, results[search.active] ?? text);
  else if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "r")) c.setSearch({ ...search, active: n ? (search.active + 1) % n : 0 });
  else if (e.key === "ArrowUp") c.setSearch({ ...search, active: n ? (search.active + n - 1) % n : 0 });
  else return;
  e.preventDefault();
}

/**
 * Botón «Comandos»: un `/comando` solo cuenta al principio del mensaje, así que la
 * barra va delante y lo ya escrito pasa a ser su argumento (antes se insertaba
 * «\n/» al final y el comando se mandaba como texto). Ya empezando por `/`, reabre la paleta.
 */
export function openPalette(c: ComposerCtx) {
  const el = c.ta.current;
  const rest = c.text.trimStart();
  const next = rest.startsWith("/") ? rest : rest ? `/ ${rest}` : "/";
  const caret = rest.startsWith("/") ? (/^\/[\w:.-]*/.exec(rest)?.[0].length ?? 1) : 1;
  updateText(c, next, caret);
  window.requestAnimationFrame(() => {
    el?.focus();
    el?.setSelectionRange(caret, caret);
  });
}
