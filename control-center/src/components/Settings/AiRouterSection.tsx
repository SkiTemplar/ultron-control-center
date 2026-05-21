import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../../lib/dialog";
import type { AgentInfo } from "../../types";

// ---------------------------------------------------------------------------
// AI Router section — pick which provider runs which zone of the UI.
// Persisted to ~/.ultron/.tmp/ai-router.json by the Rust backend. Call sites
// (Diagnose PC, summarize newsletter, plan brainstorm, etc.) will pick this
// up in subsequent iterations; for now we just persist the config.
// ---------------------------------------------------------------------------

type AiProvider = "claude" | "codex" | "gemini";

type AiRouterEntry = {
  provider: AiProvider;
  // `null` (or absent) → use the provider's account default. Empty string is
  // treated like null on the frontend; the backend rejects "" on save.
  model: string | null;
  // v15.2.39: optional subagent slug (filename stem under
  // `~/.claude/agents/`). `null` = no subagent (historical behaviour).
  // When set AND the chosen provider is Claude, `spawn_session` prepends
  // `[USE AGENT: <slug>]` to the prompt. The backend treats empty string
  // as invalid on save, so the UI maps "(none)" → null before persisting.
  agent: string | null;
  // v15.2.40: when true, the frontend ignores the explicit
  // provider/model/agent at dispatch time and asks the agents Qdrant
  // index (`embed_agents.py query`) to pick the best subagent for the
  // prompt. Falls back to the manual config if the index is unavailable
  // or no agent scores above the confidence threshold.
  auto_mode?: boolean;
};

type AiRouterConfig = {
  diagnose: AiRouterEntry;
  summarize: AiRouterEntry;
  brainstorm_plans: AiRouterEntry;
  news_generate: AiRouterEntry;
  skill_edit: AiRouterEntry;
  mcp_create: AiRouterEntry;
  repo_review: AiRouterEntry;
  personal_analyse: AiRouterEntry;
  memory_analyse: AiRouterEntry;
  notif_fix: AiRouterEntry;
  self_improve: AiRouterEntry;
  system_analyse: AiRouterEntry;
  usage_analyse: AiRouterEntry;
  skill_create: AiRouterEntry;
};

const AI_PROVIDERS: AiProvider[] = ["claude", "codex", "gemini"];

// Hard-coded model choices per provider. Keeping this static (vs.
// shelling out to `codex --list-models` etc.) keeps the Settings tab
// snappy and avoids a second permission prompt on first paint. Power
// users editing `~/.ultron/.tmp/ai-router.json` by hand can pick any
// model string; the dropdown is just the curated set we know works.
const MODEL_OPTIONS: Record<AiProvider, string[]> = {
  claude: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
  codex: ["gpt-5.5", "gpt-5.4"],
  gemini: [
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-preview",
    "gemini-3.1-pro",
    "gemini-3.1-flash",
    "gemini-3.0-pro",
  ],
};

const AI_ROUTER_ZONES: { key: keyof AiRouterConfig; label: string; help: string }[] = [
  {
    key: "diagnose",
    label: "Diagnose PC",
    help: "Analysis of the system diagnostic report (Dashboard / Doctor).",
  },
  {
    key: "summarize",
    label: "Summarize newsletter",
    help: "Quick summary of an HTML newsletter from the News tab.",
  },
  {
    key: "brainstorm_plans",
    label: "Brainstorm plans",
    help: "Generate drafts / refine plan specs from the Plans tab.",
  },
  {
    key: "news_generate",
    label: "Generate newsletter",
    help: "Generation of the newsletter body (ULTRON Times).",
  },
  {
    key: "skill_edit",
    label: "Skill editor",
    help: "AI assistance when editing SKILL.md from the Skills tab.",
  },
  {
    key: "mcp_create",
    label: "MCP generator",
    help: "Generate MCP server templates from a description.",
  },
  {
    key: "repo_review",
    label: "Repo review",
    help: "Adversarial review of repos / uncommitted changes.",
  },
  {
    key: "personal_analyse",
    label: "Personal analyse",
    help: "Analyze profile / known.json / style fingerprint from the Personal tab.",
  },
  {
    key: "memory_analyse",
    label: "Memory analyse",
    help: "AI assistance when exploring the Memory tab (vault, graph, searches).",
  },
  {
    key: "notif_fix",
    label: "Notification fix",
    help: "Resolve a notification with Claude/Codex from the Notifications tab.",
  },
  {
    key: "self_improve",
    label: "Self-improve",
    help: "Analysis of routing telemetry to improve the dispatcher.",
  },
  {
    key: "system_analyse",
    label: "System analyse",
    help: "Analysis of processes / hooks / scheduled tasks from the System tab.",
  },
  {
    key: "usage_analyse",
    label: "Usage analyse",
    help: "Analysis of cost / tokens / activity from the Usage tab.",
  },
  {
    key: "skill_create",
    label: "Skill creator",
    help: "Create a new skill from scratch with AI assistance (AI button in Skills).",
  },
];

export function AiRouterSection() {
  const [config, setConfig] = useState<AiRouterConfig | null>(null);
  const [draft, setDraft] = useState<AiRouterConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // v15.2.39 — agent dropdown source. Populated once on mount; filtered
  // to drop any quarantined entries (the agents.rs backend has no
  // quarantine concept today, but if it ever grows one we already
  // tolerate the field). Empty list is OK — the dropdown falls back to
  // just "(none)" so the user can still pick provider+model.
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [r, a] = await Promise.all([
        invoke("read_ai_router") as Promise<AiRouterConfig>,
        invoke("list_agents") as Promise<AgentInfo[]>,
      ]);
      setConfig(r);
      setDraft({ ...r });
      // Filter quarantined / disabled agents if the backend ever surfaces
      // such a flag. `AgentInfo` carries no `state` today, so this is a
      // forward-compat noop. Sort alphabetically for a predictable list.
      const visible = (a ?? [])
        .filter((ag) => {
          // Heuristic: drop anything whose path lives under a
          // `quarantined/` directory. Same convention skills.rs uses.
          const p = (ag.path ?? "").toLowerCase().replace(/\\/g, "/");
          return !p.includes("/quarantined/");
        })
        .slice()
        .sort((x, y) => x.name.localeCompare(y.name));
      setAgents(visible);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const r = (await invoke("save_ai_router", { config: draft })) as AiRouterConfig;
      setConfig(r);
      setDraft({ ...r });
      setSuccess("AI Router updated.");
      window.setTimeout(() => setSuccess(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = useMemo(() => {
    if (!config || !draft) return false;
    return AI_ROUTER_ZONES.some((z) => {
      const a = config[z.key];
      const b = draft[z.key];
      return (
        a.provider !== b.provider ||
        (a.model ?? null) !== (b.model ?? null) ||
        (a.agent ?? null) !== (b.agent ?? null) ||
        (a.auto_mode ?? false) !== (b.auto_mode ?? false)
      );
    });
  }, [config, draft]);

  function updateProvider(key: keyof AiRouterConfig, provider: AiProvider) {
    if (!draft) return;
    // Changing the provider invalidates the previously selected model
    // (claude-opus-4-7 doesn't make sense for the codex provider), so we
    // reset to null = "provider default". The user can pick a model
    // afterwards from the new dropdown. We keep `agent` as the user set
    // it — agents are provider-agnostic on disk, and the backend only
    // honours them for Claude sessions today (codex/gemini ignore the
    // directive). If the user really wanted a Claude-only agent on a
    // codex zone they can clear it manually.
    setDraft({
      ...draft,
      [key]: { ...draft[key], provider, model: null },
    });
  }

  function updateModel(key: keyof AiRouterConfig, model: string) {
    if (!draft) return;
    // Empty string from the select = "use provider default" → store as null
    // so the backend sees a clean missing-model state (it rejects "").
    const next: AiRouterEntry = {
      ...draft[key],
      model: model === "" ? null : model,
    };
    setDraft({ ...draft, [key]: next });
  }

  function updateAgent(key: keyof AiRouterConfig, agent: string) {
    if (!draft) return;
    // Empty string = "(none)" → null. Backend rejects "" on save.
    const next: AiRouterEntry = {
      ...draft[key],
      agent: agent === "" ? null : agent,
    };
    setDraft({ ...draft, [key]: next });
  }

  function updateAutoMode(key: keyof AiRouterConfig, auto: boolean) {
    if (!draft) return;
    // Auto-mode is orthogonal to the manual picks — we keep them so the user
    // can toggle back without losing their config. The backend resolver in
    // `resolve_zone_for_prompt` is the single place that interprets the
    // flag and decides between "use manual" vs. "query the agents index".
    setDraft({
      ...draft,
      [key]: { ...draft[key], auto_mode: auto },
    });
  }

  return (
    <div className="space-y-4">
      <header>
        <h3 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          AI Router
        </h3>
        <p
          className="mt-1 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Pick which provider and model fires each Control Center action:
          Diagnose PC, summarize newsletter, AI plan brainstorm, newsletter
          generation, skill editor, MCP generator and repo review. The second
          dropdown (model) is optional — leave it on{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>default</span> to use
          the provider's default model. The config is persisted to{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            ~/.ultron/.tmp/ai-router.json
          </span>{" "}
          so any ULTRON script can read it.
        </p>
      </header>

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

      {success && (
        <div
          className="rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}

      {loading && !draft && (
        <div
          className="rounded p-4 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Loading…
        </div>
      )}

      {draft && (
        <>
          <div
            className="rounded"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            {AI_ROUTER_ZONES.map((z, i) => {
              const autoMode = draft[z.key].auto_mode ?? false;
              return (
                <div
                  key={z.key}
                  className="flex items-start gap-4 px-3 py-3"
                  style={{
                    borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-[12.5px] font-medium"
                      style={{ color: "var(--color-text)" }}
                    >
                      {z.label}
                    </div>
                    <p
                      className="mt-0.5 text-[11px] leading-relaxed"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {z.help}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label
                      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11.5px]"
                      style={{
                        background: autoMode
                          ? "rgba(88, 166, 255, 0.10)"
                          : "var(--color-surface-1)",
                        color: autoMode
                          ? "rgb(88, 166, 255)"
                          : "var(--color-text-tertiary)",
                        border: `1px solid ${autoMode ? "rgba(88, 166, 255, 0.45)" : "var(--color-border-strong)"}`,
                        fontFamily: "var(--font-mono)",
                      }}
                      title={
                        "Auto-mode: ignores the selectors on the right and lets " +
                        "ULTRON pick the subagent automatically based on the " +
                        "prompt content. Uses embed_agents.py query " +
                        "(Qdrant) and requires score ≥ 0.50; if it fails or the " +
                        "match is weak, it falls back to the manual " +
                        "provider/model/agent with no visible error. Effective " +
                        "provider = claude when auto-mode hits (required for the " +
                        "[USE AGENT: <slug>] directive)."
                      }
                    >
                      <input
                        type="checkbox"
                        checked={autoMode}
                        onChange={(e) => updateAutoMode(z.key, e.target.checked)}
                        disabled={saving}
                        style={{ accentColor: "rgb(88, 166, 255)" }}
                      />
                      auto
                    </label>
                    <select
                      value={draft[z.key].provider}
                      onChange={(e) =>
                        updateProvider(z.key, e.target.value as AiProvider)
                      }
                      disabled={saving || autoMode}
                      className="rounded px-2 py-1 text-[12px]"
                      style={{
                        background: "var(--color-surface-1)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                        outline: "none",
                        fontFamily: "var(--font-mono)",
                        minWidth: 110,
                        opacity: autoMode ? 0.45 : 1,
                      }}
                      title={
                        autoMode
                          ? "Auto-mode active — this selection is ignored and only used as a fallback."
                          : `Provider for ${z.label}`
                      }
                    >
                      {AI_PROVIDERS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <select
                      value={draft[z.key].model ?? ""}
                      onChange={(e) => updateModel(z.key, e.target.value)}
                      disabled={saving || autoMode}
                      className="rounded px-2 py-1 text-[12px]"
                      style={{
                        background: "var(--color-surface-1)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                        outline: "none",
                        fontFamily: "var(--font-mono)",
                        minWidth: 170,
                        opacity: autoMode ? 0.45 : 1,
                      }}
                      title={
                        autoMode
                          ? "Auto-mode uses the preferred model of the chosen agent (frontmatter `model`)."
                          : `Model for ${z.label} (empty = provider default)`
                      }
                    >
                      <option value="">default</option>
                      {MODEL_OPTIONS[draft[z.key].provider].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <select
                      value={draft[z.key].agent ?? ""}
                      onChange={(e) => updateAgent(z.key, e.target.value)}
                      disabled={saving || autoMode}
                      className="rounded px-2 py-1 text-[12px]"
                      style={{
                        background: "var(--color-surface-1)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                        outline: "none",
                        fontFamily: "var(--font-mono)",
                        minWidth: 170,
                        opacity: autoMode ? 0.45 : 1,
                      }}
                      title={
                        autoMode
                          ? "Auto-mode picks the agent via embed_agents.py query."
                          : draft[z.key].provider === "claude"
                          ? `Subagent for ${z.label} ((none) = no subagent). Only applies to Claude sessions.`
                          : `Subagent for ${z.label} — ${draft[z.key].provider} ignores the directive, only Claude interprets it.`
                      }
                    >
                      <option value="">(none)</option>
                      {agents.map((ag) => (
                        <option key={ag.name} value={ag.name}>
                          {ag.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={async () => {
                if (
                  !(await confirmDialog(
                    "Reset every zone to ULTRON's recommended provider + model + agent? Your current overrides will be lost.",
                    { title: "Reset AI Router", kind: "warning" },
                  ))
                ) {
                  return;
                }
                setSaving(true);
                setError(null);
                setSuccess(null);
                try {
                  const r = (await invoke(
                    "reset_ai_router_to_defaults"
                  )) as AiRouterConfig;
                  setConfig(r);
                  setDraft({ ...r });
                  setSuccess("Reset to ULTRON recommended defaults.");
                } catch (e) {
                  setError(String(e));
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              title="Re-apply the curated agent + model per zone (debugger for diagnose, mcp-developer for MCP generator, ultron-context for memory, etc.). Overrides your current config."
              className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              Reset to ULTRON recommended
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => config && setDraft({ ...config })}
                disabled={!dirty || saving}
                className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Discard
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!dirty || saving}
                className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
