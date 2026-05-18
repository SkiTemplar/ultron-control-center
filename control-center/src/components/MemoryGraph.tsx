// Backward-compatibility shim.
//
// The original MemoryGraph was a deterministic-hash pseudo-UMAP scatter
// — user flagged it as visually noisy and not useful ("muy
// desordenado, no aporta tanto"). It's been replaced by MemoryGraphForce,
// an Obsidian-style force-directed graph driven by wikilinks (with a
// tag-similarity fallback when the vault has zero wikilinks).
//
// This file is kept so any external import path (`./MemoryGraph`,
// imports of the `MemoryPoint` type, etc.) keeps working. The default
// `<MemoryGraph />` element now renders the force-directed graph.

import { MemoryGraphForce } from "./MemoryGraphForce";

// Legacy type — preserved for any consumer that still imports it.
// The new graph backend uses GraphNode/GraphEdge inside MemoryGraphForce;
// this type is no longer produced by any tauri command after the
// rewrite, but exporting it keeps `import type { MemoryPoint }` callers
// compiling.
export type MemoryPoint = {
  id: string;
  x: number;
  y: number;
  category: string;
  title: string;
  snippet: string;
  timestamp: string;
  path: string;
};

export function MemoryGraph() {
  return <MemoryGraphForce />;
}
