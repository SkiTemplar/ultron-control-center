// Prompt de continuación de una sesión que ULTRON cortó a mitad de turno al
// cerrarse (`sesiones://continuation`, lo emite la restauración junto a sus
// notas). Nunca se envía: se deja en la caja del composer de esa sesión. Si ya
// había borrador, la continuación va debajo y el borrador se conserva. Si el
// composer de la sesión no está montado, queda pendiente hasta que se monte.
// Las pendientes se copian en `sessionStorage` en cada cambio: el backend ya
// retiró la suya al emitirla, así que una recarga de la página (la que sigue a
// una caída del renderer) no puede perderlas antes de que se coloquen.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createStore, store } from "../../store";
import type { SessionId } from "../../types";
import { flushDrafts } from "./drafts";

type Pending = Readonly<Record<SessionId, string>>;
type PendingAction = { id: SessionId; text: string | null };

function reducePending(s: Pending, a: PendingAction): Pending {
  if (a.text === null) {
    if (!(a.id in s)) return s;
    const { [a.id]: _gone, ...rest } = s;
    return rest;
  }
  return s[a.id] === a.text ? s : { ...s, [a.id]: a.text };
}

export const CONTINUATIONS_STORAGE_KEY = "ultron.sesiones.continuations.v1";

/** Pendientes guardadas en `raw` (JSON): solo textos no vacíos. */
export function parseStoredContinuations(raw: string | null): Pending {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const entries = Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "");
  return Object.fromEntries(entries);
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function loadPending(): Pending {
  try {
    return parseStoredContinuations(storage()?.getItem(CONTINUATIONS_STORAGE_KEY) ?? null);
  } catch {
    return {};
  }
}

/** Copia las pendientes; `false` si no se pudo (siguen en memoria, no tras una recarga). */
function persistPending(s: Pending): boolean {
  const st = storage();
  if (!st) return false;
  try {
    if (Object.keys(s).length === 0) st.removeItem(CONTINUATIONS_STORAGE_KEY);
    else st.setItem(CONTINUATIONS_STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** Continuaciones pendientes de dejar en la caja, por sesión. */
export const continuationStore = createStore<Pending, PendingAction>(reducePending, loadPending());
continuationStore.subscribe(() => void persistPending(continuationStore.getState()));

/** Borrador con la continuación debajo; sin duplicarla si ya está. */
export function mergeContinuation(draft: string, continuation: string): string {
  if (!draft.trim()) return continuation;
  if (draft.includes(continuation)) return draft;
  return `${draft.trimEnd()}\n\n${continuation}`;
}

/** Recibe la continuación del backend; un texto vacío no se ofrece. */
export function offerContinuation(id: SessionId, text: string): void {
  if (!text.trim()) return;
  continuationStore.dispatch({ id, text });
}

/** Solo para tests: descarta las continuaciones pendientes. */
export function clearContinuations(): void {
  for (const id of Object.keys(continuationStore.getState())) continuationStore.dispatch({ id, text: null });
}

/** Intentos fallidos de copiar el borrador antes de retirar la continuación. */
export const MAX_FLUSH_FAILURES = 3;

export const CONTINUATION_UNSAVED_NOTICE =
  "No se pudo guardar el borrador en sessionStorage: la continuación ya está en la caja, pero no sobrevivirá a una recarga de la ventana.";

function dropPending(id: SessionId, notice: boolean): void {
  continuationStore.dispatch({ id, text: null });
  if (notice) store.dispatch({ type: "error", message: CONTINUATION_UNSAVED_NOTICE });
}

/**
 * Deja la continuación pendiente de `sessionId` en la caja (con `setText`, nunca
 * enviándola) y la retira de pendientes cuando ya está en la caja (`text`) y el
 * borrador se ha copiado en `sessionStorage`: una recarga entre medias no la
 * pierde. Si `flushDrafts()` falla `MAX_FLUSH_FAILURES` veces (sin almacenamiento
 * o sin cuota) se retira igualmente con un aviso visible. Si estuvo en la caja y
 * ya no está (se envió o se borró), se retira: volver a montar el composer no la
 * repone. Va después de la persistencia del borrador en el composer.
 */
export function useContinuation(sessionId: SessionId, text: string, setText: (fn: (t: string) => string) => void): void {
  const pending = useSyncExternalStore(continuationStore.subscribe, () => continuationStore.getState()[sessionId] ?? null);
  const placed = useRef<string | null>(null);
  const failures = useRef(0);
  useEffect(() => {
    if (pending !== null) setText((t) => mergeContinuation(t, pending));
  }, [pending, sessionId, setText]);
  useEffect(() => {
    if (pending === null) return;
    if (!text.includes(pending)) {
      if (placed.current === pending) dropPending(sessionId, false);
      return;
    }
    if (placed.current !== pending) failures.current = 0;
    placed.current = pending;
    if (flushDrafts()) return dropPending(sessionId, false);
    failures.current += 1;
    if (failures.current >= MAX_FLUSH_FAILURES) dropPending(sessionId, true);
  }, [pending, sessionId, text]);
}
