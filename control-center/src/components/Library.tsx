// Library tab — unified shell for Skills, Agents, Rules and the curated
// Catalog. Replaces the v2.0 trio of standalone sidebar entries with a
// single tab that hosts four sub-tabs. Each sub-tab still renders the
// pre-existing component (Skills/Agents/Rules) so the behaviour and
// Tauri backend wiring stays unchanged — only the chrome around them is
// new.

import { useEffect, useState } from "react";
import { Skills } from "./Skills";
import { Agents } from "./Agents";
import { Rules } from "./Rules";
import { Catalog } from "./library/Catalog";
import { Commands } from "./library/Commands";
import { Sparkle, Bot, BookOpen, Compass, Terminal } from "./library/icons";

export type LibrarySubTab =
  | "skills"
  | "agents"
  | "rules"
  | "catalog"
  | "commands";

type SubTabSpec = {
  id: LibrarySubTab;
  label: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  hint: string;
};

const SUB_TABS: SubTabSpec[] = [
  {
    id: "skills",
    label: "Skills",
    Icon: Sparkle,
    hint: "Installed skills from global, project and plugin scopes.",
  },
  {
    id: "agents",
    label: "Agents",
    Icon: Bot,
    hint: "Subagents Claude Code can dispatch to.",
  },
  {
    id: "rules",
    label: "Rules",
    Icon: BookOpen,
    hint: "Coding standards and patterns from ~/.claude/rules/.",
  },
  {
    id: "catalog",
    label: "Catalog",
    Icon: Compass,
    hint: "Curated picks for graphics, UE5, AI, and MCP work.",
  },
  {
    id: "commands",
    label: "Commands",
    Icon: Terminal,
    hint: "Every /slash command exposed by your installed plugins.",
  },
];

const STORAGE_KEY = "control-center.library.sub_tab.v1";

function loadInitial(initial?: LibrarySubTab): LibrarySubTab {
  if (initial) return initial;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUB_TABS.some((t) => t.id === stored)) {
      return stored as LibrarySubTab;
    }
  } catch {
    // ignored
  }
  return "skills";
}

export function Library({ initial }: { initial?: LibrarySubTab } = {}) {
  const [sub, setSub] = useState<LibrarySubTab>(() => loadInitial(initial));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, sub);
    } catch {
      // ignored
    }
  }, [sub]);

  const active = SUB_TABS.find((t) => t.id === sub) ?? SUB_TABS[0];

  return (
    <div className="flex h-full flex-col">
      <header
        className="border-b"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center justify-between gap-4 px-6 pt-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[15px] font-semibold">Library</h2>
            <span
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {active.hint}
            </span>
          </div>
        </div>
        <nav
          className="flex gap-1 px-6 pb-3 pt-3"
          role="tablist"
          aria-label="Library sub-sections"
        >
          {SUB_TABS.map(({ id, label, Icon }) => {
            const isActive = sub === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setSub(id)}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors"
                style={{
                  background: isActive
                    ? "var(--color-surface-3)"
                    : "transparent",
                  color: isActive
                    ? "var(--color-text)"
                    : "var(--color-text-secondary)",
                  border: `1px solid ${
                    isActive ? "var(--color-border-strong)" : "transparent"
                  }`,
                }}
              >
                <Icon size={13} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      </header>

      <div className="flex-1 overflow-hidden">
        {sub === "skills" && <Skills />}
        {sub === "agents" && <Agents />}
        {sub === "rules" && <Rules />}
        {sub === "catalog" && <Catalog />}
        {sub === "commands" && <Commands />}
      </div>
    </div>
  );
}

export default Library;
