// Estado de la tarjeta CodeGraph de ProjectWorkspace: si hay índice, su
// resumen y el indexado. Ningún fallo se traga (mandamiento 11): un error al
// comprobar el índice no se confunde con «sin índice» (eso invitaba a
// reindexar un proyecto ya indexado) y un error del resumen se enseña.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetchCodeGraphSummary, type CodeGraphSummary } from "../../../lib/codegraph";

export type CodeGraphCard = {
  /** null mientras se comprueba; "error" si la comprobación falló. */
  indexed: boolean | null | "error";
  summary: CodeGraphSummary | null;
  /** Motivo del último fallo (comprobación, resumen o indexado). */
  error: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  init: () => Promise<void>;
};

type Loaded = Pick<CodeGraphCard, "indexed" | "summary" | "error">;

/** Comprueba el índice y, si existe, lee el resumen. Nunca lanza. */
async function load(path: string): Promise<Loaded> {
  let indexed: boolean;
  try {
    indexed = await invoke<boolean>("codegraph_is_indexed", { path });
  } catch (e) {
    return { indexed: "error", summary: null, error: `No se pudo comprobar el índice: ${String(e)}` };
  }
  if (!indexed) return { indexed: false, summary: null, error: null };
  try {
    return { indexed: true, summary: await fetchCodeGraphSummary(path), error: null };
  } catch (e) {
    return { indexed: true, summary: null, error: `No se pudo leer el resumen del índice: ${String(e)}` };
  }
}

export function useCodeGraphCard(path: string | null): CodeGraphCard {
  const [state, setState] = useState<Loaded>({ indexed: null, summary: null, error: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState({ indexed: null, summary: null, error: null });
    void load(path).then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const refresh = useCallback(async () => {
    if (!path) return;
    setState(await load(path));
  }, [path]);

  const init = useCallback(async () => {
    if (!path || busy) return;
    setBusy(true);
    try {
      await invoke("codegraph_init_project", { path });
      // Se comprueba el índice de verdad: un `init` que sale con 0 sin crear
      // codegraph.db no puede pintar la tarjeta como indexada.
      const loaded = await load(path);
      setState(
        loaded.indexed === false
          ? { ...loaded, error: "CodeGraph terminó sin crear .codegraph/codegraph.db en este proyecto" }
          : loaded,
      );
    } catch (e) {
      setState((s) => ({ ...s, error: `No se pudo indexar con CodeGraph: ${String(e)}` }));
    } finally {
      setBusy(false);
    }
  }, [path, busy]);

  return { ...state, busy, refresh, init };
}

const DATE_FMT = new Intl.DateTimeFormat("es-ES", { dateStyle: "short", timeStyle: "short" });

/** Subtítulo de la tarjeta. */
export function codeGraphSubtitle(card: CodeGraphCard, noPath: boolean): string {
  if (noPath) return "Sin carpeta asignada";
  if (card.busy) return "Indexando…";
  if (card.indexed === "error") return "Error al comprobar el índice: clic para reintentar";
  if (card.indexed === null) return "Verificando índice…";
  if (!card.indexed) return "Sin índice: clic para indexar";
  if (!card.summary) return card.error ? "Indexado · resumen no disponible" : "Indexado";
  const s = card.summary;
  return `${s.files} archivos · ${s.nodes} símbolos · ${s.edges} aristas`;
}

/** Tooltip de la tarjeta: acción, lenguajes y frescura del índice. */
export function codeGraphTooltip(card: CodeGraphCard): string {
  if (card.indexed === "error") return card.error ?? "Reintentar la comprobación del índice";
  if (!card.indexed) return "Indexar este proyecto con codegraph init";
  const parts = ["Abrir el visor del grafo de código"];
  const s = card.summary;
  if (s && s.languages.length > 0) {
    parts.push(`Lenguajes: ${s.languages.map(([lang, n]) => `${lang} (${n})`).join(", ")}`);
  }
  if (s?.last_indexed_at) parts.push(`Última indexación: ${DATE_FMT.format(new Date(s.last_indexed_at))}`);
  if (card.error) parts.push(card.error);
  return parts.join("\n");
}
