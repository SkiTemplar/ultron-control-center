// Estado del visor CodeGraph: lista de ficheros y módulos, búsqueda, grafo
// visible (unión de vecindarios) y nodo seleccionado. Cada petición lleva su
// número de secuencia: si llegan dos respuestas, manda la de la última
// petición, nunca la más lenta.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_VIEW,
  fetchCodeGraphFiles,
  fetchNeighborhood,
  mergeNeighborhood,
  searchCodeGraph,
  viewFromNeighborhood,
  type CgFileList,
  type CgNode,
  type CgView,
} from "../../../lib/codegraph";

export type Viewer = {
  files: CgFileList | null;
  filesError: string | null;
  results: CgNode[] | null;
  view: CgView;
  selected: CgNode | null;
  depth: number;
  busy: boolean;
  error: string | null;
  setDepth: (depth: number) => void;
  search: (query: string) => Promise<void>;
  /** Grafo nuevo centrado en `nodeId` (desde la búsqueda o un fichero). */
  open: (nodeId: string) => Promise<void>;
  /** Clic en un nodo del grafo: lo selecciona y añade su vecindario. */
  expand: (node: CgNode) => Promise<void>;
};

const describe = (action: string, e: unknown) => `No se pudo ${action}: ${String(e)}`;

export function useCodeGraphViewer(path: string): Viewer {
  const [files, setFiles] = useState<CgFileList | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [results, setResults] = useState<CgNode[] | null>(null);
  const [view, setView] = useState<CgView>(EMPTY_VIEW);
  const [selected, setSelected] = useState<CgNode | null>(null);
  const [depth, setDepth] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const graphSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setFilesError(null);
    fetchCodeGraphFiles(path)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFilesError(describe("leer la lista de ficheros del índice", e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const search = useCallback(
    async (query: string) => {
      const q = query.trim();
      const mine = ++searchSeq.current;
      if (!q) {
        setResults(null);
        return;
      }
      setError(null);
      try {
        const hits = await searchCodeGraph(path, q);
        if (searchSeq.current === mine) setResults(hits);
      } catch (e) {
        if (searchSeq.current === mine) setError(describe("buscar en el índice", e));
      }
    },
    [path],
  );

  /** Pide un vecindario y lo aplica con `apply` si sigue siendo la última petición. */
  const loadGraph = useCallback(
    async (nodeId: string, apply: (hood: Awaited<ReturnType<typeof fetchNeighborhood>>) => void) => {
      const mine = ++graphSeq.current;
      setBusy(true);
      setError(null);
      try {
        const hood = await fetchNeighborhood(path, nodeId, depth);
        if (graphSeq.current === mine) apply(hood);
      } catch (e) {
        if (graphSeq.current === mine) setError(describe("leer el vecindario del símbolo", e));
      } finally {
        if (graphSeq.current === mine) setBusy(false);
      }
    },
    [path, depth],
  );

  const open = useCallback(
    (nodeId: string) =>
      loadGraph(nodeId, (hood) => {
        setView(viewFromNeighborhood(hood));
        setSelected(hood.nodes.find((n) => n.id === hood.center) ?? null);
      }),
    [loadGraph],
  );

  const expand = useCallback(
    (node: CgNode) => {
      setSelected(node);
      return loadGraph(node.id, (hood) => setView((current) => mergeNeighborhood(current, hood)));
    },
    [loadGraph],
  );

  return { files, filesError, results, view, selected, depth, busy, error, setDepth, search, open, expand };
}
