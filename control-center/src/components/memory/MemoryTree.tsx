// ULTRON Control Center 2.9.x — Memory Tree unified view
//
// Three-panel layout:
//   Left (280px)  : hierarchical tree view of all memory layers
//   Center (flex) : detail pane for the selected node
//   Top (sticky)  : unified search across all layers
//
// No external tree library. Tree state managed via useState<Set<string>>.
// Design: dark-theme CSS vars only.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

// ---------------------------------------------------------------------------
// Types — mirror crate::commands::memory_graph::*
// ---------------------------------------------------------------------------

interface SkillHit {
  name: string;
  description: string;
  path: string;
  origin: "global" | "project" | "plugin";
  enabled: boolean;
}

interface AgentHit {
  name: string;
  description: string | null;
  path: string | null;
}

interface RuleHit {
  name: string;
  relative: string;
  path: string;
  preview: string;
}

interface Mem0Memory {
  id: string;
  memory: string;
  user_id: string | null;
  created_at: string | null;
}

interface KgEntity {
  name: string;
  entity_type: string;
  observations: string[];
}

interface UnifiedSearchResults {
  skills: SkillHit[];
  agents: AgentHit[];
  rules: RuleHit[];
  mem0: Mem0Memory[];
  kg: KgEntity[];
  qdrant: unknown[];
}

interface MemoryTreeSnapshot {
  skills: SkillHit[];
  agents: AgentHit[];
  rules: RuleHit[];
  kg_entity_count: number;
  kg_entity_types: [string, number][];
}

// ---------------------------------------------------------------------------
// Internal tree node shape (frontend-only)
// ---------------------------------------------------------------------------

type NodeKind =
  | "root-skills"
  | "root-agents"
  | "root-rules"
  | "root-mem0"
  | "root-kg"
  | "root-qdrant"
  | "skill"
  | "agent"
  | "rule"
  | "mem0-entry"
  | "kg-entity"
  | "kg-type-group";

interface TreeNode {
  id: string;
  label: string;
  icon: string;
  count?: number;
  children?: TreeNode[];
  payload?: {
    kind: NodeKind;
    skill?: SkillHit;
    agent?: AgentHit;
    rule?: RuleHit;
    mem0?: Mem0Memory;
    kg?: KgEntity;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 280;

function badge(n: number | undefined): string {
  if (n == null || n === 0) return "";
  return n > 999 ? "999+" : String(n);
}

function groupAgentsByCategory(agents: AgentHit[]): Map<string, AgentHit[]> {
  const categories: Map<string, AgentHit[]> = new Map();
  const categoryRules: [RegExp, string][] = [
    [/review|audit|security|penetrat|qa|refactor|access/i, "Review & quality"],
    [/rust|typescript|javascript|python|cpp|golang|csharp|swift|kotlin|java|vue|react|nextjs|mobile|electron|unity|unreal|graphics|powershell|sql|postgres/i, "Language specialists"],
    [/cloud|kubernetes|docker|terraform|devops|deploy|database|data-eng|sre|incident|test-auto|depend/i, "Infra & ops"],
    [/backend|api|microservice|fullstack|frontend|websocket|cli|mcp/i, "Backend & systems"],
    [/ai-eng|ml-eng|mlops|llm|agent|multi-agent|prompt|context|workflow/i, "AI & agents"],
    [/debug|error-detect|perform|legacy/i, "Debug & troubleshoot"],
    [/ultron|knowledge|doc|dx|git/i, "Meta"],
  ];
  for (const agent of agents) {
    let found = false;
    for (const [re, cat] of categoryRules) {
      if (re.test(agent.name)) {
        if (!categories.has(cat)) categories.set(cat, []);
        categories.get(cat)!.push(agent);
        found = true;
        break;
      }
    }
    if (!found) {
      if (!categories.has("Other")) categories.set("Other", []);
      categories.get("Other")!.push(agent);
    }
  }
  return categories;
}

function groupSkillsByPlugin(skills: SkillHit[]): Map<string, SkillHit[]> {
  const groups: Map<string, SkillHit[]> = new Map([
    ["global", []],
    ["plugin", []],
    ["project", []],
  ]);
  for (const s of skills) {
    groups.get(s.origin)?.push(s);
  }
  // Remove empty groups
  for (const [k, v] of groups) {
    if (v.length === 0) groups.delete(k);
  }
  return groups;
}

function groupRulesByFolder(rules: RuleHit[]): Map<string, RuleHit[]> {
  const groups: Map<string, RuleHit[]> = new Map();
  for (const r of rules) {
    const folder = r.relative.includes("/") || r.relative.includes("\\")
      ? r.relative.split(/[/\\]/)[0]
      : "root";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)!.push(r);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Build tree from snapshot
// ---------------------------------------------------------------------------

function buildTree(
  snapshot: MemoryTreeSnapshot,
  mem0Results: Mem0Memory[],
): TreeNode[] {
  // --- Skills ---
  const skillsByOrigin = groupSkillsByPlugin(snapshot.skills);
  const skillChildren: TreeNode[] = [];
  for (const [origin, items] of skillsByOrigin) {
    const label =
      origin === "global" ? "Global" : origin === "plugin" ? "Plugin" : "Project";
    skillChildren.push({
      id: `skills-${origin}`,
      label,
      icon: origin === "plugin" ? "🔌" : origin === "project" ? "📁" : "🌐",
      count: items.length,
      children: items.map((s) => ({
        id: `skill-${s.name}`,
        label: s.name,
        icon: s.enabled ? "⚡" : "○",
        payload: { kind: "skill" as NodeKind, skill: s },
      })),
    });
  }

  // --- Agents ---
  const agentsByCategory = groupAgentsByCategory(snapshot.agents);
  const agentChildren: TreeNode[] = [];
  for (const [cat, items] of agentsByCategory) {
    agentChildren.push({
      id: `agents-${cat}`,
      label: cat,
      icon: "🗂",
      count: items.length,
      children: items.map((a) => ({
        id: `agent-${a.name}`,
        label: a.name,
        icon: "🤖",
        payload: { kind: "agent" as NodeKind, agent: a },
      })),
    });
  }

  // --- Rules ---
  const rulesByFolder = groupRulesByFolder(snapshot.rules);
  const ruleChildren: TreeNode[] = [];
  for (const [folder, items] of rulesByFolder) {
    ruleChildren.push({
      id: `rules-${folder}`,
      label: folder,
      icon: "📋",
      count: items.length,
      children: items.map((r) => ({
        id: `rule-${r.path}`,
        label: r.name,
        icon: "📄",
        payload: { kind: "rule" as NodeKind, rule: r },
      })),
    });
  }

  // --- Mem0 ---
  const mem0Children: TreeNode[] = mem0Results.map((m) => ({
    id: `mem0-${m.id}`,
    label: m.memory.slice(0, 60) + (m.memory.length > 60 ? "…" : ""),
    icon: "🧠",
    payload: { kind: "mem0-entry" as NodeKind, mem0: m },
  }));

  // --- KG by type ---
  const kgChildren: TreeNode[] = snapshot.kg_entity_types.map(([type, count]) => ({
    id: `kg-type-${type}`,
    label: type,
    icon: "🔷",
    count,
    payload: { kind: "kg-type-group" as NodeKind },
  }));

  return [
    {
      id: "root-skills",
      label: "Skills",
      icon: "⚡",
      count: snapshot.skills.length,
      children: skillChildren,
      payload: { kind: "root-skills" },
    },
    {
      id: "root-agents",
      label: "Agents",
      icon: "🤖",
      count: snapshot.agents.length,
      children: agentChildren,
      payload: { kind: "root-agents" },
    },
    {
      id: "root-rules",
      label: "Rules",
      icon: "📋",
      count: snapshot.rules.length,
      children: ruleChildren,
      payload: { kind: "root-rules" },
    },
    {
      id: "root-mem0",
      label: "Mem0 entries",
      icon: "🧠",
      count: mem0Results.length,
      children: mem0Children,
      payload: { kind: "root-mem0" },
    },
    {
      id: "root-kg",
      label: "Knowledge Graph",
      icon: "🔷",
      count: snapshot.kg_entity_count,
      children: kgChildren,
      payload: { kind: "root-kg" },
    },
    {
      id: "root-qdrant",
      label: "Qdrant vault",
      icon: "🗄",
      count: 0,
      children: [],
      payload: { kind: "root-qdrant" },
    },
  ];
}

// ---------------------------------------------------------------------------
// TreeNodeRow — single row in the tree
// ---------------------------------------------------------------------------

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (id: string) => void;
  onSelect: (node: TreeNode) => void;
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
}: TreeNodeRowProps) {
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isExpanded = expanded.has(node.id);
  const isSelected = selected === node.id;
  const badgeText = badge(node.count);

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isSelected}
        title={node.label}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        className={[
          "flex items-center gap-1.5 cursor-pointer select-none rounded py-0.5 pr-2 text-xs",
          isSelected
            ? "bg-[var(--color-accent)] text-[var(--color-bg)]"
            : "text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]",
        ].join(" ")}
        onClick={() => {
          if (hasChildren) onToggle(node.id);
          onSelect(node);
        }}
      >
        {/* expand/collapse chevron */}
        <span
          className="inline-block w-3 shrink-0 text-center text-[10px]"
          style={{
            color: isSelected
              ? "var(--color-bg)"
              : "var(--color-text-tertiary)",
          }}
        >
          {hasChildren ? (isExpanded ? "▾" : "▸") : " "}
        </span>

        {/* icon */}
        <span className="shrink-0 text-[11px]">{node.icon}</span>

        {/* label */}
        <span className="min-w-0 flex-1 truncate">{node.label}</span>

        {/* count badge */}
        {badgeText && (
          <span
            className="ml-1 shrink-0 rounded px-1 py-px text-[10px] font-medium"
            style={{
              background: isSelected
                ? "rgba(255,255,255,0.2)"
                : "var(--color-surface-3)",
              color: isSelected
                ? "var(--color-bg)"
                : "var(--color-text-tertiary)",
            }}
          >
            {badgeText}
          </span>
        )}
      </div>

      {/* children */}
      {hasChildren && isExpanded &&
        node.children!.map((child) => (
          <TreeNodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            selected={selected}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// DetailPane — renders the selected node
// ---------------------------------------------------------------------------

interface DetailPaneProps {
  node: TreeNode | null;
  onDeleteMem0: (id: string) => void;
}

function DetailPane({ node, onDeleteMem0 }: DetailPaneProps) {
  const [mdContent, setMdContent] = useState<string | null>(null);
  const [mdLoading, setMdLoading] = useState(false);

  useEffect(() => {
    setMdContent(null);
    if (!node?.payload) return;
    const { kind, skill, agent, rule } = node.payload;
    if (kind === "skill" && skill?.path) {
      setMdLoading(true);
      invoke<string>("read_text_file", { path: skill.path })
        .then((c) => setMdContent(c))
        .catch(() => setMdContent(null))
        .finally(() => setMdLoading(false));
    } else if (kind === "agent" && agent?.path) {
      setMdLoading(true);
      invoke<string>("read_text_file", { path: agent.path })
        .then((c) => setMdContent(c))
        .catch(() => setMdContent(null))
        .finally(() => setMdLoading(false));
    } else if (kind === "rule" && rule?.path) {
      setMdLoading(true);
      invoke<string>("read_text_file", { path: rule.path })
        .then((c) => setMdContent(c))
        .catch(() => setMdContent(null))
        .finally(() => setMdLoading(false));
    }
  }, [node]);

  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-text-tertiary)]">
        <span className="text-4xl">🧠</span>
        <p className="text-sm">Selecciona un nodo del árbol</p>
        <p className="text-xs">O usa la búsqueda unificada arriba</p>
      </div>
    );
  }

  const { payload } = node;
  if (!payload) {
    return <RootDetail node={node} />;
  }

  switch (payload.kind) {
    case "root-skills":
    case "root-agents":
    case "root-rules":
    case "root-mem0":
    case "root-kg":
    case "root-qdrant":
    case "kg-type-group":
      return <RootDetail node={node} />;

    case "skill":
      return (
        <FileDetail
          title={payload.skill!.name}
          subtitle={`${payload.skill!.origin} skill · ${payload.skill!.enabled ? "enabled" : "disabled"}`}
          description={payload.skill!.description}
          path={payload.skill!.path}
          content={mdContent}
          loading={mdLoading}
          icon="⚡"
        />
      );

    case "agent":
      return (
        <FileDetail
          title={payload.agent!.name}
          subtitle="agent"
          description={payload.agent!.description ?? undefined}
          path={payload.agent!.path ?? undefined}
          content={mdContent}
          loading={mdLoading}
          icon="🤖"
        />
      );

    case "rule":
      return (
        <FileDetail
          title={payload.rule!.name}
          subtitle={payload.rule!.relative}
          path={payload.rule!.path}
          content={mdContent}
          loading={mdLoading}
          icon="📋"
        />
      );

    case "mem0-entry": {
      const m = payload.mem0!;
      return (
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <span>🧠</span> Mem0 memory
            </h3>
            <button
              onClick={() => onDeleteMem0(m.id)}
              className="rounded border border-[var(--color-danger)] px-2 py-0.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
            >
              Delete
            </button>
          </div>
          <pre className="whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-xs leading-relaxed">
            {m.memory}
          </pre>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-[var(--color-text-tertiary)]">
            <dt>ID</dt>
            <dd className="font-mono">{m.id}</dd>
            {m.created_at && (
              <>
                <dt>Created</dt>
                <dd>{m.created_at}</dd>
              </>
            )}
            {m.user_id && (
              <>
                <dt>User</dt>
                <dd>{m.user_id}</dd>
              </>
            )}
          </dl>
        </div>
      );
    }

    case "kg-entity": {
      const e = payload.kg!;
      return (
        <div className="flex flex-col gap-3 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <span>🔷</span> {e.name}
          </h3>
          <p className="text-xs text-[var(--color-text-tertiary)]">
            Type: <span className="font-mono">{e.entity_type}</span>
          </p>
          {e.observations.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                Observations ({e.observations.length})
              </p>
              <ul className="space-y-1">
                {e.observations.map((obs, i) => (
                  <li
                    key={i}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs"
                  >
                    {obs}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-components used by DetailPane
// ---------------------------------------------------------------------------

function RootDetail({ node }: { node: TreeNode }) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span>{node.icon}</span> {node.label}
      </h3>
      {node.count != null && (
        <p className="text-xs text-[var(--color-text-tertiary)]">
          {node.count} {node.count === 1 ? "entry" : "entries"}
        </p>
      )}
      {node.id === "root-qdrant" && (
        <p className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-text-tertiary)]">
          Qdrant integration pendiente — ver card-qdrant-wire.
        </p>
      )}
    </div>
  );
}

interface FileDetailProps {
  title: string;
  subtitle?: string;
  description?: string;
  path?: string;
  content: string | null;
  loading: boolean;
  icon: string;
}

function FileDetail({
  title,
  subtitle,
  description,
  path,
  content,
  loading,
  icon,
}: FileDetailProps) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <span>{icon}</span> {title}
        </h3>
        {path && (
          <button
            onClick={() => openPath(path).catch(() => {})}
            className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-3)]"
          >
            Open
          </button>
        )}
      </div>

      {subtitle && (
        <p className="text-xs text-[var(--color-text-tertiary)]">{subtitle}</p>
      )}

      {description && (
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          {description}
        </p>
      )}

      {path && (
        <p className="truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">
          {path}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="animate-pulse rounded bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-text-tertiary)]">
            Loading…
          </div>
        ) : content != null ? (
          <pre className="whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-xs leading-relaxed">
            {content.slice(0, 4000)}
            {content.length > 4000 && (
              <span className="text-[var(--color-text-tertiary)]">
                {"\n\n[truncated — open file to see full content]"}
              </span>
            )}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SearchResults — shown when there's an active query
// ---------------------------------------------------------------------------

interface SearchResultsProps {
  results: UnifiedSearchResults;
  query: string;
  onSelectSkill: (s: SkillHit) => void;
  onSelectAgent: (a: AgentHit) => void;
  onSelectRule: (r: RuleHit) => void;
  onSelectMem0: (m: Mem0Memory) => void;
  onSelectKg: (e: KgEntity) => void;
}

function SearchResultsPanel({
  results,
  query,
  onSelectSkill,
  onSelectAgent,
  onSelectRule,
  onSelectMem0,
  onSelectKg,
}: SearchResultsProps) {
  const total =
    results.skills.length +
    results.agents.length +
    results.rules.length +
    results.mem0.length +
    results.kg.length;

  if (total === 0) {
    return (
      <div className="p-4 text-xs text-[var(--color-text-tertiary)]">
        No results for &ldquo;{query}&rdquo;
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3">
      <p className="text-xs text-[var(--color-text-tertiary)]">
        {total} results for &ldquo;{query}&rdquo;
      </p>

      <ResultGroup
        icon="⚡"
        label="Skills"
        items={results.skills}
        renderItem={(s) => (
          <button
            key={s.name}
            onClick={() => onSelectSkill(s)}
            className="flex w-full items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-left hover:bg-[var(--color-surface-3)]"
          >
            <span className="text-xs">⚡</span>
            <span className="flex flex-col gap-0.5">
              <span className="text-xs font-medium">{s.name}</span>
              {s.description && (
                <span className="text-[10px] text-[var(--color-text-tertiary)] line-clamp-2">
                  {s.description}
                </span>
              )}
            </span>
          </button>
        )}
      />

      <ResultGroup
        icon="🤖"
        label="Agents"
        items={results.agents}
        renderItem={(a) => (
          <button
            key={a.name}
            onClick={() => onSelectAgent(a)}
            className="flex w-full items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-left hover:bg-[var(--color-surface-3)]"
          >
            <span className="text-xs">🤖</span>
            <span className="flex flex-col gap-0.5">
              <span className="text-xs font-medium">{a.name}</span>
              {a.description && (
                <span className="text-[10px] text-[var(--color-text-tertiary)] line-clamp-2">
                  {a.description}
                </span>
              )}
            </span>
          </button>
        )}
      />

      <ResultGroup
        icon="📋"
        label="Rules"
        items={results.rules}
        renderItem={(r) => (
          <button
            key={r.path}
            onClick={() => onSelectRule(r)}
            className="flex w-full items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-left hover:bg-[var(--color-surface-3)]"
          >
            <span className="text-xs">📋</span>
            <span className="flex flex-col gap-0.5">
              <span className="text-xs font-medium">{r.name}</span>
              <span className="text-[10px] text-[var(--color-text-tertiary)] line-clamp-1">
                {r.relative}
              </span>
            </span>
          </button>
        )}
      />

      <ResultGroup
        icon="🧠"
        label="Mem0"
        items={results.mem0}
        renderItem={(m) => (
          <button
            key={m.id}
            onClick={() => onSelectMem0(m)}
            className="flex w-full items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-left hover:bg-[var(--color-surface-3)]"
          >
            <span className="text-xs">🧠</span>
            <span className="text-[10px] line-clamp-2 text-[var(--color-text-primary)]">
              {m.memory}
            </span>
          </button>
        )}
      />

      <ResultGroup
        icon="🔷"
        label="Knowledge Graph"
        items={results.kg}
        renderItem={(e) => (
          <button
            key={e.name}
            onClick={() => onSelectKg(e)}
            className="flex w-full items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-left hover:bg-[var(--color-surface-3)]"
          >
            <span className="text-xs">🔷</span>
            <span className="flex flex-col gap-0.5">
              <span className="text-xs font-medium">{e.name}</span>
              <span className="text-[10px] text-[var(--color-text-tertiary)]">
                {e.entity_type} · {e.observations.length} obs
              </span>
            </span>
          </button>
        )}
      />
    </div>
  );
}

function ResultGroup<T>({
  icon,
  label,
  items,
  renderItem,
}: {
  icon: string;
  label: string;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
        <span>{icon}</span>
        {label}
        <span className="ml-1 rounded bg-[var(--color-surface-3)] px-1 py-px text-[9px]">
          {items.length}
        </span>
      </p>
      <div className="flex flex-col gap-1">{items.map(renderItem)}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export: MemoryTree
// ---------------------------------------------------------------------------

export function MemoryTree() {
  const [snapshot, setSnapshot] = useState<MemoryTreeSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Tree state
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(["root-skills", "root-agents", "root-rules", "root-kg"])
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);

  // Search
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<UnifiedSearchResults | null>(null);
  const searchAbortRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mem0 entries loaded separately (snapshot skips cloud call)
  const [mem0Entries, setMem0Entries] = useState<Mem0Memory[]>([]);

  // Load snapshot on mount
  useEffect(() => {
    setLoading(true);
    invoke<MemoryTreeSnapshot>("memory_tree_snapshot")
      .then((snap) => {
        setSnapshot(snap);
        setLoadError(null);
      })
      .catch((e: unknown) => setLoadError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Build tree nodes from snapshot
  const treeNodes = useMemo(() => {
    if (!snapshot) return [];
    return buildTree(snapshot, mem0Entries);
  }, [snapshot, mem0Entries]);

  // Toggle expand/collapse
  const handleToggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Select node
  const handleSelect = useCallback((node: TreeNode) => {
    setSelectedId(node.id);
    setSelectedNode(node);
  }, []);

  // Shortcuts to select from search results
  const selectSkill = useCallback(
    (s: SkillHit) => {
      const node: TreeNode = {
        id: `skill-${s.name}`,
        label: s.name,
        icon: "⚡",
        payload: { kind: "skill", skill: s },
      };
      setSelectedId(node.id);
      setSelectedNode(node);
    },
    []
  );
  const selectAgent = useCallback((a: AgentHit) => {
    const node: TreeNode = {
      id: `agent-${a.name}`,
      label: a.name,
      icon: "🤖",
      payload: { kind: "agent", agent: a },
    };
    setSelectedId(node.id);
    setSelectedNode(node);
  }, []);
  const selectRule = useCallback((r: RuleHit) => {
    const node: TreeNode = {
      id: `rule-${r.path}`,
      label: r.name,
      icon: "📋",
      payload: { kind: "rule", rule: r },
    };
    setSelectedId(node.id);
    setSelectedNode(node);
  }, []);
  const selectMem0 = useCallback((m: Mem0Memory) => {
    const node: TreeNode = {
      id: `mem0-${m.id}`,
      label: m.memory.slice(0, 60),
      icon: "🧠",
      payload: { kind: "mem0-entry", mem0: m },
    };
    setSelectedId(node.id);
    setSelectedNode(node);
  }, []);
  const selectKg = useCallback((e: KgEntity) => {
    const node: TreeNode = {
      id: `kg-entity-${e.name}`,
      label: e.name,
      icon: "🔷",
      payload: { kind: "kg-entity", kg: e },
    };
    setSelectedId(node.id);
    setSelectedNode(node);
  }, []);

  // Delete mem0 entry
  const handleDeleteMem0 = useCallback(async (id: string) => {
    try {
      await invoke("mem0_delete", { id });
      setMem0Entries((prev) => prev.filter((m) => m.id !== id));
      setSelectedNode(null);
      setSelectedId(null);
    } catch {
      // silently ignore — the UI will keep the entry visible
    }
  }, []);

  // Unified search with debounce
  useEffect(() => {
    if (searchAbortRef.current != null) {
      clearTimeout(searchAbortRef.current);
    }
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    searchAbortRef.current = setTimeout(() => {
      setSearching(true);
      invoke<UnifiedSearchResults>("memory_unified_search", {
        query: query.trim(),
        topK: 30,
      })
        .then((r) => setSearchResults(r))
        .catch(() => setSearchResults(null))
        .finally(() => setSearching(false));
    }, DEBOUNCE_MS);

    return () => {
      if (searchAbortRef.current != null) clearTimeout(searchAbortRef.current);
    };
  }, [query]);

  const showSearchResults = query.trim().length > 0;

  return (
    <div className="flex h-full flex-col gap-0 overflow-hidden">
      {/* Search bar — sticky top */}
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-tertiary)]">
            🔍
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en skills, agents, rules, mem0, KG…"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] py-1.5 pl-7 pr-3 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          {searching && (
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 animate-pulse text-[10px] text-[var(--color-text-tertiary)]">
              …
            </span>
          )}
        </div>
      </div>

      {/* Main body — tree + detail */}
      <div className="flex min-h-0 flex-1">
        {/* Left panel — tree */}
        <div
          className="flex shrink-0 flex-col overflow-y-auto border-r border-[var(--color-border)]"
          style={{ width: "280px" }}
          role="tree"
          aria-label="Memory tree"
        >
          {loading && (
            <div className="p-3 text-xs text-[var(--color-text-tertiary)]">
              Loading…
            </div>
          )}
          {loadError && (
            <div
              className="p-3 text-xs"
              style={{ color: "var(--color-danger)" }}
            >
              {loadError}
            </div>
          )}
          {!loading &&
            !loadError &&
            treeNodes.map((node) => (
              <TreeNodeRow
                key={node.id}
                node={node}
                depth={0}
                expanded={expanded}
                selected={selectedId}
                onToggle={handleToggle}
                onSelect={handleSelect}
              />
            ))}
        </div>

        {/* Right panel — detail or search results */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {showSearchResults ? (
            searchResults ? (
              <SearchResultsPanel
                results={searchResults}
                query={query}
                onSelectSkill={selectSkill}
                onSelectAgent={selectAgent}
                onSelectRule={selectRule}
                onSelectMem0={selectMem0}
                onSelectKg={selectKg}
              />
            ) : (
              <div className="p-4 text-xs text-[var(--color-text-tertiary)]">
                {searching ? "Buscando…" : "Sin resultados."}
              </div>
            )
          ) : (
            <DetailPane
              node={selectedNode}
              onDeleteMem0={handleDeleteMem0}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default MemoryTree;
