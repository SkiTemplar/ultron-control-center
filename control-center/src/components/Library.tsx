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
import { Tones } from "./library/Tones";
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
  | "commands"
  | "tones";

type SubTabSpec = {
  id: LibrarySubTab;
  label: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  hint: string;
};

// v2.6.1: primero el inventario instalado (skills, agentes, reglas,
// plugins, hooks), luego la introspección en vivo (comandos) y al final el
// descubrimiento (catálogo), que es para buscar algo nuevo y no el uso diario.
const SUB_TABS: SubTabSpec[] = [
  {
    id: "skills",
    label: "Skills",
    Icon: Sparkle,
    hint: "Skills instaladas en los ámbitos global, de proyecto y de plugin.",
  },
  {
    id: "agents",
    label: "Agentes",
    Icon: Bot,
    hint: "Subagentes a los que Claude Code puede delegar.",
  },
  {
    id: "rules",
    label: "Reglas",
    Icon: BookOpen,
    hint: "Normas y patrones de código de ~/.claude/rules/.",
  },
  {
    // v2.6 (card-v26-fb-021): los plugins pasaron de Ajustes a Biblioteca para
    // gestionar en una sola pestaña todo lo que puede hacer Claude Code.
    id: "plugins",
    label: "Plugins",
    Icon: Folder,
    hint: "Paquetes de plugins instalados (skills, agentes, hooks y MCP).",
  },
  {
    // v2.6: los hooks pasaron de Sistema a Biblioteca: son un concepto de
    // Claude Code, no del sistema operativo.
    id: "hooks",
    label: "Hooks",
    Icon: Bot,
    hint: "Scripts de hooks (PreToolUse, PostToolUse, Stop…) de tus ajustes y plugins.",
  },
  {
    id: "commands",
    label: "Comandos",
    Icon: Terminal,
    hint: "Todos los /slash commands que exponen tus plugins instalados.",
  },
  {
    // Personalities v1 (2026-08-13): tonos del chat visibles/editables +
    // playground de detección (misma detección que corre en el orchestrate).
    id: "tones",
    label: "Tonos",
    Icon: Sparkle,
    hint: "Tonos del chat (personalidades): edita sus señales de detección y prueba qué tono activa un prompt.",
  },
  {
    id: "catalog",
    label: "Catálogo",
    Icon: Compass,
    hint: "Descubre selecciones y busca en GitHub skills, agentes y servidores MCP nuevos.",
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
            <h2 className="text-[15px] font-semibold">Biblioteca</h2>
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
          aria-label="Secciones de la biblioteca"
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
        {sub === "tones" && <Tones />}
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
