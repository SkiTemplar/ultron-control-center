// Marcadores del hilo en el chat: botón de fijar en cada mensaje (visible al
// pasar el ratón; fijo y en color si el mensaje está marcado) y el menú
// «Marcadores» del panel, que lleva al mensaje o explica por qué no puede.

import { useEffect, useRef, useState } from "react";
import type { SesionesApi } from "../../api";
import { loadOlder, reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { pagingOf } from "../../session-state";
import { store } from "../../store";
import { makeBookmark, removeBookmark, requestJump, toggleBookmark, updateBookmarks, useBookmarks, useIsBookmarked, useJump, type Bookmark } from "../../bookmarks";
import type { ChatMessage, SessionId } from "../../types";
import { IconBookmark, IconClose } from "../icons";
import { useChatScope } from "./ChatContext";

const NOT_SAVED = "No se pudo guardar el marcador: el almacenamiento local no está disponible y solo durará lo que esta ventana.";

/** Conversación de marcadores del chat que se pinta y si el mensaje está fijado. */
export function usePin(m: ChatMessage): { conversation: string | null; pinned: boolean } {
  const scope = useChatScope();
  const conversation = scope && !scope.readOnly ? scope.bookmarks ?? null : null;
  const pinned = useIsBookmarked(conversation, m.uuid);
  return { conversation, pinned };
}

export function PinButton({ m, conversation, pinned, floating = false }: { m: ChatMessage; conversation: string | null; pinned: boolean; floating?: boolean }) {
  if (!conversation) return null;
  function toggle() {
    const entry = makeBookmark(m);
    if (!entry || !conversation) return;
    if (!updateBookmarks(conversation, (l) => toggleBookmark(l, entry))) reportError(NOT_SAVED);
  }
  const label = pinned ? "Quitar de marcadores" : "Fijar en marcadores";
  return (
    <button type="button" className={`pin-btn${floating ? " float" : ""}`} aria-pressed={pinned} aria-label={label} title={label} onClick={toggle}>
      <IconBookmark />
    </button>
  );
}

const ROLE_LABEL: Record<Bookmark["role"], string> = { user: "Tú", assistant: "Claude" };

type NoteKind = "loading" | "unloaded" | "failed" | "missing";

const NOTE: Record<NoteKind, string> = {
  loading: "Cargando el historial anterior hasta el mensaje…",
  unloaded: "Ese mensaje no está en el historial de esta conversación (el transcript se compactó o se limpió con /clear).",
  failed: "No se pudo cargar el historial anterior hasta el mensaje: vuelve a pulsarlo para reintentarlo.",
  missing: "Ese mensaje está cargado pero no se pinta (actividad plegada del turno): despliega el turno o desactiva la vista compacta.",
};

interface MenuProps {
  sessionId: SessionId;
  conversation: string;
  /** Claves (uuid) de los mensajes cargados en el hilo. */
  isLoaded: (uuid: string) => boolean;
}

/** Tope de páginas que se cargan buscando un marcador (cada página son decenas de mensajes). */
export const MAX_BOOKMARK_PAGES = 60;
/** Vueltas seguidas sin traer nada (ni carga en vuelo) antes de darse por vencido. */
const MAX_STALLS = 3;

/** La carga de páginas anteriores no avanza: `loadOlder` falla (y ya lo ha notificado). */
export class BookmarkLoadStalled extends Error {}

const isInThread = (id: SessionId, uuid: string) => (store.getState().bySession[id]?.messages ?? []).some((m) => m.uuid === uuid);

/**
 * Carga páginas anteriores del hilo principal hasta que aparece el mensaje. `false`
 * si el transcript se acaba (o se llega al tope) sin encontrarlo.
 */
export async function loadUntilBookmark(api: SesionesApi, id: SessionId, uuid: string, maxPages = MAX_BOOKMARK_PAGES): Promise<boolean> {
  let stalls = 0;
  for (let page = 0; page < maxPages; page += 1) {
    if (isInThread(id, uuid)) return true;
    const s = store.getState().bySession[id];
    if (!s || !pagingOf(s, null).hasMore) return false;
    const before = s.messages.length;
    await loadOlder(api, id, null);
    const after = store.getState().bySession[id];
    if ((after?.messages.length ?? 0) !== before) {
      stalls = 0;
      continue;
    }
    // Otra carga en vuelo (el scroll también pagina): se espera a que termine. Sin
    // carga en vuelo y sin mensajes nuevos, `loadOlder` ha fallado: tras unas vueltas
    // se corta, en vez de repetir la petición fallida hasta el tope de páginas.
    if (!(after && pagingOf(after, null).loading)) stalls += 1;
    if (stalls >= MAX_STALLS) throw new BookmarkLoadStalled("El historial anterior no se pudo cargar.");
    await new Promise((r) => window.setTimeout(r, 120));
  }
  return isInThread(id, uuid);
}

function useCloseOnOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function BookmarksMenu({ sessionId, conversation, isLoaded }: MenuProps) {
  const api = useApi();
  const list = useBookmarks(conversation);
  const jump = useJump(sessionId);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<Exclude<NoteKind, "missing"> | null>(null);
  const [lastTick, setLastTick] = useState(0);
  const ref = useCloseOnOutside(open, () => setOpen(false));
  const mine = jump && jump.tick === lastTick ? jump : null;

  useEffect(() => {
    if (mine?.status === "done") setOpen(false);
  }, [mine?.status]);

  if (list.length === 0) return null;
  const shown = note ?? (mine?.status === "missing" ? "missing" : null);

  async function go(uuid: string) {
    if (note === "loading") return;
    if (!isLoaded(uuid)) {
      setNote("loading");
      setLastTick(0);
      let found = false;
      try {
        found = await loadUntilBookmark(api, sessionId, uuid);
      } catch (e) {
        // El fallo de cada página ya lo ha notificado `loadOlder`; lo inesperado, no.
        if (!(e instanceof BookmarkLoadStalled)) reportError(e);
        return setNote("failed");
      }
      if (!found) return setNote("unloaded");
    }
    setNote(null);
    setLastTick(requestJump(sessionId, uuid));
  }

  function remove(uuid: string) {
    if (!updateBookmarks(conversation, (l) => removeBookmark(l, uuid))) reportError(NOT_SAVED);
  }

  return (
    <div className="bm" ref={ref}>
      <button type="button" className="bm-toggle" aria-expanded={open} aria-haspopup="dialog" title="Mensajes fijados de esta conversación"
        onClick={() => { setOpen((o) => !o); setNote(null); }}>
        <IconBookmark /> Marcadores <span className="num">{list.length}</span>
      </button>
      {open && (
        <div className="bm-pop" role="dialog" aria-label="Marcadores">
          <ul className="bm-list">
            {list.map((b) => (
              <li key={b.uuid} className="bm-item">
                <button type="button" className="bm-go" onClick={() => void go(b.uuid)} disabled={note === "loading"} aria-label={`Ir al mensaje de ${ROLE_LABEL[b.role]}: ${b.preview}`} title="Ir al mensaje">
                  <span className="bm-role">{ROLE_LABEL[b.role]}</span>
                  <span className="bm-preview">{b.preview || "(sin texto)"}</span>
                </button>
                <button type="button" className="icon-btn bm-del" aria-label={`Quitar marcador: ${b.preview}`} title="Quitar de marcadores" onClick={() => remove(b.uuid)}>
                  <IconClose />
                </button>
              </li>
            ))}
          </ul>
          {shown && <p className="bm-note" role="status">{NOTE[shown]}</p>}
        </div>
      )}
    </div>
  );
}
