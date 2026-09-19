// mar.ia — pestana Conversations (navegador de conversaciones).
//
// Por que existe (2026-09-17): la pestana Sessions sabe LISTAR las sesiones de
// Claude Code, pero no ensenar ninguna. Encontrar "esa conversacion de hace
// tres semanas" obligaba a recordar la palabra exacta (el filtro era un
// `String.includes`) y abrirla significaba relanzar la CLI en una terminal
// externa a ciegas. Aqui la conversacion se LEE dentro de mar.ia, agrupada por
// fecha y con busqueda ordenada por relevancia, y se continua desde el propio
// hilo.
//
// No sustituye a Sessions (monitor en vivo + lanzador de workspaces): son
// complementarias y ninguna funcionalidad se retira.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeSession, SpawnFlags } from "../types/projects";
import { notifyError } from "../lib/notify";
import { loadPresets } from "./sessions/utils";
import { ConversationList } from "./conversations/ConversationList";
import { TranscriptView } from "./conversations/TranscriptView";
import type { TranscriptPage, TranscriptTurn } from "./conversations/types";

/** Conversaciones a listar. Cubre el historial real (73 en esta maquina) con
 *  margen, y el backend ya ordena por actividad descendente. */
const HISTORY_LIMIT = 500;

/** Lineas de transcript por pagina. El backend acota a 2000. */
const PAGE_LINES = 400;

/** Ultima conversacion abierta, para volver a ella al reentrar en la pestana
 *  (la pestana se desmonta al cambiar de tab: App.tsx monta por condicional). */
const LAST_OPEN_KEY = "ultron.cc.conversations.last_open.v1";

export function Conversations() {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ClaudeSession | null>(null);

  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [charCapped, setCharCapped] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const rows = await invoke<ClaudeSession[]>("list_claude_sessions", {
        limit: HISTORY_LIMIT,
      });
      setSessions(rows ?? []);
    } catch (e) {
      notifyError(`No pude listar las conversaciones: ${String(e)}`, "conversations");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Restaura la ultima conversacion abierta cuando llega la lista.
  useEffect(() => {
    if (selected || sessions.length === 0) return;
    let lastId: string | null = null;
    try {
      lastId = localStorage.getItem(LAST_OPEN_KEY);
    } catch {
      lastId = null;
    }
    if (!lastId) return;
    const found = sessions.find((s) => s.id === lastId);
    if (found) void openSession(found);
    // openSession es estable en la practica (solo usa setState); no lo metemos
    // en deps para no re-disparar la restauracion en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, selected]);

  async function fetchPage(sessionId: string, offset: number): Promise<TranscriptPage | null> {
    try {
      const page = await invoke<TranscriptPage>("read_session_transcript", {
        sessionId,
        offset,
        limit: PAGE_LINES,
      });
      return page ?? null;
    } catch (e) {
      setPageError(String(e));
      return null;
    }
  }

  async function openSession(s: ClaudeSession) {
    setSelected(s);
    setTurns([]);
    setNextOffset(0);
    setHasMore(false);
    setCharCapped(false);
    setPageError(null);
    setPageLoading(true);
    try {
      localStorage.setItem(LAST_OPEN_KEY, s.id);
    } catch {
      /* modo privado / storage bloqueado: la restauracion es un extra */
    }
    const page = await fetchPage(s.id, 0);
    if (page) {
      setTurns(page.turns);
      setNextOffset(page.offset + page.returned_lines);
      setHasMore(page.has_more);
      setCharCapped(page.char_capped);
    }
    setPageLoading(false);
  }

  async function loadMore() {
    if (!selected || pageLoading) return;
    setPageLoading(true);
    const page = await fetchPage(selected.id, nextOffset);
    if (page) {
      // Guarda contra un backend que devuelva una pagina vacia sin avanzar:
      // sin esto, "cargar mas" podria quedarse en bucle.
      if (page.returned_lines === 0) {
        setHasMore(false);
      } else {
        setTurns((prev) => [...prev, ...page.turns]);
        setNextOffset(page.offset + page.returned_lines);
        setHasMore(page.has_more);
        setCharCapped(page.char_capped);
      }
    }
    setPageLoading(false);
  }

  /** Continua la conversacion: `claude -r <id>` en el cwd del proyecto.
   *  Mismo contrato que el boton Resume de Sessions (presets del usuario
   *  incluidos), para no tener dos comportamientos distintos. */
  async function continueSession() {
    if (!selected) return;
    setContinuing(true);
    const presets = loadPresets();
    const flags: SpawnFlags = {
      dangerouslySkipPermissions: presets.dangerouslySkipPermissions,
      effort: presets.effort ? presets.effort : null,
      model: null,
      resumeId: selected.id,
    };
    try {
      await invoke("spawn_session", {
        provider: "claude",
        prompt: null,
        cwd: selected.project_label,
        flags,
      });
    } catch (e) {
      notifyError(`No pude continuar la conversación: ${String(e)}`, "conversations");
    } finally {
      setContinuing(false);
    }
  }

  return (
    // `overflow-hidden` + `w-full` son necesarios: el <main> de App.tsx tiene
    // overflow-auto, asi que sin acotar el ancho aqui el hijo flex-1 crece con
    // su contenido y una linea larga del transcript (una ruta, un log) empuja
    // el panel fuera de la ventana en vez de ajustarse.
    <div className="flex h-full w-full overflow-hidden" style={{ background: "var(--color-bg)" }}>
      <div className="w-[34%] min-w-[260px] max-w-[420px] shrink-0">
        <ConversationList
          sessions={sessions}
          selectedId={selected?.id ?? null}
          onSelect={(s) => void openSession(s)}
          query={query}
          onQueryChange={setQuery}
          loading={listLoading}
          onRefresh={() => void loadList()}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <TranscriptView
          session={selected}
          turns={turns}
          loading={pageLoading}
          error={pageError}
          hasMore={hasMore}
          charCapped={charCapped}
          onLoadMore={() => void loadMore()}
          onContinue={() => void continueSession()}
          continuing={continuing}
        />
      </div>
    </div>
  );
}
