// Grid of AgentCard items — same 140px tall card pattern as Skills/Rules, violet accent.

import type { AgentEntry } from "../../types";
import { AgentCard } from "./AgentCard";

interface AgentCardGridProps {
  items: AgentEntry[];
  selected: AgentEntry | null;
  selectMode: boolean;
  checked: Set<string>;
  onSelect: (a: AgentEntry) => void;
  onToggleChecked: (name: string) => void;
}

export function AgentCardGrid({
  items,
  selected,
  selectMode,
  checked,
  onSelect,
  onToggleChecked,
}: AgentCardGridProps) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
    >
      {items.map((a) => (
        <AgentCard
          key={`${a.origin}-${a.path}`}
          agent={a}
          isActive={selected?.path === a.path}
          selectMode={selectMode}
          isChecked={checked.has(a.name)}
          onSelect={onSelect}
          onToggleChecked={onToggleChecked}
        />
      ))}
    </div>
  );
}
