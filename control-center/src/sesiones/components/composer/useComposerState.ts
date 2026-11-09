// Estado y efectos del composer de una sesión: borrador (con su persistencia y la
// continuación pendiente), dictado, destino, disparador de la paleta, historial,
// adjuntos, git y las peticiones que llegan de fuera (HUD, otro panel, un mod,
// ficheros soltados en la ventana o el atajo global de voz). El orden de los
// hooks es el del componente original: la persistencia del borrador va antes que
// `useContinuation`, que depende de ella.

import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../../context";
import { useFocused } from "../../hooks/useFocused";
import { useGit } from "../../hooks/useGit";
import { useSession, useSessionInfo, useStore } from "../../store";
import type { EngineId, SendTarget, SessionId } from "../../types";
import { setUi, useUi } from "../../ui";
import type { ArgTrigger } from "./session-commands";
import type { Trigger } from "./commands";
import { joinDictated } from "./dictation";
import { useContinuation } from "./continuation";
import { readDraft, saveDraft, type ComposerDraft } from "./drafts";
import { initialNav } from "./history";
import { useAttachments } from "./useAttachments";
import { useChatSubmit } from "./useChatSubmit";
import { relayTarget } from "./RelayBanner";
import { useCommands, useFiles, usePromptHistory } from "./useComposerData";
import { useDictation } from "./useDictation";

export type InsertHow = "replace" | "append" | "insert";

/** Destino fijo del composer de una sesión de motor: su propio motor. */
const SESSION_TARGET: Record<EngineId, SendTarget> = { codex: "codexLocal", gemini: "gemini", opencode: "opencode" };

export function moveCaretToEnd(el: HTMLTextAreaElement | null, value: string) {
  window.requestAnimationFrame(() => {
    // Un diálogo abierto en este fotograma (Ctrl+R justo tras ↑/↓) se queda el foco:
    // si no, lo escrito para buscar acababa en el borrador y Enter lo enviaba.
    const inDialog = document.activeElement instanceof HTMLElement && document.activeElement.closest('[role="dialog"]') !== null;
    if (!inDialog) el?.focus();
    el?.setSelectionRange(value.length, value.length);
  });
}

function useAutosize(ta: React.RefObject<HTMLTextAreaElement | null>, text: string) {
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    // Medir exige encoger el textarea un instante. Sin fijar la altura del
    // contenedor, el chat crece en ese layout, el navegador recorta su scroll
    // y, si la altura final no cambia (textarea ya al tope), nada lo devuelve
    // al final: cada línea nueva tapaba el final del chat tras el composer.
    const box = el.parentElement;
    if (box) box.style.minHeight = `${box.offsetHeight}px`;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
    if (box) box.style.minHeight = "";
  }, [ta, text]);
}

/** Texto que el HUD, otro panel o un mod (`composer-fill`) piden dejar en este composer. */
function useInsertRequests(sessionId: SessionId, apply: (text: string, how: InsertHow) => void) {
  const req = useUi((s) => s.composerInsert);
  useEffect(() => {
    if (!req || req.sessionId !== sessionId) return;
    apply(req.text, req.how);
    setUi((s) => ({ ...s, composerInsert: null }));
  }, [req, sessionId, apply]);
}

/** Canales de WP-MOTORES: ficheros soltados en la ventana y el atajo global de voz. */
function useCrossRequests(sessionId: SessionId, addFiles: (files: File[]) => void, toggleDictation: () => void) {
  const attach = useUi((s) => s.attachRequest);
  const dictationTick = useUi((s) => s.dictationToggleTick);
  const focused = useFocused().session?.id === sessionId;
  const seenTick = useRef(dictationTick);
  useEffect(() => {
    if (!attach || attach.sessionId !== sessionId) return;
    addFiles([...attach.files]);
    setUi((s) => (s.attachRequest?.tick === attach.tick ? { ...s, attachRequest: null } : s));
  }, [attach, sessionId, addFiles]);
  useEffect(() => {
    if (dictationTick === seenTick.current) return;
    seenTick.current = dictationTick;
    if (focused) toggleDictation();
  }, [dictationTick, focused, toggleDictation]);
}

/**
 * Guarda el borrador en cada cambio (`drafts.ts` lo copia en `sessionStorage` con
 * debounce, para que sobreviva a una recarga de la página) y al desmontar (cambio
 * de sesión o cierre del panel).
 */
function useDraftPersistence(sessionId: SessionId, draft: ComposerDraft) {
  const latest = useRef(draft);
  const { text, attachments, target, delegate } = draft;
  useEffect(() => {
    latest.current = { text, attachments, target, delegate };
    saveDraft(sessionId, latest.current);
  }, [sessionId, text, attachments, target, delegate]);
  useEffect(() => () => saveDraft(sessionId, latest.current), [sessionId]);
}

/** Error del micrófono en línea sobre la caja (el toast tapaba el HUD y los chips). */
function useComposerDictation(setText: React.Dispatch<React.SetStateAction<string>>) {
  const [dictationError, setDictationError] = useState<string | null>(null);
  const dictation = useDictation((piece) => setText((t) => joinDictated(t, piece)), setDictationError);
  useEffect(() => {
    if (dictation.status === "listening") setDictationError(null);
  }, [dictation.status]);
  return { dictation, dictationError, setDictationError };
}

/** Al terminar un turno puede haber cambios nuevos en git. */
function useReloadGitAfterTurn(busy: boolean, reloadGit: () => void) {
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) reloadGit();
    wasBusy.current = busy;
  }, [busy, reloadGit]);
}

/** Estado local del composer (sin datos remotos). */
function useComposerLocal(sessionId: SessionId) {
  const [saved] = useState(() => readDraft(sessionId));
  const [text, setText] = useState(saved?.text ?? "");
  const voice = useComposerDictation(setText);
  const [target, setTarget] = useState<SendTarget>(saved?.target ?? "claude");
  const [manualTarget, setManualTarget] = useState(false);
  const [trigger, setTrigger] = useState<Trigger | ArgTrigger | null>(null);
  const [active, setActive] = useState(0);
  const [search, setSearch] = useState<{ query: string; active: number } | null>(null);
  const [nav, setNav] = useState(initialNav);
  const [drag, setDrag] = useState(false);
  const [improving, setImproving] = useState(false);
  const [delegate, setDelegate] = useState(saved?.delegate ?? false);
  const [confirmExit, setConfirmExit] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  // Envío en vuelo: Enter repetido o doble clic no deben mandar dos veces el mismo borrador.
  const sending = useRef(false);
  return {
    saved, text, setText, ...voice, target, setTarget, manualTarget, setManualTarget, trigger, setTrigger, active, setActive, search, setSearch,
    nav, setNav, drag, setDrag, improving, setImproving, delegate, setDelegate, confirmExit, setConfirmExit, ta, sending,
  };
}

export function useComposerState(sessionId: SessionId) {
  const api = useApi();
  const info = useSessionInfo(sessionId);
  const live = useSession(sessionId);
  const engineStatus = useStore((s) => s.engineStatus);
  const relay = useStore((s) => s.relays[sessionId] ?? null);
  const cwd = info?.cwd ?? "";
  const local = useComposerLocal(sessionId);
  const { saved, text, setText, trigger, delegate, ta, setTrigger, setConfirmExit } = local;
  // Sesión de motor: todo va a su motor, sin selector de destino ni relevo.
  const sessionEngine = info?.engine ?? null;
  const target = sessionEngine ? SESSION_TARGET[sessionEngine] : relayTarget(local.target, relay, local.manualTarget);
  const att = useAttachments(saved?.attachments);
  // El destino automatico del relevo no se persiste: al terminar debe volver
  // a Claude, salvo que el usuario haya elegido otro destino expresamente.
  useDraftPersistence(sessionId, { text, attachments: att.items, target: local.target, delegate });
  const git = useGit(cwd || null);
  const history = usePromptHistory(api, info?.projectId ?? null, cwd);
  const catalog = useCommands(api, cwd, sessionId, info?.bridgeProtocol ?? 0, text.startsWith("/"), Boolean(info?.engine));
  const files = useFiles(api, cwd, trigger?.kind === "at");
  const submitChat = useChatSubmit(api, sessionId, catalog, () => setConfirmExit(true));
  useAutosize(ta, text);
  useCrossRequests(sessionId, att.add, local.dictation.toggle);
  useContinuation(sessionId, text, setText);
  const busy = info?.status === "working" || info?.status === "waiting";
  useReloadGitAfterTurn(busy, git.reload);

  const applyInsert = useMemo(() => (value: string, how: InsertHow) => {
    setText((t) => {
      const el = ta.current;
      const caret = el?.selectionStart ?? t.length;
      const next = how === "insert" ? t.slice(0, caret) + value + t.slice(caret) : how === "append" && t.trim() ? `${t}\n${value}` : value;
      moveCaretToEnd(el, next);
      return next;
    });
    setTrigger(null);
  }, [setText, setTrigger, ta]);
  useInsertRequests(sessionId, applyInsert);

  return { sessionId, api, info, live, engineStatus, ...local, target, sessionEngine, relay, att, git, history, catalog, files, submitChat, busy };
}

export type ComposerState = ReturnType<typeof useComposerState>;
