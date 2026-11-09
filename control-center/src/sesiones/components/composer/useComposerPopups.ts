// Contenido de los menús en línea del composer: paleta `/` (con las
// recomendaciones según contexto, git y tests), `@` ficheros, el menú de
// argumentos de los comandos de Sessions y la búsqueda Ctrl+R en el historial.

import { useEffect, useMemo, useState } from "react";
import { useAutoReview } from "../../auto-review";
import { reviewKey } from "../../auto-review-core";
import { useApi } from "../../context";
import { ENGINE_IDS, ENGINE_LABEL, cachedEngineModels, loadEngineModels } from "../../engines";
import { useLaunchProfiles } from "../../launch-profiles";
import { filterFiles } from "./commands";
import { searchHistory } from "./history";
import { buildPalette, recommendCommands, touchesTests } from "./palette";
import { argChoices, filterChoices } from "./session-commands";
import type { ComposerState } from "./useComposerState";

/** Modelos de Codex y Gemini para `/motor-modelo`: los cacheados y, al abrir el menú, la lista fresca. */
function useArgEngineModels(open: boolean) {
  const api = useApi();
  const [models, setModels] = useState(() => ({
    codex: cachedEngineModels("codex"),
    gemini: cachedEngineModels("gemini"),
    opencode: cachedEngineModels("opencode"),
  }));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    for (const engine of ENGINE_IDS) {
      loadEngineModels(api, engine).then(
        (list) => alive && setModels((m) => ({ ...m, [engine]: list })),
        (e: unknown) => alive && setError(`${ENGINE_LABEL[engine]}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    return () => {
      alive = false;
    };
  }, [api, open]);
  return { models, error };
}

/** Paleta `/`: secciones (recomendados primero) y su lista plana para la navegación. */
function useSlashPalette(s: ComposerState) {
  const { trigger, catalog, git } = s;
  const changes = git.snapshot?.changes;
  const status = s.live.status;
  const recos = useMemo(() => recommendCommands({
    contextPct: status && status.contextWindow > 0 ? (status.contextTokens / status.contextWindow) * 100 : null,
    gitDirty: Boolean(git.snapshot?.state.dirty),
    testsTouched: touchesTests((changes ?? []).map((c) => c.path)),
  }, catalog.commands), [status, git.snapshot, changes, catalog.commands]);
  const sections = useMemo(() => (trigger?.kind === "slash" ? buildPalette(catalog.commands, recos, trigger.query) : []), [trigger, catalog.commands, recos]);
  const flat = useMemo(() => sections.flatMap((x) => x.items), [sections]);
  return { sections, flat };
}

export function useComposerPopups(s: ComposerState) {
  const { trigger, info, files, search, history } = s;
  const { sections, flat } = useSlashPalette(s);
  const fileItems = useMemo(() => (trigger?.kind === "at" ? filterFiles(files.list, trigger.query) : []), [trigger, files.list]);
  const autoReviewOn = useAutoReview(info ? reviewKey(info) : null);
  const profiles = useLaunchProfiles().profiles;
  const argModels = useArgEngineModels(trigger?.kind === "arg" && trigger.command === "motor-modelo");
  const argItems = useMemo(() => {
    if (trigger?.kind !== "arg") return [];
    const choices = argChoices(trigger.command, { autoReviewOn, profiles, engineModels: argModels.models }) ?? [];
    return filterChoices(choices, trigger.query);
  }, [trigger, autoReviewOn, profiles, argModels.models]);
  const popupCount = trigger?.kind === "slash" ? flat.length : trigger?.kind === "arg" ? argItems.length : fileItems.length;
  const results = useMemo(() => (search ? searchHistory(history.entries, search.query) : []), [search, history.entries]);
  return { sections, flat, fileItems, argItems, argModels, popupCount, results };
}

export type ComposerPopups = ReturnType<typeof useComposerPopups>;
