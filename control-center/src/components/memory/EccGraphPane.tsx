// EccGraphPane — read-only ECC entity graph browser.
// Extracted from Memory.tsx (1151 L) as part of the P1 split refactor.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { EccMemorySnapshot } from "./memoryTypes";

export function EccGraphPane() {
  const [snapshot, setSnapshot] = useState<EccMemorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const snap = (await invoke("ecc_memory_read")) as EccMemorySnapshot;
        if (!cancelled) { setSnapshot(snap); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void tick();
    const id = setInterval(tick, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const filtered = useMemo(() => {
    if (!snapshot) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return snapshot.entities;
    return snapshot.entities.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.entity_type.toLowerCase().includes(needle) ||
        e.observations.some((o) => o.toLowerCase().includes(needle)),
    );
  }, [snapshot, filter]);

  if (!snapshot) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
        {error ?? "Loading ECC graph…"}
      </div>
    );
  }

  if (!snapshot.source_path) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
        <p className="mb-2 font-medium">ECC memory storage not detected</p>
        <p className="text-[var(--color-text-tertiary)]">
          Run a Claude Code session that calls the memory MCP to bootstrap the JSONL.
        </p>
      </div>
    );
  }

  return (
    <section className="flex h-full flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">ECC graph · read-only</h3>
        <button
          onClick={() => openPath(snapshot.source_path!).catch(() => {})}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
        >
          Open JSONL
        </button>
      </div>
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter entities…"
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <div className="flex-1 overflow-y-auto">
        <ul className="space-y-1 text-xs">
          {filtered.map((e) => (
            <li key={e.name} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">{e.name}</span>
                <span className="text-[var(--color-text-tertiary)]">
                  {e.entity_type} · {e.observations.length} obs
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
