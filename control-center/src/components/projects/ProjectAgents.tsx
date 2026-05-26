// ULTRON Control Center 2.6 — Per-project Agents view
//
// v2.6 rewrite: clean two-section layout.
//   1. Agent Team — Library-style card grid (origin badge + description +
//      editable role badge + "Remove from project"). Empty state nudges the
//      user to add one with the picker below.
//   2. Workflows — predefined multi-agent recipe tiles (Chief of staff,
//      Backend review, Frontend review, Code audit). Each tile carries a
//      Beta pill until the orchestration backend lands.
//   3. "+ Add agent to project" opens an overlay picker with a category
//      sidebar (Personas, Rust, TypeScript / JS, Agent Frameworks, …) +
//      a filterable grid of agents. Categories come from
//      `lib/skill-categories.ts` so global skills and agents share the same
//      domain taxonomy.
//
// v2.6 (card-v26-fb-023): roles per pinned agent. The role string is stored
// alongside the `pinned[]` array in `~/.ultron/cockpit/projects/<id>/pinned-agents.json`
// under a `roles: { [agentName]: string }` map (backend
// `commands::agents::PinnedAgents`).
//
// v2.6 (card-v26-fb-024 follow-up): "AI configure team" + Launch all + role
// avatars + workflow tooltips. The AI flow uses a heuristic-first approach:
// load CLAUDE.md, scan for language/stack tokens, and propose a 3-7 agent
// team from the global catalogue. The user confirms before applying.
// Launch all spawns one Claude session per pinned agent, each scoped by the
// user's role assignment so different terminals get different framings.
//
// Backend wiring: `agents_pinned_load`, `agents_pinned_save`, `list_agents`,
// `kanban_load` / `kanban_save` for the default-agent select,
// `project_claude_md_load` for the AI-configure heuristics, `spawn_session`
// for per-agent terminal launch.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pin, PinOff, Plus, X } from "./icons";
import type { KanbanBoard } from "../../types";
import { categorize } from "../../lib/skill-categories";

type Props = { projectId: string; projectPath: string };

type AgentEntry = {
  name: string;
  path: string;
  description: string;
  origin: "global" | "project" | "plugin";
};

// Mirrors the backend `commands::agents::PinnedAgents` shape. `roles` is
// optional on the wire (older files were `{ pinned: [...] }` only) so we
// default to an empty object after loading.
type PinnedAgents = {
  pinned: string[];
  roles?: Record<string, string>;
};

type Workflow = {
  id: string;
  label: string;
  description: string;
  accent: string;
};

const WORKFLOWS: Workflow[] = [
  {
    id: "chief-of-staff",
    label: "Chief of staff",
    description:
      "Triage open cards, summarise pending work, and assign next actions across pinned agents.",
    accent: "var(--color-accent)",
  },
  {
    id: "backend-review",
    label: "Backend review",
    description:
      "Run a focused review on backend code: API surface, persistence, error handling.",
    accent: "#7aa2f7",
  },
  {
    id: "frontend-review",
    label: "Frontend review",
    description:
      "Audit UI: component structure, accessibility, design tokens, render perf.",
    accent: "#f7768e",
  },
  {
    id: "code-audit",
    label: "Code audit",
    description:
      "Repo-wide static audit: dead code, unused deps, secret leaks, lint debt.",
    accent: "#e0af68",
  },
];

const ALL_CATEGORIES = "__all__";
const NO_CATEGORY = "Uncategorized";

// ---------------------------------------------------------------------------
// Role → avatar emoji map. Keyword-matched against the role string the user
// typed (case-insensitive). First match wins. Defaults to a robot face so
// every card has SOMETHING visual even when the role is custom.
// ---------------------------------------------------------------------------
const ROLE_AVATAR_RULES: { keywords: string[]; emoji: string }[] = [
  { keywords: ["backend", "api", "server"], emoji: "🛠️" },
  { keywords: ["frontend", "ui", "ux", "design"], emoji: "🎨" },
  { keywords: ["test", "qa", "tdd"], emoji: "🧪" },
  { keywords: ["doc", "writer", "documentation"], emoji: "📚" },
  { keywords: ["security", "audit", "pentest"], emoji: "🔒" },
  { keywords: ["review", "reviewer", "critic"], emoji: "🔍" },
  { keywords: ["architect", "design", "system"], emoji: "🏛️" },
  { keywords: ["debug", "bug", "fix"], emoji: "🐛" },
  { keywords: ["devops", "deploy", "ci", "cd"], emoji: "🚀" },
  { keywords: ["data", "db", "database", "sql"], emoji: "🗄️" },
  { keywords: ["research", "explore", "investigat"], emoji: "🔬" },
  { keywords: ["chief", "lead", "manager", "pm"], emoji: "🎩" },
  { keywords: ["refactor", "clean"], emoji: "🧹" },
  { keywords: ["perf", "optim"], emoji: "⚡" },
];

function roleAvatar(role: string | undefined, agentName: string): string {
  const haystack = `${role ?? ""} ${agentName}`.toLowerCase();
  for (const rule of ROLE_AVATAR_RULES) {
    if (rule.keywords.some((k) => haystack.includes(k))) return rule.emoji;
  }
  return "🤖";
}

// ---------------------------------------------------------------------------
// Heuristic team proposal — no backend needed. Reads CLAUDE.md tokens to
// guess project language(s) and proposes a balanced team from the global
// agent list. The user confirms before applying.
// ---------------------------------------------------------------------------
type TeamProposal = {
  agent: AgentEntry;
  suggestedRole: string;
};

const LANGUAGE_TOKENS: { keyword: string; lang: string }[] = [
  { keyword: "rust", lang: "rust" },
  { keyword: "cargo", lang: "rust" },
  { keyword: "typescript", lang: "typescript" },
  { keyword: ".ts", lang: "typescript" },
  { keyword: "tsx", lang: "typescript" },
  { keyword: "next.js", lang: "typescript" },
  { keyword: "react", lang: "typescript" },
  { keyword: "tauri", lang: "rust" },
  { keyword: "python", lang: "python" },
  { keyword: ".py", lang: "python" },
  { keyword: "fastapi", lang: "python" },
  { keyword: "django", lang: "python" },
  { keyword: "go ", lang: "go" },
  { keyword: "golang", lang: "go" },
  { keyword: "c++", lang: "cpp" },
  { keyword: "cpp", lang: "cpp" },
  { keyword: "unreal", lang: "gamedev" },
  { keyword: "unity", lang: "gamedev" },
];

function detectLanguages(claudeMd: string): Set<string> {
  const found = new Set<string>();
  const hay = claudeMd.toLowerCase();
  for (const t of LANGUAGE_TOKENS) {
    if (hay.includes(t.keyword)) found.add(t.lang);
  }
  return found;
}

// Suggestion rules: each rule lists candidate agent slugs (in priority
// order) + a role. The first slug in `candidates` that exists in `agents`
// is picked. Defaults come first so every project gets a baseline team.
type TeamRule = {
  reason: string;
  role: string;
  candidates: string[];
};

const DEFAULT_RULES: TeamRule[] = [
  {
    reason: "Universal code reviewer",
    role: "Code reviewer",
    candidates: ["code-reviewer", "senior-engineer", "second-opinion"],
  },
  {
    reason: "Architecture decisions",
    role: "Architect",
    candidates: ["architect-reviewer", "hexagonal-architecture", "senior-engineer"],
  },
  {
    reason: "Bug hunting",
    role: "Debugger",
    candidates: ["debugger", "error-detective", "error-handling"],
  },
  {
    reason: "Security audits",
    role: "Security auditor",
    candidates: ["security-bounty-hunter", "security-scan", "gateguard"],
  },
];

const LANG_RULES: Record<string, TeamRule[]> = {
  rust: [
    {
      reason: "Rust reviewer",
      role: "Rust reviewer",
      candidates: ["rust-engineer", "rust-patterns", "ecc:rust-review"],
    },
    {
      reason: "Rust testing",
      role: "Rust test writer",
      candidates: ["rust-testing", "ecc:rust-test"],
    },
  ],
  typescript: [
    {
      reason: "TypeScript reviewer",
      role: "TypeScript reviewer",
      candidates: ["typescript-pro", "react-specialist", "frontend-developer"],
    },
    {
      reason: "Next.js / build",
      role: "Build engineer",
      candidates: ["nextjs-turbopack", "vite-patterns"],
    },
  ],
  python: [
    {
      reason: "Python reviewer",
      role: "Python reviewer",
      candidates: ["python-pro", "python-patterns"],
    },
    {
      reason: "Python testing",
      role: "Python test writer",
      candidates: ["python-testing"],
    },
  ],
  go: [
    {
      reason: "Go reviewer",
      role: "Go reviewer",
      candidates: ["golang-pro", "golang-patterns"],
    },
  ],
  cpp: [
    {
      reason: "C++ specialist",
      role: "C++ engineer",
      candidates: ["cpp-pro", "cpp-coding-standards"],
    },
  ],
  gamedev: [
    {
      reason: "Game dev engineer",
      role: "Gameplay engineer",
      candidates: ["gamedev-engineer", "ue5-dev", "don-claudio"],
    },
  ],
};

function proposeTeam(
  claudeMd: string,
  agents: AgentEntry[],
  alreadyPinned: string[],
): TeamProposal[] {
  const byName = new Map(agents.map((a) => [a.name, a] as const));
  const langs = detectLanguages(claudeMd);
  const picks: TeamProposal[] = [];
  const used = new Set<string>(alreadyPinned);

  const applyRule = (rule: TeamRule) => {
    for (const slug of rule.candidates) {
      if (used.has(slug)) continue;
      const a = byName.get(slug);
      if (a) {
        picks.push({ agent: a, suggestedRole: rule.role });
        used.add(slug);
        return;
      }
    }
  };

  // Apply language-specific rules first so they take priority within the 7-cap.
  for (const lang of langs) {
    const rules = LANG_RULES[lang];
    if (!rules) continue;
    for (const r of rules) {
      if (picks.length >= 7) return picks;
      applyRule(r);
    }
  }
  // Then defaults to round out the team.
  for (const r of DEFAULT_RULES) {
    if (picks.length >= 7) break;
    applyRule(r);
  }
  // Minimum team size of 3 — top up with the first unused, highest-signal
  // agents from the catalogue (alphabetical, global-origin first).
  if (picks.length < 3) {
    const fallback = [...agents]
      .filter((a) => !used.has(a.name))
      .sort((a, b) => {
        if (a.origin !== b.origin) return a.origin === "global" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const a of fallback) {
      if (picks.length >= 3) break;
      picks.push({ agent: a, suggestedRole: "Generalist" });
      used.add(a.name);
    }
  }
  return picks;
}

function originStyle(origin: AgentEntry["origin"]): {
  background: string;
  color: string;
  border: string;
} {
  switch (origin) {
    case "global":
      return {
        background: "var(--color-surface-3)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
      };
    case "project":
      return {
        background: "rgba(136, 136, 204, 0.16)",
        color: "#b6b6ff",
        border: "1px solid rgba(136, 136, 204, 0.40)",
      };
    case "plugin":
      return {
        background: "rgba(231, 187, 99, 0.16)",
        color: "#e0af68",
        border: "1px solid rgba(231, 187, 99, 0.40)",
      };
  }
}

// Derive a category for picker grouping. Reuses the domain taxonomy from
// `skill-categories.ts` so skills and agents end up in the same buckets
// (Personas, Rust, TypeScript / JS, …). Falls back to the plugin slug for
// plugin-origin agents that aren't in the EXACT_MAP, and finally to
// "Uncategorized" so nothing silently disappears from the picker.
function deriveCategory(a: AgentEntry): string {
  const domain = categorize(a.name, a.description);
  if (domain) return domain;
  if (a.origin === "plugin") {
    const norm = a.path.replace(/\\/g, "/");
    const m = norm.match(/\/plugins\/cache\/[^/]+\/([^/]+)\//);
    if (m && m[1]) return `Plugin · ${m[1]}`;
  }
  return NO_CATEGORY;
}

export default function ProjectAgents({ projectId, projectPath }: Props) {
  const [pinned, setPinned] = useState<string[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerCategory, setPickerCategory] = useState<string>(ALL_CATEGORIES);
  const [toast, setToast] = useState<string | null>(null);
  // Inline role editor — only one row is editable at a time.
  const [editingRoleFor, setEditingRoleFor] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState("");
  // AI configure-team modal state.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiProposal, setAiProposal] = useState<TeamProposal[]>([]);
  const [aiSelected, setAiSelected] = useState<Set<string>>(new Set());
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiDetectedLangs, setAiDetectedLangs] = useState<string[]>([]);

  const loadAll = useCallback(async () => {
    try {
      const [p, list, b] = await Promise.all([
        invoke("agents_pinned_load", { projectId }) as Promise<PinnedAgents>,
        invoke("list_agents", { projectPath: null }) as Promise<AgentEntry[]>,
        invoke("kanban_load", { projectId }) as Promise<KanbanBoard>,
      ]);
      setPinned(p.pinned);
      setRoles(p.roles ?? {});
      setAgents(list);
      setBoard(b);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Auto-dismiss toast after 3s — used by workflow placeholders.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // ESC closes the picker overlay.
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen]);

  // ESC closes the AI configure modal.
  useEffect(() => {
    if (!aiOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAiOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aiOpen]);

  // Persist both the pinned list and roles together. The backend always
  // overwrites the whole struct so we send the latest of each.
  const persist = useCallback(
    async (nextPinned: string[], nextRoles: Record<string, string>) => {
      setPinned(nextPinned);
      setRoles(nextRoles);
      try {
        await invoke("agents_pinned_save", {
          projectId,
          pinned: { pinned: nextPinned, roles: nextRoles },
        });
      } catch (e) {
        setError(String(e));
        await loadAll();
      }
    },
    [projectId, loadAll],
  );

  const pinAgent = useCallback(
    (slug: string) => {
      if (pinned.includes(slug)) return;
      void persist([...pinned, slug], roles);
    },
    [pinned, roles, persist],
  );

  const unpinAgent = useCallback(
    (slug: string) => {
      const nextRoles = { ...roles };
      delete nextRoles[slug];
      void persist(
        pinned.filter((p) => p !== slug),
        nextRoles,
      );
    },
    [pinned, roles, persist],
  );

  const saveRole = useCallback(
    (slug: string, role: string) => {
      const trimmed = role.trim();
      const nextRoles = { ...roles };
      if (trimmed === "") {
        delete nextRoles[slug];
      } else {
        nextRoles[slug] = trimmed;
      }
      void persist(pinned, nextRoles);
      setEditingRoleFor(null);
      setRoleDraft("");
    },
    [pinned, roles, persist],
  );

  const setDefaultAgent = useCallback(
    async (slug: string | null) => {
      if (!board) return;
      const next: KanbanBoard = { ...board, default_agent: slug };
      try {
        await invoke("kanban_save", { board: next });
        setBoard(next);
      } catch (e) {
        setError(String(e));
      }
    },
    [board],
  );

  // Pinned-agent cards: filter the global list by `pinned[]` and keep the
  // user's pin order so reordering (future) maps to display order. Defined
  // here (above the AI-configure / launch-all callbacks) because both
  // callbacks depend on it.
  const pinnedAgents = useMemo(() => {
    const byName = new Map(agents.map((a) => [a.name, a] as const));
    return pinned
      .map((name) => byName.get(name))
      .filter((a): a is AgentEntry => Boolean(a));
  }, [agents, pinned]);

  // ---------------------------------------------------------------------
  // AI configure team — heuristic flow. We load CLAUDE.md, detect language
  // tokens, propose 3-7 agents from the catalogue, and surface them in a
  // confirmation modal. The user reviews + applies. No backend round-trip
  // needed — keeps the flow snappy and deterministic.
  // ---------------------------------------------------------------------
  const openAiConfigure = useCallback(async () => {
    setAiBusy(true);
    setAiError(null);
    try {
      let md = "";
      try {
        md = (await invoke("project_claude_md_load", {
          projectPath,
        })) as string;
      } catch {
        // Project may not have CLAUDE.md yet — still propose defaults.
        md = "";
      }
      const langs = Array.from(detectLanguages(md));
      const proposal = proposeTeam(md, agents, pinned);
      setAiDetectedLangs(langs);
      setAiProposal(proposal);
      setAiSelected(new Set(proposal.map((p) => p.agent.name)));
      setAiOpen(true);
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(false);
    }
  }, [projectPath, agents, pinned]);

  const applyAiTeam = useCallback(async () => {
    if (aiProposal.length === 0) return;
    const selected = aiProposal.filter((p) => aiSelected.has(p.agent.name));
    if (selected.length === 0) return;
    const nextPinned = [...pinned];
    const nextRoles = { ...roles };
    for (const p of selected) {
      if (!nextPinned.includes(p.agent.name)) nextPinned.push(p.agent.name);
      // Don't clobber an existing role the user already set.
      if (!nextRoles[p.agent.name]) nextRoles[p.agent.name] = p.suggestedRole;
    }
    await persist(nextPinned, nextRoles);
    setAiOpen(false);
    setToast(
      `Team configured with ${selected.length} agent${selected.length === 1 ? "" : "s"} based on AI analysis`,
    );
  }, [aiProposal, aiSelected, pinned, roles, persist]);

  // ---------------------------------------------------------------------
  // Launch all — spawn one Claude session per pinned agent, prepending a
  // short role framing so each terminal opens with context. Sessions are
  // started in parallel; failures show up in `error` but won't abort the
  // batch (Promise.allSettled).
  // ---------------------------------------------------------------------
  const launchAllAgents = useCallback(async () => {
    if (pinnedAgents.length === 0) return;
    const tasks = pinnedAgents.map(async (a) => {
      const role = roles[a.name] ?? "Generalist";
      const prompt =
        `You are joining the project as: ${role}.\n` +
        `Agent profile: ${a.name}.\n` +
        `Read CLAUDE.md (if it exists) and the project tree, then propose your first 3 next actions in that role. Wait for my OK before taking any.`;
      return invoke("spawn_session", {
        provider: "claude",
        cwd: projectPath,
        prompt,
        flags: { dangerouslySkipPermissions: false },
      });
    });
    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      setToast(`Launched ${pinnedAgents.length} agent session(s) in parallel`);
    } else {
      setToast(
        `Launched ${pinnedAgents.length - failed}/${pinnedAgents.length} agents — ${failed} failed`,
      );
    }
  }, [pinnedAgents, roles, projectPath]);

  // Picker candidates — every agent NOT currently pinned, filtered by query
  // AND category. Sorted alphabetically per category.
  const pickerCandidates = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return agents
      .filter((a) => !pinned.includes(a.name))
      .filter((a) =>
        q === ""
          ? true
          : a.name.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
      )
      .filter((a) =>
        pickerCategory === ALL_CATEGORIES
          ? true
          : deriveCategory(a) === pickerCategory,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, pinned, pickerQuery, pickerCategory]);

  // Build the category sidebar from the SAME unpinned-set so empty
  // categories don't show up (would be confusing). Each entry carries a
  // count so the user can see e.g. "Personas (12)".
  const pickerCategoryCounts = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const counts = new Map<string, number>();
    for (const a of agents) {
      if (pinned.includes(a.name)) continue;
      if (
        q !== "" &&
        !a.name.toLowerCase().includes(q) &&
        !a.description.toLowerCase().includes(q)
      ) {
        continue;
      }
      const cat = deriveCategory(a);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return counts;
  }, [agents, pinned, pickerQuery]);

  const sortedCategories = useMemo(() => {
    const list = Array.from(pickerCategoryCounts.entries());
    list.sort((a, b) => {
      // Uncategorized always last
      if (a[0] === NO_CATEGORY) return 1;
      if (b[0] === NO_CATEGORY) return -1;
      return a[0].localeCompare(b[0]);
    });
    return list;
  }, [pickerCategoryCounts]);

  const totalUnpinned = useMemo(
    () =>
      Array.from(pickerCategoryCounts.values()).reduce((sum, n) => sum + n, 0),
    [pickerCategoryCounts],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header: default-agent select + add-agent action */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs">
        <span className="text-[var(--color-text-muted)]">Default agent:</span>
        <select
          value={board?.default_agent ?? ""}
          onChange={(e) => void setDefaultAgent(e.target.value || null)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
          title="Used when a kanban card has no explicit agent override."
        >
          <option value="">(none)</option>
          {pinnedAgents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void openAiConfigure()}
          disabled={aiBusy}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/15 px-2 py-1 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 disabled:opacity-40"
          title="Analyse this project's CLAUDE.md and propose a 3-7 agent team. You confirm before applying."
        >
          {aiBusy ? "Analysing…" : "AI configure team"}
        </button>
        <button
          type="button"
          onClick={() => {
            setPickerQuery("");
            setPickerCategory(ALL_CATEGORIES);
            setPickerOpen(true);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-2)]"
          title="Pick an agent from the global catalogue and pin it to this project."
        >
          <Plus size={12} />
          Add agent to project
        </button>
        {error && (
          <span className="ml-2 text-[var(--color-error)]" title={error}>
            error
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {/* Agent Team — Library-style cards (renamed from "Pinned agents" in
            v2.6 fb-023). Each card carries the role badge under the name. */}
        <section className="mb-5">
          <div className="mb-1 flex items-center gap-2">
            <h3 className="text-[11.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Agent Team ({pinnedAgents.length})
            </h3>
            {pinnedAgents.length > 0 && (
              <button
                type="button"
                onClick={() => void launchAllAgents()}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                title="Spawn one Claude session per pinned agent in parallel. Each terminal opens framed by the agent's role."
              >
                <span aria-hidden>▶</span> Launch all
              </button>
            )}
          </div>
          <p className="mb-2 text-[11.5px] text-[var(--color-text-muted)]">
            Tu equipo de agentes para este proyecto. Cada uno se asigna a un
            rol específico. Usa "AI configure team" para que el sistema
            proponga un equipo basado en CLAUDE.md.
          </p>
          {pinnedAgents.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-0)] p-4 text-center text-xs text-[var(--color-text-muted)]">
              No agents pinned yet. Use{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setPickerQuery("");
                  setPickerCategory(ALL_CATEGORIES);
                  setPickerOpen(true);
                }}
              >
                Add agent to project
              </button>{" "}
              to surface the agents you want for this workspace.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {pinnedAgents.map((a) => {
                const chip = originStyle(a.origin);
                const role = roles[a.name] ?? "";
                const isEditing = editingRoleFor === a.name;
                const avatar = roleAvatar(role, a.name);
                return (
                  <div
                    key={a.name}
                    className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-xs transition-colors hover:border-[var(--color-border-strong)]"
                    title={a.description || `${a.name} (${a.origin} agent)`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-surface-3)] text-[16px] leading-none"
                          title={role ? `Role: ${role}` : "No role assigned"}
                        >
                          {avatar}
                        </span>
                        <div className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-1 font-semibold text-[var(--color-text)]">
                            <Pin size={11} />
                            {a.name}
                          </span>
                        </div>
                      </div>
                      <span
                        className="rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                        style={chip}
                      >
                        {a.origin}
                      </span>
                    </div>

                    {/* Role badge — inline editable. Clicking the badge
                        swaps to a text input; Enter saves, Esc cancels. */}
                    <div>
                      {isEditing ? (
                        <input
                          autoFocus
                          value={roleDraft}
                          onChange={(e) => setRoleDraft(e.target.value)}
                          onBlur={() => saveRole(a.name, roleDraft)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              saveRole(a.name, roleDraft);
                            } else if (e.key === "Escape") {
                              setEditingRoleFor(null);
                              setRoleDraft("");
                            }
                          }}
                          placeholder="Role (e.g. Backend reviewer, QA)…"
                          className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-0)] px-1.5 py-0.5 text-[11px] outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingRoleFor(a.name);
                            setRoleDraft(role);
                          }}
                          className="inline-flex items-center gap-1 rounded border border-dashed border-[var(--color-border)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
                          title="Edit the role this agent plays on the project."
                        >
                          {role ? (
                            <span style={{ color: "var(--color-text)" }}>
                              {role}
                            </span>
                          ) : (
                            <span className="italic text-[var(--color-text-faint)]">
                              + Assign role
                            </span>
                          )}
                        </button>
                      )}
                    </div>

                    <p className="line-clamp-3 flex-1 text-[var(--color-text-muted)]">
                      {a.description || (
                        <span className="italic text-[var(--color-text-faint)]">
                          No description.
                        </span>
                      )}
                    </p>
                    <div className="mt-1 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => unpinAgent(a.name)}
                        className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 text-[11.5px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                        title="Unpin this agent from the project (does not delete the agent)."
                      >
                        <PinOff size={11} /> Remove from project
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Workflows — predefined multi-agent recipe tiles. Each tile
            carries a "Beta" pill until the orchestration backend lands. */}
        <section>
          <h3 className="mb-2 text-[11.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Workflows
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {WORKFLOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() =>
                  setToast(`Workflow "${w.label}" would launch (backend coming soon)`)
                }
                className="flex flex-col items-start gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-left text-xs transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"
                title={`${w.label}: ${w.description}\n\n(Workflow orchestration backend not implemented yet — clicking shows a placeholder toast.)`}
              >
                <div className="flex w-full items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: w.accent }}
                  />
                  <span className="font-semibold text-[var(--color-text)]">
                    {w.label}
                  </span>
                  <span
                    className="ml-auto rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                    style={{
                      background: "rgba(56, 139, 253, 0.14)",
                      color: "#79b8ff",
                      border: "1px solid rgba(56, 139, 253, 0.40)",
                    }}
                    title="Workflow orchestration backend not implemented yet."
                  >
                    Beta
                  </span>
                </div>
                <p className="text-[var(--color-text-muted)]">{w.description}</p>
              </button>
            ))}
          </div>
        </section>

        {/* Create skill from project — moved here from Context tab in v2.6
            fb-024 so project-scoped skill generation lives alongside the
            other agent/team controls. */}
        <section className="mt-5">
          <h3 className="mb-2 text-[11.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Generate
          </h3>
          <CreateSkillFromProjectButton
            projectId={projectId}
            projectPath={projectPath}
          />
        </section>
      </div>

      {/* Toast — workflow-launch placeholder feedback. */}
      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-3)] px-3 py-2 text-xs text-[var(--color-text)] shadow-lg"
        >
          {toast}
        </div>
      )}

      {/* AI configure-team modal — proposes a 3-7 agent team based on the
          project's CLAUDE.md. Heuristic: detect language tokens, then map
          to DEFAULT_RULES + LANG_RULES. The user can deselect agents
          before applying. */}
      {aiOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="AI configure team"
          onClick={() => setAiOpen(false)}
        >
          <div
            className="flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-4 text-xs shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                <span aria-hidden className="mr-1">🤖</span>
                AI configure team
              </h2>
              <button
                type="button"
                onClick={() => setAiOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-3)]"
              >
                <X size={12} />
              </button>
            </div>
            <p className="text-[var(--color-text-secondary)]">
              Análisis del proyecto:{" "}
              {aiDetectedLangs.length === 0 ? (
                <span className="italic text-[var(--color-text-muted)]">
                  no se detectó stack específico — se proponen agentes
                  generales.
                </span>
              ) : (
                <>
                  stack detectado:{" "}
                  {aiDetectedLangs.map((l) => (
                    <span
                      key={l}
                      className="mr-1 inline-block rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10.5px]"
                    >
                      {l}
                    </span>
                  ))}
                </>
              )}
            </p>
            {aiProposal.length === 0 ? (
              <div className="rounded border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-center text-[var(--color-text-muted)]">
                No se pudieron sugerir agentes nuevos (puede que ya tengas
                pineados los relevantes).
              </div>
            ) : (
              <div className="max-h-[50vh] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2">
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {aiProposal.map((p) => {
                    const selected = aiSelected.has(p.agent.name);
                    const avatar = roleAvatar(p.suggestedRole, p.agent.name);
                    const chip = originStyle(p.agent.origin);
                    return (
                      <button
                        key={p.agent.name}
                        type="button"
                        onClick={() => {
                          const next = new Set(aiSelected);
                          if (next.has(p.agent.name)) {
                            next.delete(p.agent.name);
                          } else {
                            next.add(p.agent.name);
                          }
                          setAiSelected(next);
                        }}
                        className="flex items-start gap-2 rounded-md border p-2 text-left transition-colors"
                        style={{
                          background: selected
                            ? "var(--color-surface-3)"
                            : "var(--color-surface-1)",
                          borderColor: selected
                            ? "var(--color-accent)"
                            : "var(--color-border)",
                        }}
                        title={p.agent.description || p.agent.name}
                      >
                        <span
                          aria-hidden
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-surface-3)] text-[16px] leading-none"
                        >
                          {avatar}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-semibold text-[var(--color-text)]">
                              {p.agent.name}
                            </span>
                            <span
                              className="shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wide"
                              style={chip}
                            >
                              {p.agent.origin}
                            </span>
                          </div>
                          <div className="text-[10.5px] text-[var(--color-accent)]">
                            Role: {p.suggestedRole}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[10.5px] text-[var(--color-text-muted)]">
                            {p.agent.description || "No description."}
                          </p>
                        </div>
                        <span
                          aria-hidden
                          className="text-[14px]"
                          style={{
                            color: selected
                              ? "var(--color-accent)"
                              : "var(--color-text-faint)",
                          }}
                        >
                          {selected ? "✓" : "○"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {aiError && (
              <div className="rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-2 text-[var(--color-error)]">
                {aiError}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 pt-1 text-[var(--color-text-muted)]">
              <span>
                {aiSelected.size} de {aiProposal.length} seleccionados
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAiOpen(false)}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface-3)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void applyAiTeam()}
                  disabled={aiSelected.size === 0}
                  className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-3 py-1 text-[var(--color-accent)] disabled:opacity-40"
                >
                  Apply team
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Picker overlay — pin a new agent from the global catalogue.
          Sidebar (left) lists every category present in the unpinned
          set, plus an "All" entry. Grid (right) renders the agents that
          match the selected category + the query string. */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Add agent to project"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="my-auto flex w-full max-w-4xl flex-col rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
              <h2 className="text-sm font-semibold">Add agent to project</h2>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-3)]"
              >
                <X size={12} />
              </button>
            </div>
            <div className="border-b border-[var(--color-border)] p-2">
              <input
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Filter agents by name or description…"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1.5 text-xs outline-none"
                autoFocus
              />
            </div>
            <div className="flex max-h-[60vh] min-h-[300px]">
              {/* Category sidebar */}
              <aside className="w-44 shrink-0 overflow-y-auto border-r border-[var(--color-border)] p-2">
                <button
                  type="button"
                  onClick={() => setPickerCategory(ALL_CATEGORIES)}
                  className="mb-0.5 flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11.5px]"
                  style={{
                    background:
                      pickerCategory === ALL_CATEGORIES
                        ? "var(--color-surface-3)"
                        : "transparent",
                    color: "var(--color-text)",
                    border:
                      pickerCategory === ALL_CATEGORIES
                        ? "1px solid var(--color-border-strong)"
                        : "1px solid transparent",
                  }}
                >
                  <span>All</span>
                  <span className="text-[10px] text-[var(--color-text-faint)]">
                    {totalUnpinned}
                  </span>
                </button>
                {sortedCategories.map(([cat, n]) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setPickerCategory(cat)}
                    className="mb-0.5 flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11.5px]"
                    style={{
                      background:
                        pickerCategory === cat
                          ? "var(--color-surface-3)"
                          : "transparent",
                      color:
                        pickerCategory === cat
                          ? "var(--color-text)"
                          : "var(--color-text-secondary)",
                      border:
                        pickerCategory === cat
                          ? "1px solid var(--color-border-strong)"
                          : "1px solid transparent",
                    }}
                  >
                    <span className="truncate" title={cat}>
                      {cat}
                    </span>
                    <span className="ml-2 shrink-0 text-[10px] text-[var(--color-text-faint)]">
                      {n}
                    </span>
                  </button>
                ))}
              </aside>

              {/* Agent grid */}
              <div className="flex-1 overflow-y-auto p-2">
                {pickerCandidates.length === 0 ? (
                  <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
                    {pinned.length === agents.length
                      ? "Every available agent is already pinned."
                      : "No agents match your filter."}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                    {pickerCandidates.map((a) => {
                      const chip = originStyle(a.origin);
                      return (
                        <div
                          key={a.name}
                          className="flex items-start justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-semibold">
                                {a.name}
                              </span>
                              <span
                                className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                                style={chip}
                              >
                                {a.origin}
                              </span>
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-[var(--color-text-muted)]">
                              {a.description}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => pinAgent(a.name)}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] hover:bg-[var(--color-surface-3)]"
                            title="Pin this agent to the project."
                          >
                            <Pin size={11} /> Pin
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface-3)]"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create skill from project — moved out of Context tab in v2.6 fb-024.
//
// Renders a button + an informational modal that explains exactly what the
// generated skill will do and where it will land before spawning the Claude
// session. The destination (`~/.claude/skills/project-<slug>/`) matches the
// "Project" sub-tile in the Skills section of Library so the new skill is
// discoverable from the Library tab right after creation.
// ---------------------------------------------------------------------------
function CreateSkillFromProjectButton({
  projectId,
  projectPath,
}: {
  projectId: string;
  projectPath: string;
}) {
  const [open, setOpen] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const slug = useMemo(
    () => projectId.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
    [projectId],
  );
  const destination = `~/.claude/skills/project-${slug}/`;

  // ESC closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const run = async () => {
    setSpawning(true);
    setErr(null);
    const prompt =
      "Lee este proyecto (árbol, CLAUDE.md si existe, README) y crea un skill nuevo que codifique cómo trabajar aquí.\n\n" +
      `Ubicación destino: ~/.claude/skills/project-${slug}/SKILL.md\n\n` +
      "Estructura del skill:\n" +
      "- Frontmatter YAML: name (kebab-case: `project-" +
      slug +
      "`), description (cuándo activarse, no qué hace).\n" +
      "- Cuerpo: cómo arrancar el proyecto, convenciones críticas, gotchas conocidos, comandos comunes, qué NO tocar.\n\n" +
      "IMPORTANTE: La ubicación destino es ~/.claude/skills/project-" +
      slug +
      "/SKILL.md (no la carpeta del proyecto). Crea la carpeta si no existe.\n\n" +
      "Muéstrame el contenido propuesto ANTES de escribir el archivo. Espera mi OK.";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      }
      await invoke("spawn_session", {
        provider: "claude",
        cwd: projectPath,
        prompt,
        flags: { dangerouslySkipPermissions: false },
      });
      setOpen(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSpawning(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex flex-col items-start gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-left text-xs transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"
        title="Generate a project-scoped skill from this project's tree + CLAUDE.md."
      >
        <div className="flex w-full items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: "var(--color-accent)" }}
          />
          <span className="font-semibold text-[var(--color-text)]">
            Create skill from project
          </span>
        </div>
        <p className="text-[var(--color-text-muted)]">
          Spawn a Claude session that drafts a SKILL.md describing how to work
          on this project. The skill is saved under{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>{destination}</span>{" "}
          and appears in Library → Skills.
        </p>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Create skill from project"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-4 text-xs shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Create skill from project</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-3)]"
              >
                <X size={12} />
              </button>
            </div>
            <p className="text-[var(--color-text-secondary)]">
              Esto pedirá a Claude que analice el proyecto y proponga una
              skill útil. La skill se creará en{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {destination}
              </span>{" "}
              y aparecerá automáticamente en Library → Skills (sub-tile
              "Project").
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-[var(--color-text-muted)]">
              <li>
                Claude leerá el árbol del proyecto, el CLAUDE.md y el README.
              </li>
              <li>
                Generará un SKILL.md con frontmatter (
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  name: project-{slug}
                </span>
                ).
              </li>
              <li>
                Te enseñará el contenido propuesto antes de escribirlo —
                puedes vetar o pedir cambios.
              </li>
            </ul>
            {err && (
              <div className="rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-2 text-[var(--color-error)]">
                {err}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={spawning}
                className="rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface-3)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void run()}
                disabled={spawning}
                className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-3 py-1 text-[var(--color-accent)] disabled:opacity-40"
              >
                {spawning ? "Spawning…" : "Spawn Claude session"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
