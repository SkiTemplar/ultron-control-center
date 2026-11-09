// Datos del composer con caché por proyecto o directorio: historial de prompts
// (sembrado con `sesiones_prompt_history`) y catálogo de comandos
// (`sesiones_commands`). Varias vistas de la misma sesión comparten la caché.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SesionesApi } from "../../api";
import { useSession } from "../../store";
import type { CommandDef, SessionId } from "../../types";
import { FALLBACK_COMMANDS, withSessionCommands } from "./commands";
import { mergeHistory, pushHistory } from "./history";

const historyCache = new Map<string, string[]>();
const historySeed = new Map<string, Promise<void>>();
const commandCache = new Map<string, Promise<CommandDef[]>>();
const fileCache = new Map<string, Promise<string[]>>();

export interface ProjectFiles {
  list: string[];
  /** Por qué no hay lista (`sesiones_files` falló); se reintenta en el siguiente `@`. */
  error: string | null;
}

const NO_FILES: ProjectFiles = { list: [], error: null };

/** Ficheros del proyecto para el `@`; un fallo se avisa y no queda en la caché. */
export function useFiles(api: SesionesApi, cwd: string, enabled: boolean): ProjectFiles {
  const [files, setFiles] = useState<ProjectFiles>(NO_FILES);
  useEffect(() => {
    if (!enabled || !cwd) return;
    let job = fileCache.get(cwd);
    if (!job) {
      job = api.listFiles(cwd);
      fileCache.set(cwd, job);
      job.catch(() => fileCache.delete(cwd));
    }
    let alive = true;
    job.then(
      (list) => alive && setFiles({ list, error: null }),
      (e: unknown) => alive && setFiles({ list: [], error: `No se pudo listar los ficheros del proyecto: ${e instanceof Error ? e.message : String(e)}` }),
    );
    return () => {
      alive = false;
    };
  }, [api, cwd, enabled]);
  return files;
}

export interface PromptHistory {
  entries: string[];
  error: string | null;
  push: (prompt: string) => void;
}

export function usePromptHistory(api: SesionesApi, projectId: string | null, cwd: string): PromptHistory {
  const key = projectId ?? cwd;
  const [entries, setEntries] = useState<string[]>(() => historyCache.get(key) ?? []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!key) return;
    if (!historySeed.has(key)) {
      const seed = api
        .promptHistory({ projectId: projectId ?? undefined, cwd: cwd || undefined, limit: 500 })
        .then((list) => {
          historyCache.set(key, mergeHistory(historyCache.get(key) ?? [], list));
        });
      historySeed.set(key, seed);
    }
    let alive = true;
    historySeed
      .get(key)
      ?.then(() => alive && setEntries(historyCache.get(key) ?? []))
      .catch((e: unknown) => {
        historySeed.delete(key);
        if (alive) setError(`No se pudo leer el historial del proyecto: ${String(e)}`);
      });
    return () => {
      alive = false;
    };
  }, [api, key, projectId, cwd]);

  const push = useCallback(
    (prompt: string) => {
      const next = pushHistory(historyCache.get(key) ?? [], prompt);
      historyCache.set(key, next);
      setEntries(next);
    },
    [key],
  );

  return { entries, error, push };
}

export interface CommandCatalog {
  commands: readonly CommandDef[];
  /** Motivo si se está usando el catálogo de reserva. */
  error: string | null;
  /** Lista viva de la sesión (puente v2): un comando ausente es desconocido. */
  live: boolean;
}

const FALLBACK: CommandCatalog = { commands: FALLBACK_COMMANDS, error: null, live: false };
/** Catálogo vacío de una sesión de motor: sus comandos llegan del motor (`sesiones://commands`). */
const ENGINE_EMPTY: CommandCatalog = { commands: [], error: null, live: true };

/**
 * Catálogo de la sesión: la lista viva del evento `sesiones://commands` si ha
 * llegado; si no, `sesiones_commands(cwd, id)` (viva con puente v2, estática sin
 * él) y, si falla, la reserva local con el motivo.
 */
/**
 * Catálogo de la paleta. `engine`: sesión de motor, cuyo catálogo son solo los comandos
 * del motor (sin el de reserva de Claude ni los de Sessions, que irían al motor como texto).
 */
export function useCommands(api: SesionesApi, cwd: string, id: SessionId, bridgeProtocol: number, enabled: boolean, engine = false): CommandCatalog {
  const pushed = useSession(id).commands;
  const empty = engine ? ENGINE_EMPTY : FALLBACK;
  const [state, setState] = useState<CommandCatalog>(empty);
  const key = `${cwd}|${id}|${bridgeProtocol}`;
  useEffect(() => {
    if (!enabled || !cwd || pushed) return;
    if (!commandCache.has(key)) commandCache.set(key, api.commands(cwd, id));
    let alive = true;
    commandCache
      .get(key)
      ?.then((commands) => alive && setState(commands.length ? { commands, error: null, live: engine || bridgeProtocol >= 2 } : empty))
      .catch((e: unknown) => {
        commandCache.delete(key);
        if (alive) setState({ ...empty, error: engine ? `Sin comandos del motor: ${String(e)}` : `Catálogo de reserva: ${String(e)}` });
      });
    return () => {
      alive = false;
    };
  }, [api, cwd, id, key, bridgeProtocol, enabled, pushed, engine, empty]);
  return useMemo(() => {
    const base = pushed && pushed.length > 0 ? { commands: pushed, error: null, live: true } : state;
    return engine ? base : { ...base, commands: withSessionCommands(base.commands) };
  }, [pushed, state, engine]);
}
