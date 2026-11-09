// Envío desde el composer a Claude: enrutado de `/comandos` (§2.2 y bloque de
// menú en el chat), eco optimista por `clientId`, cola del backend cuando la
// sesión no está libre, «Enviar ya» e «Interrumpir y enviar» (§3.4) y notas
// visibles para todo lo que no se envía (nunca un no-op silencioso). Devuelve
// `true` si el borrador se puede limpiar.

import { useCallback } from "react";
import type { SesionesApi } from "../../api";
import { addNote, reportError } from "../../bootstrap";
import { delegateText, enqueueItem } from "../../queue";
import { store } from "../../store";
import type { CommandDef, EngineId, SessionId } from "../../types";
import { requestEngineTask, requestInspectorTab, requestMenu } from "../../ui";
import { markMenuIntent } from "../chat/menu-terminal";
import { outgoingPayload } from "./attachment-kind";
import type { Attachment } from "./useAttachments";
import { exportConversation } from "../../export";
import { isAutoReviewOn, setAutoReview } from "../../auto-review";
import { AUTO_REVIEW_MIN_FILES, reviewKey } from "../../auto-review-core";
import { ENGINE_LABEL, loadEngineModels } from "../../engines";
import { findProfileByName, launchWithProfile, profilesStore } from "../../launch-profiles";
import { prefsStore, setPrefs } from "../../prefs";
import { EXPORT_USAGE } from "./commands";
import { AUTO_REVIEW_USAGE, ENGINE_MODEL_USAGE, PROFILE_USAGE } from "./session-commands";
import { interruptSendNote } from "./force";
import { beginRecover, endRecover } from "./recover-note";
import { routeSlash, type SlashRoute } from "./route";
import { itemKind, newClientId, submitAction, type SubmitMode } from "./submit";

export interface SubmitInput {
  text: string;
  attachments: readonly Attachment[];
  delegate: boolean;
  /**
   * `auto` (Enter): encola si Claude trabaja. `now` (Ctrl+Enter): a la cola nativa de la
   * CLI aunque trabaje. `interrupt` (Ctrl+Mayús+Enter): para el turno y lo manda el primero.
   */
  mode: SubmitMode;
}

export interface Catalog {
  commands: readonly CommandDef[];
  live: boolean;
}

/** `/segunda-opinion on|off`: el mismo interruptor que la casilla de Motores. */
function runAutoReview(id: SessionId, on: boolean | null): boolean {
  const info = store.getState().sessions.find((s) => s.id === id);
  if (on === null || !info) {
    // Error de uso, no un incidente: nota informativa.
    addNote(id, "info", AUTO_REVIEW_USAGE);
    return false;
  }
  const key = reviewKey(info);
  if (isAutoReviewOn(key) === on) {
    addNote(id, "info", `La segunda opinión automática ya estaba ${on ? "activada" : "desactivada"}.`);
    return true;
  }
  setAutoReview(key, on);
  addNote(id, "info", on
    ? `Segunda opinión automática activada: al terminar un turno que edite ${AUTO_REVIEW_MIN_FILES} o más ficheros, Codex lo revisa en segundo plano y solo avisa si encuentra algo.`
    : "Segunda opinión automática desactivada.");
  return true;
}

/** `/perfil <nombre>`: sesión nueva aquí con ese perfil (queda como último usado, el de Ctrl+T). */
async function runProfile(api: SesionesApi, id: SessionId, name: string): Promise<boolean> {
  const profile = name ? findProfileByName(name) : null;
  if (!profile) {
    const names = profilesStore.getState().profiles.map((p) => p.name).join(", ");
    addNote(id, "info", name ? `No hay ningún perfil «${name}». Perfiles: ${names}.` : `${PROFILE_USAGE}. Perfiles: ${names}.`);
    return false;
  }
  await launchWithProfile(api, { kind: "here", focusedId: id }, profile);
  return true;
}

/** `/motor-modelo codex|gemini|opencode <modelo>`: valida contra la lista de la CLI y lo guarda en las preferencias. */
async function runEngineModel(api: SesionesApi, id: SessionId, choice: { engine: EngineId; model: string } | null): Promise<boolean> {
  if (!choice) {
    addNote(id, "info", ENGINE_MODEL_USAGE);
    return false;
  }
  const { engine, model } = choice;
  if (model) {
    const list = await loadEngineModels(api, engine);
    if (!list.some((m) => m.id === model)) {
      addNote(id, "info", `${ENGINE_LABEL[engine]} no ofrece «${model}». Disponibles: ${list.map((m) => m.id).join(", ") || "ninguno"}.`);
      return false;
    }
  }
  setPrefs({ engineModels: { ...prefsStore.getState().engineModels, [engine]: model || null } });
  addNote(id, "info", `${ENGINE_LABEL[engine]} se lanzará con ${model ? `el modelo ${model}` : "el modelo predeterminado de su CLI"}.`);
  return true;
}

async function runRoute(api: SesionesApi, id: SessionId, route: SlashRoute, confirmExit: () => void): Promise<boolean> {
  switch (route.type) {
    case "unknown":
      addNote(id, "error", `Comando desconocido: /${route.command}.${route.suggestions.length ? ` ¿Quisiste decir ${route.suggestions.join(", ")}?` : ""}`);
      return false;
    case "unsupported":
      addNote(id, "info", `/${route.command}: ${route.note}`);
      return true;
    case "exit":
      confirmExit();
      return true;
    case "inspector":
      requestInspectorTab(id, route.tab);
      return true;
    case "engine":
      requestEngineTask(id, "codex");
      return true;
    case "autoReview":
      return runAutoReview(id, route.on);
    case "profile":
      return runProfile(api, id, route.name);
    case "engineModel":
      return runEngineModel(api, id, route.choice);
    case "export":
      if (!route.format) {
        // Error de uso, no un incidente: el composer abre el menú de formatos antes de llegar aquí.
        addNote(id, "info", EXPORT_USAGE);
        return false;
      }
      // Sin esperar al diálogo: el resultado (o el fallo) llega como nota.
      void exportConversation(api, id, route.format);
      return true;
    default:
      break;
  }
  if (route.type === "run" && route.warn) addNote(id, "warn", route.warn);
  // El menú que abra este envío lo pidió el usuario: el bloque del chat puede
  // quitarle el foco al composer (sin la marca, las flechas seguirían en el textarea).
  if (route.type === "menu") markMenuIntent(id);
  const outcome = await api.runCommand({ id, command: route.command, args: route.args, clientId: newClientId() });
  if (outcome.note) addNote(id, "info", outcome.note);
  if (outcome.disposition === "queued") addNote(id, "info", `/${route.command} en cola: se ejecuta al terminar el turno.`);
  if (outcome.disposition !== "written" && outcome.text) addNote(id, "info", outcome.text);
  // Backend con el cable antiguo: no escribió el menú; lo teclea el bloque de menú del chat.
  if (route.type === "menu" && (outcome.disposition === "panel" || outcome.disposition === "terminal")) requestMenu(id, route.command);
  if (outcome.disposition === "unsupported" && !outcome.note && !outcome.text) addNote(id, "info", `/${route.command} no aplica dentro de ULTRON Sessions.`);
  return true;
}

async function sendPrompt(api: SesionesApi, id: SessionId, input: SubmitInput, mode: "auto" | "now"): Promise<boolean> {
  const clientId = newClientId();
  const payload = outgoingPayload(input.text, input.attachments);
  const text = input.delegate ? delegateText(payload.text) : payload.text;
  const { attachments } = payload;
  store.dispatch({ type: "echo", id, echo: { clientId, text, attachments, at: new Date().toISOString() } });
  try {
    const outcome = await api.send({ id, text, attachments, clientId, mode });
    if (outcome.disposition === "queued") store.dispatch({ type: "echoDrop", id, clientId });
  } catch (e) {
    store.dispatch({ type: "echoDrop", id, clientId });
    throw e;
  }
  input.attachments.forEach((a) => store.dispatch({ type: "attachment", id, attachment: a }));
  return true;
}

/**
 * «Interrumpir y enviar» (§3.4): el backend lo encola el primero, interrumpe y lo envía por
 * delante de lo que la interrupción devuelva a la cola. Si no pudo parar el turno, el
 * mensaje queda el primero de la cola y la nota lo dice. Un `/comando` no lleva eco.
 */
async function interruptAndSend(api: SesionesApi, id: SessionId, input: SubmitInput, echo: boolean): Promise<boolean> {
  const clientId = newClientId();
  const payload = outgoingPayload(input.text, input.attachments);
  const { attachments } = payload;
  const text = input.delegate ? delegateText(payload.text) : payload.text;
  if (echo) store.dispatch({ type: "echo", id, echo: { clientId, text, attachments, at: new Date().toISOString() } });
  // Comparte la guarda de vuelo de «Interrumpir»: un Esc durante el envío no lanza otra
  // interrupción. Con una ya en vuelo se llama igual: el backend espera a que acabe.
  const owned = beginRecover(id);
  try {
    const out = await api.interruptAndSend({ id, text: payload.text, attachments, clientId, delegate: input.delegate });
    const note = interruptSendNote(out);
    if (note) {
      if (echo) store.dispatch({ type: "echoDrop", id, clientId });
      addNote(id, "warn", note);
    }
  } catch (e) {
    if (echo) store.dispatch({ type: "echoDrop", id, clientId });
    throw e;
  } finally {
    if (owned) endRecover(id);
  }
  input.attachments.forEach((a) => store.dispatch({ type: "attachment", id, attachment: a }));
  return true;
}

export function useChatSubmit(api: SesionesApi, id: SessionId, catalog: Catalog, confirmExit: () => void) {
  return useCallback(async (input: SubmitInput): Promise<boolean> => {
    const info = store.getState().sessions.find((s) => s.id === id) ?? null;
    const action = submitAction(info, input.mode);
    try {
      if (action.type === "blocked") {
        addNote(id, "error", action.reason);
        return false;
      }
      // Los comandos van siempre por `run_command`: con la sesión ocupada, el backend
      // decide si es inmediato o si lo encola como elemento `command` (§2.2).
      const route = input.attachments.length === 0 ? routeSlash(input.text, catalog.commands, catalog.live) : null;
      // Solo un comando que va a la CLI se fuerza; los de la ventana y los menús siguen su ruta.
      if (route?.type === "run" && action.type === "interruptSend") {
        if (route.warn) addNote(id, "warn", route.warn);
        return await interruptAndSend(api, id, input, false);
      }
      if (route) return await runRoute(api, id, route, confirmExit);
      if (action.type === "interruptSend") return await interruptAndSend(api, id, input, true);
      if (action.type === "enqueue") {
        const kind = itemKind(input.text, catalog.commands, input.attachments.length > 0);
        await enqueueItem(api, id, { clientId: newClientId(), ...outgoingPayload(input.text, input.attachments), delegate: input.delegate, kind });
        return true;
      }
      return await sendPrompt(api, id, input, action.type === "now" ? "now" : "auto");
    } catch (e) {
      reportError(e);
      return false;
    }
  }, [api, id, catalog, confirmExit]);
}
