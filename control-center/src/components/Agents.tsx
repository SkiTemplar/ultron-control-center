import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentInfo, AgentMutationResult } from "../types";
import { getHomeDir, joinPath } from "../lib/paths";

// ---------------------------------------------------------------------------
// Agents tab — sister to Skills, scoped to ~/.claude/agents/*.md.
// Same UX (list / preview / edit / delete / AI-assist) but tailored to
// the simpler agent shape (no quarantine flow in the first cut — we add
// the prompt-injection scanner pass in a follow-up release).
// ---------------------------------------------------------------------------

const NEW_AGENT_TEMPLATE = `You are <role>. <One-line purpose>.

## Responsibilities
- Bullet what this agent is for
- Add concrete examples

## Approach
- How it should work
- Tools it uses

## Output
- What it returns
`;

function fmtRelative(ts: number | null): string {
  if (!ts) return "";
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function Row({
  agent,
  selected,
  onClick,
}: {
  agent: AgentInfo;
  selected: boolean;
  onClick: () => void;
}) {
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
          (e.currentTarget as HTMLButtonElement).style.background = "var(--color-surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <span
        className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide tabular-nums"
        style={{
          background: "rgba(63, 185, 80, 0.08)",
          color: "var(--color-success)",
          minWidth: 56,
          textAlign: "center",
        }}
      >
        agent
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium" style={{ color: "var(--color-text)" }}>
          {agent.name}
        </div>
        {agent.description && (
          <div className="truncate text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {agent.description}
          </div>
        )}
      </div>
      {agent.model && (
        <span
          className="shrink-0 text-[10.5px]"
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
          title={agent.model}
        >
          {agent.model.length > 18 ? agent.model.slice(0, 16) + "…" : agent.model}
        </span>
      )}
    </button>
  );
}

type PreviewMode = "view" | "edit" | "confirm-delete";

function Preview({
  agent,
  onMutated,
  onDeleted,
}: {
  agent: AgentInfo;
  onMutated: () => void;
  onDeleted: () => void;
}) {
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<PreviewMode>("view");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);
    setMode("view");
    invoke<string>("read_agent_md", { name: agent.name })
      .then((c) => {
        if (!cancelled) {
          setContent(c);
          setDraft(c);
        }
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
  }, [agent.name]);

  function flash(msg: string) {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 2500);
  }

  async function saveEdit() {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<AgentMutationResult>("update_agent_md", {
        name: agent.name,
        content: draft,
      });
      setContent(draft);
      setMode("view");
      flash(`Saved. Backup at ${res.backup_path ?? "(none)"}`);
      onMutated();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<AgentMutationResult>("delete_agent", { name: agent.name });
      flash(`Archived to ${res.backup_path ?? "(unknown)"}`);
      onDeleted();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function openInClaude() {
    try {
      const agentsDir = joinPath(await getHomeDir(), ".claude", "agents");
      const prompt = [
        `Quiero editar este agent (~/.claude/agents/${agent.name}.md).`,
        "",
        "Lee primero el archivo y proponme cambios concretos. Mantén el frontmatter YAML válido.",
      ].join("\n");
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: agentsDir,
        flags: { dangerouslySkipPermissions: false },
      });
      flash("Claude session abierta en ~/.claude/agents/");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex items-center gap-2">
          <span
            className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
            style={{ background: "rgba(63, 185, 80, 0.08)", color: "var(--color-success)" }}
          >
            agent
          </span>
          <h2 className="text-[15px] font-semibold leading-none">{agent.name}</h2>
          <div className="ml-auto flex items-center gap-1.5">
            {mode === "view" && (
              <>
                <button
                  type="button"
                  onClick={() => setMode("edit")}
                  disabled={busy || loading}
                  className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void openInClaude()}
                  disabled={busy || loading}
                  className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                  title="Abre una sesión Claude para refinar este agent con asistencia AI"
                >
                  AI
                </button>
                <button
                  type="button"
                  onClick={() => setMode("confirm-delete")}
                  disabled={busy || loading}
                  className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-danger)",
                    border: "1px solid rgba(248, 81, 73, 0.32)",
                  }}
                >
                  Delete
                </button>
              </>
            )}
            {mode === "edit" && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(content);
                    setMode("view");
                    setError(null);
                  }}
                  className="rounded px-2 py-1 text-[11px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveEdit()}
                  disabled={busy || draft === content}
                  className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </>
            )}
            {mode === "confirm-delete" && (
              <button
                type="button"
                onClick={() => setMode("view")}
                className="rounded px-2 py-1 text-[11px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
        {agent.description && (
          <p
            className="mt-2 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {agent.description}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {agent.model && (
            <span
              className="rounded px-1.5 py-px text-[10px]"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}
              title="default model"
            >
              {agent.model}
            </span>
          )}
          {agent.tools.map((t) => (
            <span
              key={t}
              className="rounded px-1.5 py-px text-[10px]"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}
            >
              {t}
            </span>
          ))}
        </div>
        {agent.path && (
          <div
            className="mt-2 truncate text-[10.5px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
            title={agent.path}
          >
            {agent.path}
          </div>
        )}
        {status && (
          <div
            className="mt-2 rounded px-2 py-1 text-[11px]"
            style={{
              background: "rgba(63, 185, 80, 0.08)",
              color: "var(--color-success)",
              border: "1px solid rgba(63, 185, 80, 0.22)",
            }}
          >
            {status}
          </div>
        )}
        {error && (
          <div
            className="mt-2 rounded px-2 py-1 text-[11px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}
        {mode === "confirm-delete" && (
          <div
            className="mt-3 flex flex-wrap items-center gap-2 rounded p-2 text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text-secondary)",
            }}
          >
            <span>Confirm: archive this agent? (copied to ~/.ultron/backups/agent-deleted/)</span>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={busy}
              className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
              style={{
                background: "rgba(248, 81, 73, 0.10)",
                color: "var(--color-danger)",
                border: "1px solid rgba(248, 81, 73, 0.32)",
              }}
            >
              {busy ? "Archiving…" : "Archive"}
            </button>
          </div>
        )}
      </header>
      <div className="flex-1 overflow-auto px-5 py-4">
        {loading && (
          <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Loading agent file…
          </div>
        )}
        {!loading && mode === "edit" && (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none rounded p-3 text-[11.5px] leading-relaxed"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
              minHeight: 320,
            }}
          />
        )}
        {!loading && mode !== "edit" && (
          <pre
            className="whitespace-pre-wrap text-[11.5px] leading-relaxed"
            style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}
          >
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

function NewAgentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(NEW_AGENT_TEMPLATE);
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [toolsRaw, setToolsRaw] = useState("Read, Glob, Grep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugOk = SLUG_RE.test(name);
  const descOk = description.trim().length > 0 && description.trim().length <= 600;
  const canSubmit = slugOk && descOk && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const tools = toolsRaw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const res = await invoke<AgentMutationResult>("create_agent", {
        name,
        description: description.trim(),
        body,
        model: model.trim() || null,
        tools,
      });
      onCreated(res.name);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[640px] flex-col overflow-hidden rounded"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-strong)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h2 className="text-[14px] font-semibold">New agent</h2>
          <button type="button" onClick={onClose} className="px-2 py-0.5 text-[12px]" aria-label="Close">
            ×
          </button>
        </header>
        <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Slug
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-new-agent"
              className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: `1px solid ${name && !slugOk ? "rgba(248, 81, 73, 0.4)" : "var(--color-border-strong)"}`,
                outline: "none",
                fontFamily: "var(--font-mono)",
              }}
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this agent does — used by Claude to decide when to spawn it"
              maxLength={600}
              className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Default model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Tools (comma-separated)
              </label>
              <input
                type="text"
                value={toolsRaw}
                onChange={(e) => setToolsRaw(e.target.value)}
                className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                }}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
              Body (frontmatter auto-prepended)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              className="w-full rounded p-2.5 text-[11.5px] leading-relaxed"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
                fontFamily: "var(--font-mono)",
                minHeight: 220,
                resize: "vertical",
              }}
            />
          </div>
          {error && (
            <div
              className="rounded p-2 text-[11.5px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
              }}
            >
              {error}
            </div>
          )}
        </div>
        <footer
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1 text-[11px] disabled:opacity-40"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded px-3 py-1 text-[11px] font-medium disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {busy ? "Creating…" : "Create agent"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function Agents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  function reload(): Promise<AgentInfo[]> {
    return invoke<AgentInfo[]>("list_agents")
      .then((list) => {
        setAgents(list);
        setError(null);
        return list;
      })
      .catch((e) => {
        setError(String(e));
        return [] as AgentInfo[];
      });
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q),
    );
  }, [agents, query]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.name === selected) ?? null,
    [agents, selected],
  );

  async function discoverOnline() {
    try {
      const home = await getHomeDir();
      const prompt = [
        "Busca agentes Claude Code útiles publicados en GitHub (anthropics/claude-code-templates, voltagent/awesome-claude-code-subagents, addyosmani/agent-skills, anthropic-cookbook). Lista 8-12 agentes con:",
        "- nombre (slug kebab-case)",
        "- una línea de descripción",
        "- URL del archivo .md raw en GitHub",
        "- por qué es útil",
        "",
        "Después pregúntame cuáles quiero instalar y los descargas a ~/.claude/agents/<name>.md. Mantén el formato YAML frontmatter intacto.",
      ].join("\n");
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: joinPath(home, ".claude", "agents"),
        flags: { dangerouslySkipPermissions: false },
      });
    } catch (e) {
      console.error("discover online failed", e);
    }
  }

  return (
    <div className="flex h-full">
      <div
        className="flex w-[44%] min-w-[420px] flex-col overflow-hidden border-r"
        style={{ borderColor: "var(--color-border)" }}
      >
        <header className="border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-[18px] font-semibold leading-tight">Agents</h1>
              <p className="mt-1 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
                {agents.length} agent{agents.length === 1 ? "" : "s"} in ~/.claude/agents/ ·
                {" "}
                {filtered.length} shown
              </p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                onClick={() => void discoverOnline()}
                className="rounded px-2.5 py-1 text-[11.5px] font-medium"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title="Open a Claude session that searches GitHub for community agents and offers to install them"
              >
                Discover
              </button>
              <button
                type="button"
                onClick={() => setShowNew(true)}
                className="rounded px-2.5 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                + New
              </button>
            </div>
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents by name or description…"
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
          {!loading && filtered.length === 0 && agents.length > 0 && (
            <div className="px-3 py-4 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              No agents match the current search.
            </div>
          )}
          {!loading && agents.length === 0 && !error && (
            <div className="m-2 rounded p-4 text-[12px]" style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text-tertiary)",
            }}>
              No agents installed yet. Use <b>Discover</b> to find community agents on GitHub
              or <b>+ New</b> to write one from scratch.
            </div>
          )}
          <div className="space-y-px">
            {filtered.map((a) => (
              <Row
                key={a.name}
                agent={a}
                selected={selected === a.name}
                onClick={() => setSelected(a.name)}
              />
            ))}
          </div>
          {!loading && agents.length > 0 && (
            <div
              className="mt-3 px-3 py-2 text-[10.5px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              Last sync: {agents[0]?.last_modified ? fmtRelative(agents[0].last_modified) : "—"}
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {selectedAgent ? (
          <Preview
            key={selectedAgent.name}
            agent={selectedAgent}
            onMutated={() => {
              void reload();
            }}
            onDeleted={() => {
              const removed = selectedAgent.name;
              void reload().then((list) => {
                if (!list.some((a) => a.name === removed)) {
                  setSelected(null);
                }
              });
            }}
          />
        ) : (
          <div
            className="flex h-full items-center justify-center text-[13px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Select an agent to preview its definition
          </div>
        )}
      </div>
      {showNew && (
        <NewAgentModal
          onClose={() => setShowNew(false)}
          onCreated={(name) => {
            setShowNew(false);
            void reload().then(() => setSelected(name));
          }}
        />
      )}
    </div>
  );
}
