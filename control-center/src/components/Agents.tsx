import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type {
  AgentInfo,
  AgentMutationResult,
  AgentSecurityReport,
  AllowAgentResult,
} from "../types";
import { getHomeDir, joinPath } from "../lib/paths";
import { useRoutingTitle } from "../lib/button-prompts";
import { SecurityPanel } from "./SecurityPanel";
import { HeaderBtn, KindBadge, Pill, SkillAgentRow } from "./SkillAgentShared";
import { SkillRichView } from "./SkillRichView";

// ---------------------------------------------------------------------------
// Agents tab — sister to Skills, scoped to ~/.claude/agents/*.md.
// Same UX (list / preview / edit / delete / AI-assist), now plus the
// prompt-injection scanner pass and Allow-anyway flow. The Security
// panel is shared with Skills via <SecurityPanel/>; the per-agent
// badge in each Row uses the shared `securityHintFromInfo` helper so
// colour/copy stay in lock-step across the two tabs.
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
    <SkillAgentRow
      name={agent.name}
      description={agent.description ?? null}
      selected={selected}
      onClick={onClick}
      security={agent.security ?? null}
      leftBadge={
        <KindBadge
          label="agent"
          bg="rgba(63, 185, 80, 0.08)"
          color="var(--color-success)"
        />
      }
      rightMeta={
        agent.model ? (
          <span
            className="shrink-0 text-[10.5px]"
            style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
            title={agent.model}
          >
            {agent.model.length > 18 ? agent.model.slice(0, 16) + "…" : agent.model}
          </span>
        ) : undefined
      }
    />
  );
}

type PreviewMode = "view" | "edit" | "confirm-delete" | "security";

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
  // Security drawer state. The reason textarea + submit button live
  // inside the shared <SecurityPanel/>; we only keep RPC coordination
  // state here (the report, in-flight flag, transient error).
  const [secReport, setSecReport] = useState<AgentSecurityReport | null>(null);
  const [secLoading, setSecLoading] = useState(false);
  const [secError, setSecError] = useState<string | null>(null);
  const [allowBusy, setAllowBusy] = useState(false);
  const aiEditTitle = useRoutingTitle(
    "agents.edit_with_ai",
    "Open a Claude session to refine this agent with AI assistance.",
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);
    // Security-first preview: if the agent already carries a non-allow
    // verdict in its registry entry, open the Security panel up front so
    // the findings are foreground. Otherwise the user lands on the
    // normal preview.
    const hasFindings = !!agent.security && agent.security.decision !== "allow";
    setMode(hasFindings ? "security" : "view");
    setSecReport(null);
    setSecError(null);
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
    if (hasFindings) {
      setSecLoading(true);
      invoke<AgentSecurityReport>("get_agent_findings", { name: agent.name })
        .then((r) => {
          if (!cancelled) setSecReport(r);
        })
        .catch((e) => {
          if (!cancelled) setSecError(String(e));
        })
        .finally(() => {
          if (!cancelled) setSecLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [agent.name]);

  async function openSecurity() {
    setMode("security");
    setSecError(null);
    setSecLoading(true);
    setSecReport(null);
    try {
      const report = await invoke<AgentSecurityReport>("get_agent_findings", {
        name: agent.name,
      });
      setSecReport(report);
    } catch (e) {
      setSecError(String(e));
    } finally {
      setSecLoading(false);
    }
  }

  // Called by the shared SecurityPanel once the user submits a non-empty
  // reason and there is at least one active finding.
  async function handleAllowAnyway(rules: string[], reason: string) {
    if (allowBusy) return;
    setAllowBusy(true);
    setSecError(null);
    try {
      if (rules.length === 0) {
        setSecError("No active findings to waive.");
        setAllowBusy(false);
        return;
      }
      const res = await invoke<AllowAgentResult>("allow_agent_manually", {
        name: agent.name,
        rules,
        reason,
      });
      flash(
        `Waiver written (sha1 ${res.sha1.slice(0, 10)}…). Re-run an agent scan to refresh.`,
      );
      setMode("view");
      onMutated();
    } catch (e) {
      setSecError(String(e));
    } finally {
      setAllowBusy(false);
    }
  }

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

  async function handleSendToVault() {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<AgentMutationResult>("send_agent_to_vault", { name: agent.name });
      flash(`Moved to vault: ${res.backup_path ?? "(unknown)"}`);
      onDeleted();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function openInClaude() {
    try {
      const agentsDir = joinPath(await getHomeDir(), ".claude", "agents");
      // v15.2: prompt comes from the central catalog
      // (key "agents.edit_with_ai"). Editable via Settings → Button prompts.
      const { getPrompt } = await import("../lib/button-prompts");
      const prompt = await getPrompt("agents.edit_with_ai", {
        agent_name: agent.name,
      });
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: agentsDir,
        flags: { dangerouslySkipPermissions: false },
      });
      flash("Claude session opened in ~/.claude/agents/");
    } catch (e) {
      setError(String(e));
    }
  }

  // Open the parent directory of the agent's .md file in Windows
  // Explorer. We pass the dir (not the file) because openPath on a .md
  // would launch the registered handler instead of revealing it. Falls
  // back to the canonical ~/.claude/agents/ if the registry didn't
  // populate `agent.path` for some reason.
  async function openFolder() {
    try {
      const file = agent.path ?? "";
      const dir = file
        ? file.replace(/[\\/][^\\/]+$/, "")
        : joinPath(await getHomeDir(), ".claude", "agents");
      await openPath(dir);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex items-center gap-2">
          <KindBadge
            label="agent"
            bg="rgba(63, 185, 80, 0.08)"
            color="var(--color-success)"
          />
          <h2 className="text-[15px] font-semibold leading-none">{agent.name}</h2>
          <div className="ml-auto flex items-center gap-1.5">
            {mode === "view" && (
              <>
                <HeaderBtn
                  label="Folder"
                  onClick={() => void openFolder()}
                  disabled={busy || loading}
                  title="Open ~/.claude/agents/ in Windows Explorer"
                />
                <HeaderBtn
                  label="Edit"
                  onClick={() => setMode("edit")}
                  disabled={busy || loading}
                />
                <HeaderBtn
                  label="AI"
                  onClick={() => void openInClaude()}
                  disabled={busy || loading}
                  title={aiEditTitle}
                />
                {agent.security && agent.security.decision !== "allow" && (
                  <HeaderBtn
                    label="Security"
                    variant="danger"
                    onClick={() => void openSecurity()}
                    disabled={busy || loading}
                    title="Open the prompt-injection scan report for this agent"
                  />
                )}
                <HeaderBtn
                  label="Vault"
                  onClick={() => void handleSendToVault()}
                  disabled={busy || loading}
                  title="Move this agent to ~/.ultron/agent-vault/ (Claude stops auto-loading it; restore from the Vault panel)"
                />
                <HeaderBtn
                  label="Delete"
                  variant="danger"
                  onClick={() => setMode("confirm-delete")}
                  disabled={busy || loading}
                />
              </>
            )}
            {mode === "security" && (
              <HeaderBtn
                label="Close"
                onClick={() => {
                  setMode("view");
                  setSecError(null);
                }}
                disabled={allowBusy}
              />
            )}
            {mode === "edit" && (
              <>
                <HeaderBtn
                  label="Cancel"
                  onClick={() => {
                    setDraft(content);
                    setMode("view");
                    setError(null);
                  }}
                />
                <HeaderBtn
                  label={busy ? "Saving…" : "Save"}
                  onClick={() => void saveEdit()}
                  disabled={busy || draft === content}
                />
              </>
            )}
            {mode === "confirm-delete" && (
              <HeaderBtn label="Cancel" onClick={() => setMode("view")} />
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
            <HeaderBtn
              label={busy ? "Archiving…" : "Archive"}
              variant="danger"
              onClick={() => void handleDelete()}
              disabled={busy}
            />
          </div>
        )}
        <SecurityPanel
          open={mode === "security"}
          loading={secLoading}
          error={secError}
          report={secReport}
          busy={allowBusy}
          onAllow={(rules, reason) => void handleAllowAnyway(rules, reason)}
          targetLabel="agent"
        />
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
          <div
            style={{
              // Dim the body when the Security panel is open so the
              // findings drawer is the visual foreground — mirrors the
              // Skills tab's behaviour.
              opacity: mode === "security" ? 0.35 : 1,
              filter: mode === "security" ? "grayscale(0.7)" : "none",
              transition: "opacity 120ms, filter 120ms",
              pointerEvents: mode === "security" ? "none" : "auto",
            }}
          >
            <SkillRichView raw={content} />
          </div>
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

type VaultedAgent = { name: string; description: string };

export function Agents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [vaulted, setVaulted] = useState<VaultedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [onlyQuarantined, setOnlyQuarantined] = useState(false);
  const [showVault, setShowVault] = useState(false);
  const [vaultBusy, setVaultBusy] = useState<string | null>(null);

  function reload(): Promise<AgentInfo[]> {
    void invoke<VaultedAgent[]>("list_vaulted_agents")
      .then((vlist) => setVaulted(vlist))
      .catch(() => setVaulted([]));
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

  async function restoreFromVault(name: string) {
    setVaultBusy(name);
    try {
      await invoke("restore_agent_from_vault", { name });
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setVaultBusy(null);
    }
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Count agents whose pre-computed security verdict is anything other
  // than "allow". This is best-effort: if no registry has populated
  // `security` yet, the count stays at 0 and the pill becomes a no-op.
  const quarantinedCount = useMemo(
    () =>
      agents.filter(
        (a) => !!a.security && a.security.decision !== "allow",
      ).length,
    [agents],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents
      .filter((a) => {
        if (!onlyQuarantined) return true;
        return !!a.security && a.security.decision !== "allow";
      })
      .filter((a) => {
        if (!q) return true;
        return (
          a.name.toLowerCase().includes(q) ||
          (a.description ?? "").toLowerCase().includes(q)
        );
      });
  }, [agents, query, onlyQuarantined]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.name === selected) ?? null,
    [agents, selected],
  );

  // v15.3.3: Discover button removed per user request. People who want
  // new agents can open a Claude session in ~/.claude/agents/ themselves
  // or browse cockpit/agent-catalog.json directly. Keeping the button
  // was clutter, and the prompt was unique enough that surfacing it as
  // a built-in implied ULTRON endorsed those specific repos.

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
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Pill
              label="Quarantined"
              count={quarantinedCount}
              color="#e8a93a"
              active={onlyQuarantined}
              onClick={() => setOnlyQuarantined(!onlyQuarantined)}
            />
            <Pill
              label="Vault"
              count={vaulted.length}
              color="#7c83ff"
              active={showVault}
              onClick={() => setShowVault(!showVault)}
            />
          </div>
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
              No agents installed yet. Browse <code>cockpit/agent-catalog.json</code> for curated picks
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
          {showVault && (
            <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
              <div className="px-3 pb-2 text-[11px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Vaulted ({vaulted.length}) — not auto-loaded by Claude
              </div>
              {vaulted.length === 0 && (
                <div className="px-3 py-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                  Nothing in the vault. Use the "Vault" button in an agent's detail pane to demote it here.
                </div>
              )}
              {vaulted.map((v) => (
                <div
                  key={v.name}
                  className="flex items-center justify-between gap-2 rounded px-3 py-2 text-[12px]"
                  style={{ background: "var(--color-surface-2)" }}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{v.name}</div>
                    <div className="truncate text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                      {v.description || "(no description)"}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={vaultBusy === v.name}
                    onClick={() => void restoreFromVault(v.name)}
                    className="shrink-0 rounded px-2 py-0.5 text-[11px]"
                    style={{
                      background: "var(--color-accent)",
                      color: "var(--color-accent-text)",
                      opacity: vaultBusy === v.name ? 0.5 : 1,
                    }}
                  >
                    {vaultBusy === v.name ? "…" : "Restore"}
                  </button>
                </div>
              ))}
            </div>
          )}
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
