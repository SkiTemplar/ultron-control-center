// Memory — orchestrator with tab navigation.
// Sub-panes extracted to src/components/memory/ as part of the P1 split refactor.

import { useState } from "react";
import { MemoryBrain } from "./memory/MemoryBrain";
import { MemoryTree } from "./memory/MemoryTree";
import { MemoryStatusCards } from "./memory/MemoryStatusCards";
import { Mem0Diagnostics } from "./memory/Mem0Diagnostics";
import { GraphifyControls } from "./memory/GraphifyControls";
import { Mem0Pane } from "./memory/Mem0Pane";
import { EccGraphPane } from "./memory/EccGraphPane";
import { KgEditorPane } from "./memory/KgEditorPane";
import type { MemoryViewMode } from "./memory/memoryTypes";

export function Memory() {
  const [mode, setMode] = useState<MemoryViewMode>("tree");

  const tabBtn = (target: MemoryViewMode, label: string) => {
    const active = mode === target;
    return (
      <button
        key={target}
        onClick={() => setMode(target)}
        className={
          active
            ? "rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)]"
            : "rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
        }
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Memory</h2>
        <div className="flex flex-wrap gap-2">
          {tabBtn("tree", "Knowledge tree")}
          {tabBtn("status", "Live status")}
          {tabBtn("brain", "Brain")}
          {tabBtn("kg", "KG editor")}
          {tabBtn("mem0", "Mem0 browse")}
          {tabBtn("ecc", "ECC graph")}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "tree" && <MemoryTree />}
        {mode === "status" && (
          <div className="h-full overflow-y-auto">
            <div className="flex flex-col gap-4 p-1">
              <MemoryStatusCards />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Mem0Diagnostics />
                <GraphifyControls />
              </div>
            </div>
          </div>
        )}
        {mode === "brain" && <MemoryBrain />}
        {mode === "mem0" && <Mem0Pane />}
        {mode === "ecc" && <EccGraphPane />}
        {mode === "kg" && <KgEditorPane />}
      </div>
    </div>
  );
}

export default Memory;
