// MCP Creator v1 — template-based wizard for adding a new MCP server to
// ~/.claude/settings.json. Wraps the existing `add_mcp` backend command
// (allowlist-validated, atomic write with backup) and offers an
// optional "Test connection" via `mcp_ping` immediately after create.
//
// Step 1: Pick a transport template (stdio Python / stdio Node / HTTP / SSE).
// Step 2: Fill transport-specific fields with inline validation.
// Step 3: Review summary + create. After create, offer Test connection.
//
// Backend contract:
//   - invoke("add_mcp", { name, config }) → McpMutationResult.
//   - invoke("mcp_ping", { name }) → McpPingResult.
//   - The Rust side enforces a hard allowlist (npx/uvx/node/python/...)
//     so we mirror that allowlist client-side as helper text only.

import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { McpMutationResult, McpPingResult } from "../../types";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
} from "./icons";
import {
  MCP_TEMPLATES,
  type McpTemplateBase,
  type McpTemplateId,
} from "./creatorTemplates";

type Props = {
  onClose: () => void;
  onCreated: (name: string) => void;
};

type Step = 1 | 2 | 3;

type EnvRow = { key: string; value: string };

const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,60}$/;
const ALLOWED_COMMANDS = [
  "npx", "npm", "node", "uvx", "uv", "python", "deno", "bun",
  "cargo", "go", "ruby", "java",
];

export function CreateMcpModal({ onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [templateId, setTemplateId] = useState<McpTemplateId>("stdio-node");

  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("npx");
  const [argsRaw, setArgsRaw] = useState("");
  const [url, setUrl] = useState("");
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [pingResult, setPingResult] = useState<McpPingResult | null>(null);

  const args = useMemo(
    () =>
      argsRaw
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [argsRaw],
  );

  const nameValid = MCP_NAME_RE.test(name);
  const commandValid =
    transport !== "stdio" || ALLOWED_COMMANDS.includes(command.trim());
  const urlValid =
    transport === "stdio" || /^https?:\/\/.+/.test(url.trim());

  const canAdvance: Record<Step, boolean> = {
    1: true,
    2: nameValid && commandValid && urlValid,
    3: true,
  };

  function pickTemplate(id: McpTemplateId) {
    const tpl = MCP_TEMPLATES.find((t) => t.id === id) ?? MCP_TEMPLATES[0];
    setTemplateId(id);
    setTransport(tpl.transport);
    if (tpl.command) setCommand(tpl.command);
    if (tpl.args) setArgsRaw(tpl.args.join(" "));
    else setArgsRaw("");
    if (tpl.url) setUrl(tpl.url);
    else setUrl("");
    setEnvRows(tpl.env ? [...tpl.env] : []);
  }

  function addEnvRow() {
    setEnvRows((rows) => [...rows, { key: "", value: "" }]);
  }

  function updateEnvRow(i: number, patch: Partial<EnvRow>) {
    setEnvRows((rows) =>
      rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
  }

  function removeEnvRow(i: number) {
    setEnvRows((rows) => rows.filter((_, idx) => idx !== i));
  }

  function buildConfig(): Record<string, unknown> {
    const env: Record<string, string> = {};
    for (const row of envRows) {
      const k = row.key.trim();
      if (k.length === 0) continue;
      env[k] = row.value;
    }
    if (transport === "stdio") {
      const cfg: Record<string, unknown> = {
        command: command.trim(),
        args,
      };
      if (Object.keys(env).length > 0) cfg.env = env;
      return cfg;
    }
    // http / sse share the url field; only sse sets `type`.
    const cfg: Record<string, unknown> = { url: url.trim() };
    if (transport === "sse") cfg.type = "sse";
    if (Object.keys(env).length > 0) cfg.env = env;
    return cfg;
  }

  function advance() {
    if (!canAdvance[step]) return;
    if (step < 3) setStep((step + 1) as Step);
  }

  function back() {
    if (step > 1) setStep((step - 1) as Step);
  }

  async function submit() {
    if (!nameValid || !commandValid || !urlValid) return;
    setBusy(true);
    setErr(null);
    try {
      const config = buildConfig();
      const res = (await invoke("add_mcp", {
        name,
        config,
      })) as McpMutationResult;
      if (!res.success) {
        throw new Error("add_mcp returned success=false");
      }
      setCreatedName(name);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    if (!createdName) return;
    setBusy(true);
    setErr(null);
    try {
      const res = (await invoke("mcp_ping", {
        name: createdName,
      })) as McpPingResult;
      setPingResult(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    if (createdName) onCreated(createdName);
    else onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="flex max-h-[90vh] w-[min(820px,96vw)] flex-col rounded-md border shadow-xl"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
      >
        <div
          className="flex items-center gap-3 border-b p-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <Plus size={16} />
          <h2 className="text-sm font-semibold">New MCP server</h2>
          <StepperDots step={step} />
          <span
            className="ml-auto text-xs"
            style={{ color: "var(--color-text-muted)" }}
          >
            Step {step} / 3
          </span>
          <button
            className="rounded p-1 hover:bg-[var(--color-surface-2)]"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 text-sm">
          {step === 1 && (
            <StepTemplates
              selectedId={templateId}
              onPick={pickTemplate}
              templates={MCP_TEMPLATES}
            />
          )}

          {step === 2 && (
            <StepForm
              transport={transport}
              name={name}
              setName={setName}
              nameValid={nameValid}
              command={command}
              setCommand={setCommand}
              commandValid={commandValid}
              argsRaw={argsRaw}
              setArgsRaw={setArgsRaw}
              args={args}
              url={url}
              setUrl={setUrl}
              urlValid={urlValid}
              envRows={envRows}
              addEnvRow={addEnvRow}
              updateEnvRow={updateEnvRow}
              removeEnvRow={removeEnvRow}
            />
          )}

          {step === 3 && (
            <StepReview
              name={name}
              transport={transport}
              command={command}
              args={args}
              url={url}
              envRows={envRows}
              createdName={createdName}
              pingResult={pingResult}
            />
          )}

          {err && (
            <div
              className="mt-4 rounded border p-2 text-xs"
              style={{
                borderColor: "var(--color-error)",
                background: "var(--color-surface-1)",
                color: "var(--color-error)",
              }}
            >
              {err}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-between gap-2 border-t p-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            className="inline-flex items-center gap-1 rounded border px-3 py-1 text-xs disabled:opacity-50"
            style={{ borderColor: "var(--color-border)" }}
            onClick={step === 1 ? onClose : back}
            disabled={busy}
          >
            {step === 1 ? "Cancel" : <><ChevronLeft size={12} /> Back</>}
          </button>
          <div className="flex items-center gap-2">
            {step < 3 && (
              <button
                className="inline-flex items-center gap-1 rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                onClick={advance}
                disabled={!canAdvance[step] || busy}
              >
                Next <ChevronRight size={12} />
              </button>
            )}
            {step === 3 && !createdName && (
              <button
                className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                onClick={submit}
                disabled={busy}
              >
                {busy ? "Creating..." : "Create MCP"}
              </button>
            )}
            {step === 3 && createdName && (
              <>
                <button
                  className="rounded border px-3 py-1 text-xs disabled:opacity-50"
                  style={{ borderColor: "var(--color-border)" }}
                  onClick={testConnection}
                  disabled={busy}
                >
                  {busy ? "Testing..." : "Test connection"}
                </button>
                <button
                  className="rounded px-3 py-1 text-xs font-medium"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                  onClick={finish}
                >
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step components
// ---------------------------------------------------------------------------

function StepperDots({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className="h-1.5 w-6 rounded-full"
          style={{
            background:
              n <= step ? "var(--color-accent)" : "var(--color-surface-3)",
          }}
        />
      ))}
    </div>
  );
}

function StepTemplates(props: {
  selectedId: McpTemplateId;
  onPick: (id: McpTemplateId) => void;
  templates: McpTemplateBase[];
}) {
  const { selectedId, onPick, templates } = props;
  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
        Choose a transport template. The Rust backend enforces an allowlist
        on stdio commands ({ALLOWED_COMMANDS.slice(0, 6).join(", ")}, ...).
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {templates.map((tpl) => {
          const active = tpl.id === selectedId;
          return (
            <button
              key={tpl.id}
              onClick={() => onPick(tpl.id)}
              className="flex flex-col items-start gap-1 rounded border p-3 text-left"
              style={{
                borderColor: active
                  ? "var(--color-accent)"
                  : "var(--color-border)",
                background: active
                  ? "var(--color-surface-2)"
                  : "var(--color-surface-1)",
              }}
            >
              <div className="flex w-full items-center gap-2">
                <span className="text-sm font-medium">{tpl.label}</span>
                <span
                  className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10px]"
                  style={{ background: "var(--color-surface-3)" }}
                >
                  {tpl.transport}
                </span>
              </div>
              <span
                className="text-xs"
                style={{ color: "var(--color-text-muted)" }}
              >
                {tpl.hint}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepForm(props: {
  transport: "stdio" | "http" | "sse";
  name: string;
  setName: (v: string) => void;
  nameValid: boolean;
  command: string;
  setCommand: (v: string) => void;
  commandValid: boolean;
  argsRaw: string;
  setArgsRaw: (v: string) => void;
  args: string[];
  url: string;
  setUrl: (v: string) => void;
  urlValid: boolean;
  envRows: EnvRow[];
  addEnvRow: () => void;
  updateEnvRow: (i: number, patch: Partial<EnvRow>) => void;
  removeEnvRow: (i: number) => void;
}) {
  const {
    transport,
    name, setName, nameValid,
    command, setCommand, commandValid,
    argsRaw, setArgsRaw, args,
    url, setUrl, urlValid,
    envRows, addEnvRow, updateEnvRow, removeEnvRow,
  } = props;

  return (
    <div className="space-y-4">
      <FieldLabel label="Name (lowercase, _ or - allowed, 2–61 chars)">
        <input
          className="w-full rounded border bg-[var(--color-surface-2)] px-2 py-1 font-mono outline-none"
          style={{
            borderColor:
              name && !nameValid
                ? "var(--color-error)"
                : "var(--color-border)",
          }}
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="filesystem"
        />
        {name && !nameValid && (
          <HelperText error>
            Name must start with a letter or digit and contain only
            lowercase letters, digits, '_' or '-'.
          </HelperText>
        )}
      </FieldLabel>

      {transport === "stdio" && (
        <>
          <FieldLabel label="Command (allowlist enforced server-side)">
            <input
              className="w-full rounded border bg-[var(--color-surface-2)] px-2 py-1 font-mono outline-none"
              style={{
                borderColor:
                  command && !commandValid
                    ? "var(--color-error)"
                    : "var(--color-border)",
              }}
              value={command}
              onChange={(e) => setCommand(e.target.value.trim())}
              placeholder="npx"
            />
            {command && !commandValid && (
              <HelperText error>
                Command not in allowlist. Allowed: {ALLOWED_COMMANDS.join(", ")}.
              </HelperText>
            )}
          </FieldLabel>

          <FieldLabel label="Args (space-separated)">
            <input
              className="w-full rounded border bg-[var(--color-surface-2)] px-2 py-1 font-mono outline-none"
              style={{ borderColor: "var(--color-border)" }}
              value={argsRaw}
              onChange={(e) => setArgsRaw(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
            />
            {args.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {args.map((a, idx) => (
                  <span
                    key={idx}
                    className="rounded px-2 py-0.5 font-mono text-[11.5px]"
                    style={{ background: "var(--color-surface-2)" }}
                  >
                    {a}
                  </span>
                ))}
              </div>
            )}
          </FieldLabel>
        </>
      )}

      {(transport === "http" || transport === "sse") && (
        <FieldLabel label="URL (http:// or https://)">
          <input
            className="w-full rounded border bg-[var(--color-surface-2)] px-2 py-1 font-mono outline-none"
            style={{
              borderColor:
                url && !urlValid
                  ? "var(--color-error)"
                  : "var(--color-border)",
            }}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/mcp"
          />
          {url && !urlValid && (
            <HelperText error>URL must start with http:// or https://</HelperText>
          )}
        </FieldLabel>
      )}

      <FieldLabel label="Environment variables (optional)">
        <div className="space-y-1">
          {envRows.map((row, i) => (
            <div key={i} className="flex gap-1">
              <input
                className="w-2/5 rounded border bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs outline-none"
                style={{ borderColor: "var(--color-border)" }}
                value={row.key}
                onChange={(e) => updateEnvRow(i, { key: e.target.value })}
                placeholder="KEY"
              />
              <input
                className="flex-1 rounded border bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs outline-none"
                style={{ borderColor: "var(--color-border)" }}
                value={row.value}
                onChange={(e) => updateEnvRow(i, { value: e.target.value })}
                placeholder="value or ${ENV_VAR}"
              />
              <button
                onClick={() => removeEnvRow(i)}
                className="rounded border px-2 text-xs"
                style={{ borderColor: "var(--color-border)" }}
                aria-label="Remove env var"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            onClick={addEnvRow}
            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
            style={{ borderColor: "var(--color-border)" }}
          >
            <Plus size={12} /> Add env var
          </button>
        </div>
      </FieldLabel>
    </div>
  );
}

function StepReview(props: {
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string[];
  url: string;
  envRows: EnvRow[];
  createdName: string | null;
  pingResult: McpPingResult | null;
}) {
  const { name, transport, command, args, url, envRows, createdName, pingResult } = props;
  const env = Object.fromEntries(
    envRows.filter((r) => r.key.trim().length > 0).map((r) => [r.key, r.value]),
  );
  const config: Record<string, unknown> =
    transport === "stdio"
      ? {
          command,
          args,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        }
      : {
          url,
          ...(transport === "sse" ? { type: "sse" } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
  const json = JSON.stringify({ mcpServers: { [name]: config } }, null, 2);
  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
        Review the JSON that will be merged into <code>~/.claude/settings.json</code>.
        A timestamped backup is taken before the write.
      </p>
      <pre
        className="overflow-auto rounded border p-3 font-mono text-[11.5px]"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
          maxHeight: "260px",
        }}
      >
        {json}
      </pre>

      {createdName && (
        <div
          className="rounded border p-3 text-xs"
          style={{
            borderColor: "var(--color-accent)",
            background: "var(--color-surface-2)",
          }}
        >
          <div className="font-semibold">
            Added {createdName} to settings.json.
          </div>
          <div style={{ color: "var(--color-text-muted)" }}>
            Restart Claude Code to spawn the new server. Use Test connection to
            verify stdio servers respond to a JSON-RPC initialize.
          </div>
        </div>
      )}

      {pingResult && (
        <div
          className="rounded border p-3 text-xs"
          style={{
            borderColor: pingResult.ok
              ? "var(--color-accent)"
              : "var(--color-error)",
            background: "var(--color-surface-2)",
          }}
        >
          <div className="font-semibold">
            Ping {pingResult.ok ? "ok" : "failed"}
            {pingResult.latency_ms !== null
              ? ` (${pingResult.latency_ms} ms)`
              : ""}
          </div>
          {pingResult.error && (
            <div style={{ color: "var(--color-text-muted)" }}>
              {pingResult.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Atoms — self-contained for now (matches CreateSkill/Agent modals).
// ---------------------------------------------------------------------------

function FieldLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span
        className="mb-1 block text-xs"
        style={{ color: "var(--color-text-muted)" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function HelperText({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className="mt-1 text-xs"
      style={{
        color: error ? "var(--color-error)" : "var(--color-text-muted)",
      }}
    >
      {children}
    </div>
  );
}

export default CreateMcpModal;
