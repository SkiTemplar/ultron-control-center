import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SkillInfo, SkillState } from "../types";

// ---------------------------------------------------------------------------
// State styling
// ---------------------------------------------------------------------------

type StateKey = "active" | "plugin" | "vaulted";

function stateBadge(s: SkillState): { color: string; bg: string; label: string } {
  switch (s) {
    case "active":
      return {
        color: "var(--color-success)",
        bg: "rgba(63, 185, 80, 0.08)",
        label: "active",
      };
    case "plugin":
      return {
        color: "var(--color-text-secondary)",
        bg: "var(--color-surface-3)",
        label: "plugin",
      };
    case "vaulted":
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: "vault",
      };
    default:
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: String(s),
      };
  }
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function Row({
  s,
  selected,
  onClick,
}: {
  s: SkillInfo;
  selected: boolean;
  onClick: () => void;
}) {
  const b = stateBadge(s.state);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-baseline gap-3 rounded px-3 py-2 text-left transition-colors"
      style={{
        background: selected ? "var(--color-surface-3)" : "transparent",
        border: `1px solid ${selected ? "var(--color-border-strong)" : "transparent"}`,
      }}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background =
            "var(--color-surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <span
        className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide tabular-nums"
        style={{ background: b.bg, color: b.color, minWidth: 56, textAlign: "center" }}
      >
        {b.label}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[12.5px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {s.name}
        </div>
        {s.description && (
          <div
            className="truncate text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {s.description}
          </div>
        )}
      </div>
      {s.usage_count > 0 && (
        <span
          className="shrink-0 tabular-nums text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
          title={`Used ${s.usage_count} times`}
        >
          ×{s.usage_count}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Filter pill
// ---------------------------------------------------------------------------

function Pill({
  active,
  label,
  count,
  onClick,
  color,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] transition-colors"
      style={{
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      {color && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: color, opacity: active ? 1 : 0.4 }}
        />
      )}
      <span>{label}</span>
      <span
        className="tabular-nums"
        style={{ color: active ? "var(--color-text-secondary)" : "var(--color-text-faint)" }}
      >
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

function Preview({ skill }: { skill: SkillInfo }) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent("");
    invoke<string>("read_skill_md", { name: skill.name })
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skill.name]);

  const b = stateBadge(skill.state);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header
        className="border-b px-5 py-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
            style={{ background: b.bg, color: b.color }}
          >
            {b.label}
          </span>
          <h2 className="text-[15px] font-semibold leading-none">{skill.name}</h2>
        </div>
        {skill.description && (
          <p
            className="mt-2 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {skill.description}
          </p>
        )}
        {skill.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {skill.tags.map((t) => (
              <span
                key={t}
                className="rounded px-1.5 py-px text-[10px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        )}
        {skill.path && (
          <div
            className="mt-2 truncate text-[10.5px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
            title={skill.path}
          >
            {skill.path}
          </div>
        )}
      </header>
      <div className="flex-1 overflow-auto px-5 py-4">
        {loading && (
          <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Loading SKILL.md…
          </div>
        )}
        {error && (
          <div
            className="rounded p-3 text-[12px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}
        {!loading && !error && (
          <pre
            className="whitespace-pre-wrap text-[11.5px] leading-relaxed"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-secondary)",
            }}
          >
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const STATE_FILTERS: StateKey[] = ["active", "plugin", "vaulted"];

export function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [states, setStates] = useState<Set<StateKey>>(() => new Set(["active", "plugin"]));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    invoke<SkillInfo[]>("list_skills")
      .then((list) => {
        setSkills(list);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const counts = useMemo(() => {
    const c: Record<StateKey, number> = { active: 0, plugin: 0, vaulted: 0 };
    for (const s of skills) {
      if (s.state in c) c[s.state as StateKey] += 1;
    }
    return c;
  }, [skills]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills
      .filter((s) => states.has(s.state as StateKey))
      .filter((s) => {
        if (!q) return true;
        if (s.name.toLowerCase().includes(q)) return true;
        if ((s.description ?? "").toLowerCase().includes(q)) return true;
        if (s.tags.some((t) => t.toLowerCase().includes(q))) return true;
        return false;
      })
      .sort((a, b) => {
        // active first, then plugin, then vaulted, then by name
        const order = { active: 0, plugin: 1, vaulted: 2 } as Record<string, number>;
        const oa = order[a.state] ?? 3;
        const ob = order[b.state] ?? 3;
        if (oa !== ob) return oa - ob;
        return a.name.localeCompare(b.name);
      });
  }, [skills, states, query]);

  const selectedSkill = useMemo(
    () => skills.find((s) => s.name === selected) ?? null,
    [skills, selected],
  );

  function toggleState(k: StateKey) {
    const next = new Set(states);
    if (next.has(k)) {
      if (next.size > 1) next.delete(k);
    } else {
      next.add(k);
    }
    setStates(next);
  }

  return (
    <div className="flex h-full">
      {/* Left: list */}
      <div className="flex w-[44%] min-w-[420px] flex-col overflow-hidden border-r" style={{ borderColor: "var(--color-border)" }}>
        <header
          className="border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h1 className="text-[18px] font-semibold leading-tight">Skills</h1>
          <p className="mt-1 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
            {skills.length} total · {filtered.length} shown
          </p>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <Pill
              label="Active"
              count={counts.active}
              color="var(--color-success)"
              active={states.has("active")}
              onClick={() => toggleState("active")}
            />
            <Pill
              label="Plugin"
              count={counts.plugin}
              color="var(--color-text-secondary)"
              active={states.has("plugin")}
              onClick={() => toggleState("plugin")}
            />
            <Pill
              label="Vault"
              count={counts.vaulted}
              color="var(--color-text-tertiary)"
              active={states.has("vaulted")}
              onClick={() => toggleState("vaulted")}
            />
          </div>

          <input
            type="text"
            placeholder="Search by name, description, tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mt-3 w-full rounded px-3 py-1.5 text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
            }}
          />
        </header>

        <div className="flex-1 overflow-auto px-2 py-2">
          {loading && (
            <div className="px-3 py-4 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              Loading…
            </div>
          )}
          {error && (
            <div
              className="m-2 rounded p-3 text-[12px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
              }}
            >
              {error}
            </div>
          )}
          {!loading && filtered.length === 0 && skills.length > 0 && (
            <div className="px-3 py-4 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              No skills match the current filters.
            </div>
          )}
          <div className="space-y-px">
            {filtered.map((s) => (
              <Row
                key={s.name}
                s={s}
                selected={selected === s.name}
                onClick={() => setSelected(s.name)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Right: preview */}
      <div className="flex-1 overflow-hidden">
        {selectedSkill ? (
          <Preview skill={selectedSkill} />
        ) : (
          <div
            className="flex h-full items-center justify-center text-[13px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Select a skill to preview its SKILL.md
          </div>
        )}
      </div>
    </div>
  );
}
