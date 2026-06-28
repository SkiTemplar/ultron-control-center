// Agent usage stats strip — pinned above the agent grid.
//
// Shows aggregated invocation counts from subagent-harvest.jsonl via the
// agent_usage_stats Tauri command. Gemela visual de DelegationsStrip.
//
// HONESTY (mandamiento 13): generic orchestration wrappers
// (workflow-subagent, general-purpose, unknown) are NOT real specialists —
// they are shown separately, visually dimmed, with an explicit label so the
// user is never misled about actual specialist usage.

import { useState } from "react";
import type { AgentUsage } from "./types";
import { AGENT_ACCENT_SOFT } from "./types";

interface AgentUsageStripProps {
  usage: AgentUsage[];
  /** Honest scope qualifier for the header — the parent aggregates all projects. */
  scopeLabel?: string;
}

/** Agents that are orchestration wrappers, not named specialists. */
const GENERIC_AGENT_NAMES = new Set([
  "workflow-subagent",
  "general-purpose",
  "unknown",
]);

function isGeneric(agent: string): boolean {
  return GENERIC_AGENT_NAMES.has(agent.toLowerCase());
}

function fmtChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function ageFromIso(iso: string): string {
  if (!iso) return "–";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "–";
  const s = ms / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface UsageCardProps {
  entry: AgentUsage;
  dimmed: boolean;
}

function UsageCard({ entry, dimmed }: UsageCardProps) {
  return (
    <li
      className="flex flex-col gap-1 rounded-md p-2 text-xs"
      style={{
        border: `1px solid ${dimmed ? "var(--color-border)" : "var(--color-border-strong)"}`,
        background: dimmed ? "var(--color-surface-1)" : AGENT_ACCENT_SOFT,
        opacity: dimmed ? 0.65 : 1,
      }}
    >
      <div className="flex items-center justify-between gap-1.5">
        <span
          className="truncate font-medium"
          style={{ color: dimmed ? "var(--color-text-secondary)" : "var(--color-text)" }}
        >
          {entry.agent}
        </span>
        <span
          className="shrink-0 rounded px-1.5 py-px text-[10px] font-semibold tabular-nums"
          style={{
            background: "rgba(167, 139, 250, 0.18)",
            color: "rgb(167, 139, 250)",
          }}
        >
          {entry.count}x
        </span>
      </div>
      <div
        className="flex items-center gap-2 text-[10px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <span title="Total chars output">{fmtChars(entry.chars)} chars</span>
        <span aria-hidden>·</span>
        <span title="Last finished (SubagentStop)">{ageFromIso(entry.lastTs)}</span>
      </div>
      {entry.topLabels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.topLabels.slice(0, 3).map((lc) => (
            <span
              key={lc.label}
              className="rounded px-1 py-px text-[9px]"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
              }}
              title={`${lc.n} calls with label "${lc.label}"`}
            >
              {lc.label}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

export function AgentUsageStrip({ usage, scopeLabel = "all projects" }: AgentUsageStripProps) {
  const [showAllSpecialists, setShowAllSpecialists] = useState(false);
  const [showGenerics, setShowGenerics] = useState(false);

  if (usage.length === 0) return null;

  const specialists = usage.filter((u) => !isGeneric(u.agent));
  const generics = usage.filter((u) => isGeneric(u.agent));

  const visibleSpecialists = showAllSpecialists
    ? specialists
    : specialists.slice(0, 6);

  const genericTotal = generics.reduce((s, g) => s + g.count, 0);

  return (
    <section className="mb-4">
      <div className="mb-1.5 flex items-center justify-between">
        <span
          className="text-[11px] uppercase tracking-wide"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Agent usage · {scopeLabel} ({usage.length} type
          {usage.length !== 1 ? "s" : ""})
        </span>
        {specialists.length > 6 && (
          <button
            type="button"
            onClick={() => setShowAllSpecialists((v) => !v)}
            className="text-[11px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {showAllSpecialists
              ? "Show fewer"
              : `Show all ${specialists.length}`}
          </button>
        )}
      </div>

      {/* Named specialists — highlighted */}
      {specialists.length > 0 && (
        <ul className="mb-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {visibleSpecialists.map((u) => (
            <UsageCard key={u.agent} entry={u} dimmed={false} />
          ))}
        </ul>
      )}

      {/* Generic wrappers — dimmed + collapsed by default */}
      {generics.length > 0 && (
        <div>
          <button
            type="button"
            className="mb-1 flex items-center gap-1 text-[10px]"
            style={{ color: "var(--color-text-tertiary)" }}
            onClick={() => setShowGenerics((v) => !v)}
            title="Orchestration wrappers or session captures without named agent attribution. Not real specialists."
          >
            <span aria-hidden>{showGenerics ? "▾" : "▸"}</span>
            <span>
              {genericTotal} call{genericTotal !== 1 ? "s" : ""} via generics /{" "}
              unattributed ({generics.length} type
              {generics.length !== 1 ? "s" : ""}) — orchestration wrappers, not
              specialists
            </span>
          </button>
          {showGenerics && (
            <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {generics.map((u) => (
                <UsageCard key={u.agent} entry={u} dimmed />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
