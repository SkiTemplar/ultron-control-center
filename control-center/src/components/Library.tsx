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
import { PluginsSection } from "./Settings/PluginsSection";
import { Hooks } from "./Hooks";
import { Sparkle, Bot, BookOpen, Compass, Terminal, Folder } from "./library/icons";

export type LibrarySubTab =
  | "skills"
  | "agents"
  | "rules"
  | "plugins"
  | "hooks"
  | "catalog"
  | "commands";

type SubTabSpec = {
  id: LibrarySubTab;
  label: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  hint: string;
};

// v2.6.1: ordered so the "installed" inventory comes first
// (skills/agents/rules/plugins/hooks), then the live introspection
// tab (commands), and finally the outward-facing discovery tab (catalog).
// Catalog moved to the very end per USER's request — it's the entry
// point for "find me something new", not the daily-driver view.
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
    // v2.6 (card-v26-fb-021): Plugins moved from Settings to Library so the
    // user manages the whole "what Claude Code can do" inventory in one tab.
    id: "plugins",
    label: "Plugins",
    Icon: Folder,
    hint: "Installed plugin bundles (skills + agents + hooks + MCPs).",
  },
  {
    // v2.6: Hooks moved from System tab → Library — it's a Claude-side
    // concept, not an OS-level one.
    id: "hooks",
    label: "Hooks",
    Icon: Bot,
    hint: "PreToolUse / PostToolUse / Stop hook scripts from your settings + plugins.",
  },
  {
    id: "commands",
    label: "Commands",
    Icon: Terminal,
    hint: "Every /slash command exposed by your installed plugins.",
  },
  {
    id: "catalog",
    label: "Catalog",
    Icon: Compass,
    hint: "Discover curated picks + search GitHub for new skills, agents and MCP servers.",
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
        {sub === "plugins" && (
          <div className="h-full overflow-auto px-6 py-4">
            <PluginsSection />
          </div>
        )}
        {sub === "hooks" && <Hooks />}
      </div>
    </div>
  );
}

export default Library;
