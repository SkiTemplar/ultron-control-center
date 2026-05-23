import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  McpInfo,
  McpStatus,
  McpMutationResult,
  McpGenerationResult,
  McpPingResult,
  SettingsSnapshot,
  SettingsSaveResult,
} from "../types";
import { useRoutingTitle } from "../lib/button-prompts";

// ---------------------------------------------------------------------------
// Status visuals
// ---------------------------------------------------------------------------

const HIDE_KEY = "ultron.cc.hidden_mcps.v1";
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,60}$/;

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function saveHidden(s: Set<string>) {
  try {
    localStorage.setItem(HIDE_KEY, JSON.stringify(Array.from(s)));
  } catch {}
}

function statusColor(s: McpStatus, expectedOffline: boolean): string {
  if (s === "ok") return "var(--color-success)";
  if (s === "degraded" || s === "missing") {
    return expectedOffline ? "var(--color-text-tertiary)" : "var(--color-warn)";
  }
  return "var(--color-text-faint)";
}

// v2.0 origin chip — Claudia-compatible provenance tagging. The backend
// now merges three sources: user settings.json, plugin .mcp.json files,
// and project-level .mcp.json files. The chip lets the user see at a
// glance where a given MCP came from (and why it can't be edited from
// here when it's plugin-owned).
type McpOriginKind = "user" | "project" | "plugin" | "unknown";

function parseOrigin(o: string | undefined): { kind: McpOriginKind; label: string } {
  if (!o) return { kind: "unknown", label: "?" };
  if (o === "user") return { kind: "user", label: "user" };
  if (o.startsWith("project:")) {
    return { kind: "project", label: o.slice("project:".length) || "project" };
  }
  if (o.startsWith("plugin:")) {
    return { kind: "plugin", label: o.slice("plugin:".length) || "plugin" };
  }
  return { kind: "unknown", label: o };
}

function originBadgeColor(kind: McpOriginKind): { bg: string; fg: string } {
  switch (kind) {
    case "user":
      return { bg: "rgba(56, 139, 253, 0.12)", fg: "var(--color-accent, #58a6ff)" };
    case "project":
      return { bg: "rgba(63, 185, 80, 0.12)", fg: "var(--color-success)" };
    case "plugin":
      return { bg: "rgba(163, 113, 247, 0.12)", fg: "#a371f7" };
    default:
      return { bg: "var(--color-surface-3)", fg: "var(--color-text-secondary)" };
  }
}

// Extended view of McpInfo that includes the v2.0 origin/plugin fields.
// types.ts is shared with other components; once it's updated the cast
// here can go away.
type McpInfoExt = McpInfo & { origin?: string; plugin?: string | null };

function statusLabel(s: McpStatus, expectedOffline: boolean): string {
  if (s === "ok") return "connected";
  if (s === "degraded") return expectedOffline ? "offline" : "degraded";
  if (s === "missing") return "missing";
  if (s === "unknown") return "unknown";
  return s;
}

// ---------------------------------------------------------------------------
// Editable MCP config (the form's working model)
// ---------------------------------------------------------------------------

type Transport = "stdio" | "http" | "sse";

type EditableMcp = {
  name: string;
  transport: Transport;
  command: string;
  argsText: string; // one arg per line
  envRows: { key: string; value: string }[];
  url: string;
};

function blankMcp(): EditableMcp {
  return {
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    envRows: [],
    url: "",
  };
}

function configToEditable(name: string, cfg: Record<string, unknown>): EditableMcp {
  const transportRaw = (cfg.type as string) ?? "";
  const url = (cfg.url as string) ?? "";
  let transport: Transport;
  if (transportRaw === "sse") transport = "sse";
  else if (url) transport = "http";
  else transport = "stdio";

  const args = Array.isArray(cfg.args) ? (cfg.args as string[]) : [];
  const env = (cfg.env && typeof cfg.env === "object" ? cfg.env : {}) as Record<
    string,
    string
  >;

  return {
    name,
    transport,
    command: (cfg.command as string) ?? "",
    argsText: args.join("\n"),
    envRows: Object.entries(env).map(([k, v]) => ({ key: k, value: String(v) })),
    url,
  };
}

function editableToConfig(m: EditableMcp): Record<string, unknown> {
  if (m.transport === "http" || m.transport === "sse") {
    const out: Record<string, unknown> = { url: m.url.trim() };
    if (m.transport === "sse") out.type = "sse";
    return out;
  }
  const args = m.argsText
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const env: Record<string, string> = {};
  for (const r of m.envRows) {
    const k = r.key.trim();
    if (k) env[k] = r.value;
  }
  const out: Record<string, unknown> = {
    command: m.command.trim(),
    args,
  };
  if (Object.keys(env).length > 0) out.env = env;
  return out;
}

function validateEditable(m: EditableMcp): string | null {
  if (!NAME_RE.test(m.name)) {
    return "Name must match ^[a-z0-9][a-z0-9_-]{1,60}$ (lowercase, digits, _ or -).";
  }
  if (m.transport === "stdio") {
    if (!m.command.trim()) return "Command is required for stdio transport.";
  } else {
    if (!m.url.trim()) return "URL is required for http/sse transport.";
    try {
      new URL(m.url.trim());
    } catch {
      return "URL is not a valid URL.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Add / Edit modal — shared form
// ---------------------------------------------------------------------------

function McpForm({
  value,
  onChange,
  lockName,
}: {
  value: EditableMcp;
  onChange: (m: EditableMcp) => void;
  lockName: boolean;
}) {
  function set<K extends keyof EditableMcp>(k: K, v: EditableMcp[K]) {
    onChange({ ...value, [k]: v });
  }
  function setEnv(i: number, patch: Partial<{ key: string; value: string }>) {
    const next = value.envRows.slice();
    next[i] = { ...next[i], ...patch };
    onChange({ ...value, envRows: next });
  }
  function addEnv() {
    onChange({ ...value, envRows: [...value.envRows, { key: "", value: "" }] });
  }
  function removeEnv(i: number) {
    const next = value.envRows.slice();
    next.splice(i, 1);
    onChange({ ...value, envRows: next });
  }

  const labelStyle: React.CSSProperties = {
    color: "var(--color-text-secondary)",
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };
  const inputStyle: React.CSSProperties = {
    background: "var(--color-surface-1)",
    border: "1px solid var(--color-border)",
    color: "var(--color-text-primary)",
    borderRadius: 4,
    padding: "6px 8px",
    fontSize: 12.5,
    width: "100%",
    fontFamily: "var(--font-mono)",
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block" style={labelStyle}>
          Name
        </label>
        <input
          type="text"
          value={value.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="kebab-case-name"
          disabled={lockName}
          style={{ ...inputStyle, opacity: lockName ? 0.6 : 1 }}
        />
        <p
          className="mt-1 text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          Lowercase letters, digits, '_' or '-'. Must start with letter/digit.
        </p>
      </div>

      <div>
        <label className="mb-1 block" style={labelStyle}>
          Transport
        </label>
        <div className="flex gap-2">
          {(["stdio", "http", "sse"] as Transport[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => set("transport", t)}
              className="rounded px-2.5 py-1 text-[11.5px] transition-colors"
              style={{
                background:
                  value.transport === t
                    ? "var(--color-accent)"
                    : "var(--color-surface-3)",
                color:
                  value.transport === t
                    ? "var(--color-accent-text)"
                    : "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {value.transport === "stdio" ? (
        <>
          <div>
            <label className="mb-1 block" style={labelStyle}>
              Command
            </label>
            <input
              type="text"
              value={value.command}
              onChange={(e) => set("command", e.target.value)}
              placeholder="npx"
              style={inputStyle}
            />
          </div>
          <div>
            <label className="mb-1 block" style={labelStyle}>
              Args (one per line)
            </label>
            <textarea
              value={value.argsText}
              onChange={(e) => set("argsText", e.target.value)}
              rows={4}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label style={labelStyle}>Env</label>
              <button
                type="button"
                onClick={addEnv}
                className="text-[11px] underline-offset-2 hover:underline"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                + add row
              </button>
            </div>
            {value.envRows.length === 0 && (
              <p
                className="text-[11px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                No environment variables.
              </p>
            )}
            <div className="space-y-1.5">
              {value.envRows.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => setEnv(i, { key: e.target.value })}
                    placeholder="KEY"
                    style={{ ...inputStyle, flex: "1 1 35%" }}
                  />
                  <input
                    type="text"
                    value={row.value}
                    onChange={(e) => setEnv(i, { value: e.target.value })}
                    placeholder="value"
                    style={{ ...inputStyle, flex: "1 1 65%" }}
                  />
                  <button
                    type="button"
                    onClick={() => removeEnv(i)}
                    className="rounded px-2 text-[11px]"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text-secondary)",
                      border: "1px solid var(--color-border)",
                    }}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div>
          <label className="mb-1 block" style={labelStyle}>
            URL
          </label>
          <input
            type="text"
            value={value.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder="https://example.com/mcp"
            style={inputStyle}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="rounded p-5"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
          width: wide ? 640 : 520,
          maxWidth: "92vw",
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 text-[12px]"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
            title="Close"
          >
            ×
          </button>
        </div>
        <div>{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP card
// ---------------------------------------------------------------------------

type Action = "hide" | "edit" | "delete" | "test";

function Card({
  mcp,
  hidden,
  ping,
  pingBusy,
  onAction,
}: {
  mcp: McpInfoExt;
  hidden: boolean;
  ping?: McpPingResult;
  pingBusy?: boolean;
  onAction: (a: Action) => void;
}) {
  const color = statusColor(mcp.status, mcp.expected_offline);
  const label = statusLabel(mcp.status, mcp.expected_offline);
  const origin = parseOrigin(mcp.origin);
  const originColors = originBadgeColor(origin.kind);
  // Plugin / project-scope MCPs are read-only from the Control Center —
  // mutating them would invalidate the plugin's signature or wander into
  // a project's repo. Surface this clearly rather than silently failing.
  const readOnly = origin.kind !== "user";

  return (
    <div
      className="rounded p-4 transition-opacity"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        opacity: hidden ? 0.45 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <h3 className="text-[14px] font-semibold leading-none">{mcp.name}</h3>
            <span
              className="text-[10.5px] uppercase tracking-[0.06em]"
              style={{ color }}
            >
              {label}
            </span>
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
              style={{ background: originColors.bg, color: originColors.fg }}
              title={
                origin.kind === "user"
                  ? "Configured in ~/.claude/settings.json — editable from here"
                  : origin.kind === "plugin"
                    ? `Provided by plugin '${origin.label}' — read-only here`
                    : origin.kind === "project"
                      ? `Defined in project '${origin.label}' .mcp.json — read-only here`
                      : "Unknown origin"
              }
            >
              {origin.kind === "user"
                ? "user"
                : `${origin.kind}: ${origin.label}`}
            </span>
            {mcp.expected_offline && (
              <span
                className="text-[10px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                expected offline
              </span>
            )}
          </div>

          <div
            className="mt-2 flex items-center gap-3 text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            <span>
              <span style={{ color: "var(--color-text-faint)" }}>transport</span> {mcp.transport}
            </span>
            {mcp.last_checked && (
              <span>
                <span style={{ color: "var(--color-text-faint)" }}>checked</span>{" "}
                {mcp.last_checked.slice(0, 16).replace("T", " ")}
              </span>
            )}
            {ping && (
              <span>
                <span style={{ color: "var(--color-text-faint)" }}>ping</span>{" "}
                <span
                  style={{
                    color: ping.ok
                      ? "var(--color-success)"
                      : "var(--color-danger)",
                  }}
                >
                  {ping.ok ? "running" : "stopped"}
                </span>
                {ping.latency_ms != null && (
                  <span
                    className="ml-1"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    {ping.latency_ms} ms
                  </span>
                )}
              </span>
            )}
          </div>

          {/* command / url preview */}
          <div className="mt-2 truncate text-[11.5px]" style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }} title={mcp.command || mcp.url || ""}>
            {mcp.url ? mcp.url : (mcp.command ? mcp.command + (mcp.args_preview ? ` ${mcp.args_preview}` : "") : "—")}
          </div>

          {/* fallback message */}
          {mcp.fallback_message && mcp.status !== "ok" && (
            <p
              className="mt-3 text-[12px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {mcp.fallback_message}
            </p>
          )}
        </div>

        {/* No per-card "Retry": the health probe is global (it rewrites the
            whole mcp-health.json in one pass), so a per-card button would lie
            about its scope. The "Run health check" button in the tab header
            owns that action. */}
        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onAction("test")}
            disabled={!!pingBusy}
            className="rounded px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Spawn the MCP command and wait for an initialize response (2s budget)"
          >
            {pingBusy ? "Testing…" : "Test"}
          </button>
          <button
            type="button"
            onClick={() => onAction("edit")}
            disabled={readOnly}
            className="rounded px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title={
              readOnly
                ? `Origin '${origin.kind}' is read-only from the Control Center`
                : "Edit this MCP's settings.json entry"
            }
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onAction("delete")}
            disabled={readOnly}
            className="rounded px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40"
            style={{
              background: "rgba(248, 81, 73, 0.10)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.35)",
            }}
            title={
              readOnly
                ? `Origin '${origin.kind}' is read-only from the Control Center`
                : "Remove from settings.json (backup kept)"
            }
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Enable/disable section — moved from Settings tab (v15.2 F7).
// Toggles the `disabled` flag in settings.json for each mcpServers entry.
// This is independent of "delete from settings.json" (the Card action below):
// disabling keeps the entry around so the user can flip it back on without
// re-entering command/args/env.
// ---------------------------------------------------------------------------

type EnableDisableMcp = {
  name: string;
  cfg: Record<string, unknown> & { disabled?: boolean };
};

function EnableDisableSection({ onChanged }: { onChanged: () => void }) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  async function load() {
    try {
      const r = (await invoke("settings_read")) as SettingsSnapshot;
      setSnapshot(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  const entries = useMemo<EnableDisableMcp[]>(() => {
    if (!snapshot) return [];
    const obj = (snapshot.content as Record<string, unknown>).mcpServers as
      | Record<string, EnableDisableMcp["cfg"]>
      | undefined;
    if (!obj) return [];
    return Object.entries(obj)
      .map(([name, cfg]) => ({ name, cfg }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snapshot]);

  async function toggle(name: string) {
    if (!snapshot || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = JSON.parse(JSON.stringify(snapshot.content)) as Record<string, unknown>;
      const servers = (next.mcpServers ?? {}) as Record<string, EnableDisableMcp["cfg"]>;
      const cfg = servers[name];
      if (!cfg) return;
      cfg.disabled = !cfg.disabled;
      next.mcpServers = servers;
      const res = (await invoke("settings_save", { content: next })) as SettingsSaveResult;
      if (!res.success) {
        setError("Save failed");
        return;
      }
      await load();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) return null;
  if (entries.length === 0) return null;

  const enabledCount = entries.filter((e) => !e.cfg.disabled).length;

  return (
    <section
      className="mb-5 rounded"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-baseline justify-between px-4 py-3 text-left"
      >
        <div>
          <h2 className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Enable / disable
          </h2>
          <p
            className="mt-0.5 text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {enabledCount} of {entries.length} enabled · writes the{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>disabled</span> flag in
            settings.json (automatic backup). Restart Claude Code to apply.
          </p>
        </div>
        <span
          className="text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {collapsed ? "Show" : "Hide"}
        </span>
      </button>
      {!collapsed && (
        <div className="space-y-1.5 px-3 pb-3">
          {entries.map(({ name, cfg }) => {
            const enabled = !cfg.disabled;
            return (
              <div
                key={name}
                className="flex items-center gap-3 rounded px-3 py-2"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  opacity: enabled ? 1 : 0.55,
                }}
              >
                <button
                  type="button"
                  onClick={() => toggle(name)}
                  disabled={busy}
                  className="flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
                  style={{
                    background: enabled ? "var(--color-success)" : "var(--color-surface-3)",
                    border: "1px solid var(--color-border-strong)",
                    padding: "1px",
                  }}
                  title={enabled ? "Disable this MCP" : "Enable this MCP"}
                >
                  <span
                    className="block h-3.5 w-3.5 rounded-full transition-transform"
                    style={{
                      background: "var(--color-text)",
                      transform: enabled ? "translateX(16px)" : "translateX(0)",
                    }}
                  />
                </button>
                <span className="text-[12.5px] font-medium" style={{ color: "var(--color-text)" }}>
                  {name}
                </span>
                {!enabled && (
                  <span className="text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                    disabled
                  </span>
                )}
              </div>
            );
          })}
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
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function MCPs() {
  const [mcps, setMcps] = useState<McpInfoExt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden());
  const [showHidden, setShowHidden] = useState(false);
  const [probing, setProbing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // P7: per-server ping results (Test button). Independent of the global
  // health check JSON because the spawn-and-initialize handshake is
  // far more reliable than reading mcp-health.json.
  const [pings, setPings] = useState<Record<string, McpPingResult>>({});
  const [pingBusy, setPingBusy] = useState<Set<string>>(new Set());

  async function testMcp(name: string) {
    setPingBusy((s) => {
      const next = new Set(s);
      next.add(name);
      return next;
    });
    try {
      const r = (await invoke("mcp_ping", { name })) as McpPingResult;
      setPings((p) => ({ ...p, [name]: r }));
    } catch (e) {
      setPings((p) => ({
        ...p,
        [name]: {
          name,
          ok: false,
          latency_ms: null,
          error: String(e),
        },
      }));
    } finally {
      setPingBusy((s) => {
        const next = new Set(s);
        next.delete(name);
        return next;
      });
    }
  }
  const addWithAiTitle = useRoutingTitle(
    "mcps.add_with_ai",
    "Register a new MCP server with AI. cwd=instructions/mcps/ with GUIDE.md auto-loaded.",
  );

  // Modal state
  const [addOpen, setAddOpen] = useState(false);
  const [addModel, setAddModel] = useState<EditableMcp>(blankMcp());
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editModel, setEditModel] = useState<EditableMcp>(blankMcp());
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [genOpen, setGenOpen] = useState(false);
  const [genDescription, setGenDescription] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genResult, setGenResult] = useState<McpGenerationResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => saveHidden(hidden), [hidden]);

  async function fetchList() {
    try {
      const list = (await invoke("list_mcps")) as McpInfoExt[];
      setMcps(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runProbe() {
    setProbing(true);
    try {
      const list = (await invoke("run_mcp_health_check")) as McpInfoExt[];
      setMcps(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  }

  useEffect(() => {
    fetchList();
    const t = setInterval(fetchList, 30_000);
    return () => clearInterval(t);
  }, []);

  function toggleHidden(name: string) {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setHidden(next);
  }

  function showFlash(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 4500);
  }

  // -------------------------------------------------------------------------
  // Open Edit modal — needs to read settings.json to get the source config
  // (list_mcps strips env, etc.).
  // -------------------------------------------------------------------------
  async function openEdit(name: string) {
    try {
      const snap = (await invoke("settings_read")) as SettingsSnapshot;
      const servers = (snap.content as Record<string, unknown>).mcpServers as
        | Record<string, Record<string, unknown>>
        | undefined;
      const cfg = servers?.[name] ?? {};
      setEditModel(configToEditable(name, cfg));
      setEditTarget(name);
      setEditError(null);
    } catch (e) {
      showFlash(`Failed to load entry: ${e}`);
    }
  }

  // -------------------------------------------------------------------------
  // Add
  // -------------------------------------------------------------------------
  async function submitAdd() {
    const err = validateEditable(addModel);
    if (err) {
      setAddError(err);
      return;
    }
    if (mcps.some((m) => m.name === addModel.name)) {
      setAddError(`'${addModel.name}' already exists.`);
      return;
    }
    setAddSaving(true);
    setAddError(null);
    try {
      const config = editableToConfig(addModel);
      const res = (await invoke("add_mcp", {
        name: addModel.name,
        config,
      })) as McpMutationResult;
      setAddOpen(false);
      setAddModel(blankMcp());
      showFlash(
        `Added '${res.name}'. Backup: ${res.backup_path ?? "n/a"}. Restart Claude Code for the new MCP to spawn.`,
      );
      await fetchList();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAddSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------------
  async function submitEdit() {
    const err = validateEditable(editModel);
    if (err) {
      setEditError(err);
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const config = editableToConfig(editModel);
      const res = (await invoke("update_mcp", {
        name: editModel.name,
        config,
      })) as McpMutationResult;
      setEditTarget(null);
      showFlash(
        `Updated '${res.name}'. Backup: ${res.backup_path ?? "n/a"}. Restart Claude Code to apply.`,
      );
      await fetchList();
    } catch (e) {
      setEditError(String(e));
    } finally {
      setEditSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------
  async function submitDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = (await invoke("delete_mcp", {
        name: deleteTarget,
      })) as McpMutationResult;
      setDeleteTarget(null);
      showFlash(
        `Removed '${res.name}'. Backup: ${res.backup_path ?? "n/a"}.`,
      );
      await fetchList();
    } catch (e) {
      showFlash(`Delete failed: ${e}`);
    } finally {
      setDeleting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Generate from prompt
  // -------------------------------------------------------------------------
  async function submitGenerate() {
    if (!genDescription.trim()) return;
    setGenBusy(true);
    setGenError(null);
    setGenResult(null);
    try {
      const res = (await invoke("generate_mcp_from_prompt", {
        description: genDescription,
      })) as McpGenerationResult;
      setGenResult(res);
    } catch (e) {
      setGenError(String(e));
    } finally {
      setGenBusy(false);
    }
  }

  async function acceptGenerated() {
    if (!genResult || !genResult.success) return;
    try {
      const res = (await invoke("add_mcp", {
        name: genResult.name,
        config: genResult.config,
      })) as McpMutationResult;
      setGenOpen(false);
      setGenDescription("");
      setGenResult(null);
      showFlash(
        `Added '${res.name}' (from prompt). Restart Claude Code to apply.`,
      );
      await fetchList();
    } catch (e) {
      setGenError(String(e));
    }
  }

  const visible = mcps.filter((m) => !hidden.has(m.name) || showHidden);
  const okCount = mcps.filter((m) => m.status === "ok").length;
  const issueCount = mcps.filter(
    (m) => (m.status === "degraded" || m.status === "missing") && !m.expected_offline,
  ).length;

  const generatedPreview = useMemo(() => {
    if (!genResult) return "";
    try {
      return JSON.stringify(
        { name: genResult.name, config: genResult.config },
        null,
        2,
      );
    } catch {
      return "";
    }
  }, [genResult]);

  return (
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">MCPs</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            {mcps.length} servers · {okCount} connected · {issueCount} need attention
            {(() => {
              // Surface origin breakdown so the user can sanity-check that
              // plugin- and project-scope MCPs are showing up (USER
              // reported that Claudia surfaced many more than CC did).
              const buckets = mcps.reduce<Record<string, number>>((acc, m) => {
                const k = parseOrigin(m.origin).kind;
                acc[k] = (acc[k] || 0) + 1;
                return acc;
              }, {});
              const parts: string[] = [];
              if (buckets.user) parts.push(`${buckets.user} user`);
              if (buckets.project) parts.push(`${buckets.project} project`);
              if (buckets.plugin) parts.push(`${buckets.plugin} plugin`);
              return parts.length > 0 ? <> · {parts.join(" · ")}</> : null;
            })()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setAddModel(blankMcp());
              setAddError(null);
              setAddOpen(true);
            }}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            + Add MCP
          </button>
          {/* "Generate from prompt" retired in favor of "Add with AI" —
              the inline modal kept choking on prompts with special chars
              and the wt.exe-based flow gives Claude full conversation
              control, which matters when the user needs to clarify
              command/args/env shape. */}
          <button
            type="button"
            onClick={async () => {
              try {
                const instr = (await invoke("instruction_path", {
                  kind: "mcps",
                })) as string;
                // v15.3.5: prompt now lives in the central catalog
                // (key `mcps.add_with_ai`) so it can be tuned from
                // Settings → Button prompts without recompiling.
                const { getPrompt } = await import("../lib/button-prompts");
                const prompt = await getPrompt("mcps.add_with_ai");
                await invoke("spawn_session", {
                  provider: "claude",
                  prompt,
                  cwd: instr,
                  flags: { dangerouslySkipPermissions: false },
                });
              } catch (e) {
                console.error("create mcp with AI failed", e);
              }
            }}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title={addWithAiTitle}
          >
            Add with AI
          </button>
          <button
            type="button"
            onClick={runProbe}
            disabled={probing}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title="Pings each MCP server (sse via HTTP, stdio via spawn + ListTools) to verify it's reachable. Marks 'degraded' if response > 5s, 'missing' if no response. Updates per-row status icon."
          >
            {probing ? "Probing…" : "Run health check"}
          </button>
        </div>
      </header>

      {flash && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(46, 160, 67, 0.07)",
            border: "1px solid rgba(46, 160, 67, 0.25)",
            color: "var(--color-success)",
          }}
        >
          {flash}
        </div>
      )}

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {hidden.size > 0 && (
        <div className="mb-4 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          {hidden.size} hidden ·{" "}
          <button
            type="button"
            onClick={() => setShowHidden(!showHidden)}
            className="underline-offset-2 hover:underline"
          >
            {showHidden ? "hide them" : "show them"}
          </button>
        </div>
      )}

      {/* Enable/disable toggles — moved from Settings tab (v15.2 F7). */}
      <EnableDisableSection onChanged={fetchList} />

      {loading && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </div>
      )}

      {!loading && mcps.length === 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          No MCPs configured in ~/.claude/settings.json mcpServers.
        </div>
      )}

      <div className="space-y-2">
        {visible.map((m) => (
          <Card
            key={m.name}
            mcp={m}
            hidden={hidden.has(m.name)}
            ping={pings[m.name]}
            pingBusy={pingBusy.has(m.name)}
            onAction={(a) => {
              if (a === "hide") toggleHidden(m.name);
              else if (a === "edit") openEdit(m.name);
              else if (a === "delete") setDeleteTarget(m.name);
              else if (a === "test") void testMcp(m.name);
            }}
          />
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Add modal                                                        */}
      {/* ---------------------------------------------------------------- */}
      {addOpen && (
        <Modal
          title="Add MCP"
          onClose={() => !addSaving && setAddOpen(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                disabled={addSaving}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAdd}
                disabled={addSaving}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {addSaving ? "Saving…" : "Add to settings.json"}
              </button>
            </>
          }
        >
          <McpForm value={addModel} onChange={setAddModel} lockName={false} />
          {addError && (
            <p
              className="mt-3 text-[12px]"
              style={{ color: "var(--color-danger)" }}
            >
              {addError}
            </p>
          )}
        </Modal>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Edit modal                                                       */}
      {/* ---------------------------------------------------------------- */}
      {editTarget && (
        <Modal
          title={`Edit MCP — ${editTarget}`}
          onClose={() => !editSaving && setEditTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                disabled={editSaving}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitEdit}
                disabled={editSaving}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {editSaving ? "Saving…" : "Save changes"}
              </button>
            </>
          }
        >
          <McpForm value={editModel} onChange={setEditModel} lockName={true} />
          {editError && (
            <p
              className="mt-3 text-[12px]"
              style={{ color: "var(--color-danger)" }}
            >
              {editError}
            </p>
          )}
        </Modal>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Delete confirm                                                   */}
      {/* ---------------------------------------------------------------- */}
      {deleteTarget && (
        <Modal
          title={`Delete ${deleteTarget}?`}
          onClose={() => !deleting && setDeleteTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitDelete}
                disabled={deleting}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "rgba(248, 81, 73, 0.18)",
                  color: "var(--color-danger)",
                  border: "1px solid rgba(248, 81, 73, 0.45)",
                }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </>
          }
        >
          <p
            className="text-[13px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            This removes <strong>{deleteTarget}</strong> from settings.json. A
            timestamped backup is kept in
            <code
              className="ml-1 rounded px-1.5 py-0.5"
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--color-surface-3)",
                color: "var(--color-text-primary)",
              }}
            >
              ~/.ultron/backups/control-center-settings/
            </code>
            .
          </p>
        </Modal>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Generate from prompt                                             */}
      {/* ---------------------------------------------------------------- */}
      {genOpen && (
        <Modal
          title="Generate MCP from prompt"
          onClose={() => !genBusy && setGenOpen(false)}
          wide
          footer={
            <>
              <button
                type="button"
                onClick={() => setGenOpen(false)}
                disabled={genBusy}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Close
              </button>
              {genResult?.success && (
                <button
                  type="button"
                  onClick={acceptGenerated}
                  className="rounded px-3 py-1.5 text-[12px] font-medium"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                >
                  Add it
                </button>
              )}
              {!genResult && (
                <button
                  type="button"
                  onClick={submitGenerate}
                  disabled={genBusy || !genDescription.trim()}
                  className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                >
                  {genBusy ? "Asking Claude…" : "Generate"}
                </button>
              )}
              {genResult && !genResult.success && (
                <button
                  type="button"
                  onClick={() => {
                    setGenResult(null);
                  }}
                  className="rounded px-3 py-1.5 text-[12px] font-medium"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                >
                  Try again
                </button>
              )}
            </>
          }
        >
          {!genResult && (
            <>
              <label
                className="mb-1 block"
                style={{
                  color: "var(--color-text-secondary)",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Description
              </label>
              <textarea
                value={genDescription}
                onChange={(e) => setGenDescription(e.target.value)}
                rows={6}
                placeholder="e.g. a tool that wraps the Linear API for searching issues"
                disabled={genBusy}
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-primary)",
                  borderRadius: 4,
                  padding: "8px 10px",
                  fontSize: 12.5,
                  width: "100%",
                  resize: "vertical",
                }}
              />
              <p
                className="mt-2 text-[11px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                Claude is invoked via{" "}
                <code style={{ fontFamily: "var(--font-mono)" }}>cmd.exe /C claude -p</code>{" "}
                and asked to emit a strict JSON object. You can review before adding.
              </p>
              {genBusy && (
                <p
                  className="mt-3 text-[12.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Asking Claude…
                </p>
              )}
              {genError && (
                <p
                  className="mt-3 text-[12px]"
                  style={{ color: "var(--color-danger)" }}
                >
                  {genError}
                </p>
              )}
            </>
          )}

          {genResult && genResult.success && (
            <>
              <p
                className="mb-2 text-[12.5px]"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Claude proposed:
              </p>
              <pre
                className="rounded p-3 text-[11.5px] leading-relaxed"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-primary)",
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  maxHeight: 320,
                  overflow: "auto",
                }}
              >
                {generatedPreview}
              </pre>
              <p
                className="mt-2 text-[11px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                "Add it" will call <code>add_mcp</code> with this config and
                refresh the list.
              </p>
            </>
          )}

          {genResult && !genResult.success && (
            <>
              <p
                className="mb-2 text-[12.5px]"
                style={{ color: "var(--color-warn)" }}
              >
                Could not parse a valid MCP config out of Claude's response.
                Raw output below — try rephrasing the description.
              </p>
              <pre
                className="rounded p-3 text-[11.5px] leading-relaxed"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 320,
                  overflow: "auto",
                }}
              >
                {genResult.raw_output || "(no output)"}
              </pre>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
