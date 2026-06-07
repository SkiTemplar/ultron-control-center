// Control Center — Memory tab shell (FRENTE 5, MEMORY KERNEL).
//
// Wraps the two memory surfaces under one tab with sub-tabs:
//   - Inbox   : <MemoryInbox/>   — candidates awaiting validation + health.
//   - Browser : <MemoryBrowser/> — curate already-governed memories.
//
// The Sidebar still routes to a single `memory` tab; this component owns the
// inner Inbox|Browser switch. Black, minimal, hard-edge — colours from
// var(--color-*), no emojis (matches the rest of the Control Center).

import { useState } from "react";
import { MemoryInbox } from "./MemoryInbox";
import { MemoryBrowser } from "./MemoryBrowser";

type SubTab = "inbox" | "browser";

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "browser", label: "Browser" },
];

export function MemoryTab() {
  const [sub, setSub] = useState<SubTab>("inbox");

  return (
    <div className="flex h-full flex-col">
      {/* Sub-tab switcher */}
      <div
        className="flex shrink-0 items-center gap-1 px-5 pt-4"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        {SUB_TABS.map((t) => {
          const active = sub === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSub(t.id)}
              className="px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              style={{
                color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
                borderBottom: `2px solid ${active ? "var(--color-accent)" : "transparent"}`,
                marginBottom: "-1px",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Active surface */}
      <div className="min-h-0 flex-1">
        {sub === "inbox" ? <MemoryInbox /> : <MemoryBrowser />}
      </div>
    </div>
  );
}
