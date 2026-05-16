import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AgentInfo, SettingsSaveResult, SettingsSnapshot } from "../types";
import { AuthStatus } from "./AuthStatus";
import { ModeSwitcher, useUltronMode } from "./ModeSwitcher";
import { JsonVisualEditor } from "./JsonVisualEditor";
import {
  refreshButtonPrompts,
  resetButtonPrompt,
  updateButtonPrompt,
  type ButtonPrompt,
  type ButtonPromptsCatalog,
} from "../lib/button-prompts";

// v15.2 F7: MCPRow / McpServer type removed from Settings — MCP enable/disable
// now lives in the MCPs top-level tab (see EnableDisableSection in MCPs.tsx).

// ---------------------------------------------------------------------------
// JSON editor — thin wrapper over JsonVisualEditor. The Raw JSON textarea +
// Codex assist + schema validator were removed in v15.2 F9 UX: the visual
// form is now the only mode (simpler UX, no toggle, no stale buffer).
// Edits propagate up through the normal Save flow (timestamped backup,
// atomic write).
// ---------------------------------------------------------------------------

function JsonEditor({
  obj,
  onChange,
}: {
  obj: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div
        className="text-[11px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Editable copy of <span style={{ fontFamily: "var(--font-mono)" }}>~/.claude/settings.json</span> · cualquier cambio se hace efectivo al pulsar Save (backup automático)
      </div>
      <JsonVisualEditor obj={obj} onChange={onChange} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disk backup status — surfaces the configured backup root mirror freshness.
// The actual root path comes from the backend (ULTRON_BACKUP_ROOT env override
// or %USERPROFILE%\BACKUP fallback), so the frontend just renders report.root.
// ---------------------------------------------------------------------------

type BackupEntry = {
  name: string;
  path: string;
  last_modified: string | null;
  age_hours: number | null;
  exists: boolean;
  status: string;
};

type BackupStatusReport = {
  root: string;
  root_exists: boolean;
  entries: BackupEntry[];
  overall_status: string;
};

function formatHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${Math.round(h)}h`;
  const days = Math.floor(h / 24);
  const rem = Math.round(h % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

function statusTint(s: string): { bg: string; color: string; border: string } {
  switch (s) {
    case "ok":
      return {
        bg: "rgba(63, 185, 80, 0.08)",
        color: "var(--color-success)",
        border: "rgba(63, 185, 80, 0.22)",
      };
    case "stale":
      return {
        bg: "rgba(210, 153, 34, 0.06)",
        color: "var(--color-warn)",
        border: "rgba(210, 153, 34, 0.22)",
      };
    case "cold":
    case "missing":
      return {
        bg: "rgba(248, 81, 73, 0.06)",
        color: "var(--color-danger)",
        border: "rgba(248, 81, 73, 0.22)",
      };
    default:
      return {
        bg: "var(--color-surface-2)",
        color: "var(--color-text-tertiary)",
        border: "var(--color-border)",
      };
  }
}

// v15.2 F7: editable backup root. Reads the current path from the backend
// (which resolves user-config → env → D:\BACKUP → ~/BACKUP), lets the user
// set a new one, and shows whether the path currently exists.
type BackupRootInfo = {
  current: string;
  suggested: string;
  exists: boolean;
  user_configured: boolean;
  config_path: string;
};

function BackupRootEditor({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<BackupRootInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    try {
      const r = (await invoke("get_backup_root")) as BackupRootInfo;
      setInfo(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function save(path: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = (await invoke("set_backup_root", { path })) as BackupRootInfo;
      setInfo(r);
      setSuccess(`Backup root set to ${r.current}${r.exists ? "" : " (path does not exist yet)"}.`);
      window.setTimeout(() => setSuccess(null), 3500);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // v15.2 F8 UX: replace the free-text input with the Tauri native folder
  // picker. Avoids the user pasting half-typed Windows paths.
  async function browse() {
    setError(null);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Select backup root folder",
        defaultPath: info?.current || info?.suggested || undefined,
      });
      if (typeof picked === "string" && picked.trim()) {
        await save(picked.trim());
      }
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div
      className="mb-5 rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold">Backup root path</h3>
        {info?.user_configured && (
          <span
            className="text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            user-configured
          </span>
        )}
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Where ULTRON mirrors its weekly backups. Default:{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {info?.suggested ?? "D:\\BACKUP"}
        </span>
        . Override persisted to{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {info?.config_path ?? "~/.ultron/.tmp/backup-root.txt"}
        </span>
        ; weekly-backup.ps1 honours{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>$env:ULTRON_BACKUP_ROOT</span>.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div
          className="truncate rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            fontFamily: "var(--font-mono)",
            minWidth: 280,
            flex: "1 1 280px",
          }}
          title={info?.current ?? ""}
        >
          {info?.current ?? "—"}
        </div>
        <button
          type="button"
          onClick={browse}
          disabled={busy}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title="Open the Windows folder picker"
        >
          {busy ? "Saving…" : "Browse…"}
        </button>
        <button
          type="button"
          onClick={() => save("")}
          disabled={busy || !info?.user_configured}
          className="rounded px-2.5 py-1.5 text-[11.5px] transition-colors disabled:opacity-40"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Clear the user override and fall back to env / D:\\BACKUP / ~/BACKUP"
        >
          Reset to default
        </button>
      </div>
      {info && (
        <div
          className="mt-2 text-[11px]"
          style={{
            color: info.exists ? "var(--color-text-tertiary)" : "var(--color-warn)",
          }}
        >
          {info.exists
            ? "Path exists. Mirror status below reflects this root."
            : "Path does not exist yet — create it before the next weekly backup runs."}
        </div>
      )}
      {error && (
        <div
          className="mt-2 rounded p-2 text-[11px]"
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
          className="mt-2 rounded p-2 text-[11px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}
    </div>
  );
}

function DiskBackupStatus() {
  const [report, setReport] = useState<BackupStatusReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("backup_status")) as BackupStatusReport;
      setReport(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold">
          Disk mirror{report?.root ? ` (${report.root})` : ""}
        </h3>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-[11px] transition-colors disabled:opacity-50"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p
        className="mb-3 text-[11.5px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Estado del mirror semanal (robocopy /MIR vía
        <span style={{ fontFamily: "var(--font-mono)" }}> weekly-backup.ps1</span>).
        Mtime del top-level subdir = última pasada efectiva.
      </p>

      {error && (
        <div
          className="mb-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && report && !report.root_exists && (
        <div
          className="rounded p-4 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          Root no encontrado: {report.root}. El disco no está montado o nunca
          se ejecutó el primer backup.
        </div>
      )}

      {!loading && report && report.root_exists && report.entries.length === 0 && (
        <div
          className="rounded p-4 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          El root existe pero no hay subcarpetas — primer backup aún no
          se completó.
        </div>
      )}

      {!loading && report && report.entries.length > 0 && (
        <div
          className="rounded"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          {report.entries.map((e, i) => {
            const tint = statusTint(e.status);
            return (
              <div
                key={e.name}
                className="flex items-baseline gap-3 px-3 py-2.5"
                style={{
                  borderTop:
                    i === 0 ? "none" : "1px solid var(--color-border)",
                }}
              >
                <span
                  className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                  style={{
                    background: tint.bg,
                    color: tint.color,
                    border: `1px solid ${tint.border}`,
                    minWidth: 52,
                    textAlign: "center",
                  }}
                >
                  {e.status}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12.5px] font-medium"
                    style={{ color: "var(--color-text)" }}
                  >
                    {e.name}
                  </div>
                  <div
                    className="mt-0.5 truncate text-[10.5px]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-faint)",
                    }}
                    title={e.path}
                  >
                    {e.path}
                  </div>
                </div>
                <span
                  className="shrink-0 tabular-nums text-[11.5px]"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {formatHours(e.age_hours)}
                </span>
                <span
                  className="shrink-0 text-[10.5px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  {e.last_modified ? e.last_modified.slice(0, 10) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// v15.2 F7: "mcps" section removed — MCP enable/disable lives in the MCPs
// top-level tab now. Kept the union without it so stale state references
// surface as compile errors.
type Section =
  | "general"
  | "auth"
  | "mode"
  | "ai-router"
  | "button-prompts"
  | "raw"
  | "backups"
  | "lifecycle";

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
    help: "Análisis del informe de diagnóstico del sistema (Dashboard / Doctor).",
  },
  {
    key: "summarize",
    label: "Summarize newsletter",
    help: "Resumen rápido de un newsletter HTML desde la pestaña News.",
  },
  {
    key: "brainstorm_plans",
    label: "Brainstorm de plans",
    help: "Generar borradores/refinar specs de planes desde la pestaña Plans.",
  },
  {
    key: "news_generate",
    label: "Generate newsletter",
    help: "Generación del cuerpo del newsletter (ULTRON Times).",
  },
  {
    key: "skill_edit",
    label: "Skill editor",
    help: "Asistencia AI al editar SKILL.md desde la pestaña Skills.",
  },
  {
    key: "mcp_create",
    label: "MCP generator",
    help: "Generar plantillas de servidores MCP a partir de descripción.",
  },
  {
    key: "repo_review",
    label: "Repo review",
    help: "Revisión adversarial de repos / cambios uncommitted.",
  },
  {
    key: "personal_analyse",
    label: "Personal analyse",
    help: "Analizar perfil / known.json / style fingerprint desde la pestaña Personal.",
  },
  {
    key: "memory_analyse",
    label: "Memory analyse",
    help: "Asistencia AI al explorar la pestaña Memory (vault, graph, búsquedas).",
  },
  {
    key: "notif_fix",
    label: "Notification fix",
    help: "Resolver una notificación con Claude/Codex desde la pestaña Notifications.",
  },
  {
    key: "self_improve",
    label: "Self-improve",
    help: "Análisis de routing telemetry para mejorar el dispatcher.",
  },
  {
    key: "system_analyse",
    label: "System analyse",
    help: "Análisis de procesos / hooks / scheduled tasks desde la pestaña System.",
  },
  {
    key: "usage_analyse",
    label: "Usage analyse",
    help: "Análisis de coste / tokens / actividad desde la pestaña Usage.",
  },
  {
    key: "skill_create",
    label: "Skill creator",
    help: "Crear una nueva skill desde cero con asistencia AI (botón AI en Skills).",
  },
];

function AiRouterSection() {
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
      setSuccess("AI Router actualizado.");
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
        (a.agent ?? null) !== (b.agent ?? null)
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
          Selecciona qué provider y qué modelo dispara cada acción del Control
          Center: Diagnose PC, summarize newsletter, AI brainstorm de plans,
          generación de newsletter, skill editor, MCP generator y repo review.
          El segundo dropdown (modelo) es opcional — déjalo en{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>default</span> para
          usar el modelo por defecto del provider. El config se persiste en{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            ~/.ultron/.tmp/ai-router.json
          </span>{" "}
          para que cualquier script de ULTRON pueda leerlo.
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
            {AI_ROUTER_ZONES.map((z, i) => (
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
                  <select
                    value={draft[z.key].provider}
                    onChange={(e) =>
                      updateProvider(z.key, e.target.value as AiProvider)
                    }
                    disabled={saving}
                    className="rounded px-2 py-1 text-[12px]"
                    style={{
                      background: "var(--color-surface-1)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border-strong)",
                      outline: "none",
                      fontFamily: "var(--font-mono)",
                      minWidth: 110,
                    }}
                    title={`Provider para ${z.label}`}
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
                    disabled={saving}
                    className="rounded px-2 py-1 text-[12px]"
                    style={{
                      background: "var(--color-surface-1)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border-strong)",
                      outline: "none",
                      fontFamily: "var(--font-mono)",
                      minWidth: 170,
                    }}
                    title={`Modelo para ${z.label} (vacío = default del provider)`}
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
                    disabled={saving}
                    className="rounded px-2 py-1 text-[12px]"
                    style={{
                      background: "var(--color-surface-1)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border-strong)",
                      outline: "none",
                      fontFamily: "var(--font-mono)",
                      minWidth: 170,
                    }}
                    title={
                      draft[z.key].provider === "claude"
                        ? `Subagent para ${z.label} ((none) = ninguno). Solo se aplica a sesiones Claude.`
                        : `Subagent para ${z.label} — ${draft[z.key].provider} ignora la directiva, solo Claude la interpreta.`
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
            ))}
          </div>

          <div className="flex items-center justify-end gap-2">
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
              Reset
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
              {saving ? "Guardando…" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function HotkeyEditor() {
  const [spec, setSpec] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  // F1.6: clicking the "Capturar tecla" button steals focus from the
  // <input>, so onKeyDown never fires. Refocus the input as soon as
  // capturing flips to true.
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<string>("get_global_hotkey")
      .then((s) => {
        setSpec(s);
        setDraft(s);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (capturing) {
      inputRef.current?.focus();
    }
  }, [capturing]);

  async function apply() {
    if (!draft.trim() || draft === spec) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await invoke<string>("set_global_hotkey", { spec: draft.trim() });
      setSpec(r);
      setDraft(r);
      setSuccess(`Registered: ${r}`);
      window.setTimeout(() => setSuccess(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onCapture(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    // Only commit on a non-modifier key press.
    if (["Control", "Alt", "Shift", "Meta", "OS"].includes(e.key)) return;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    let k = e.key;
    if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    setDraft(parts.join("+"));
    setCapturing(false);
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Global hotkey
        </div>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
        >
          stored in ~/.ultron/.tmp/hotkey.txt
        </span>
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Pulsa esta combinación en cualquier app de Windows para mostrar/ocultar
        el Control Center. Formato: <span style={{ fontFamily: "var(--font-mono)" }}>
        Ctrl+Alt+U</span>, <span style={{ fontFamily: "var(--font-mono)" }}>Ctrl+Shift+F12</span>,
        etc. Necesita al menos un modificador (Ctrl/Alt/Shift/Meta).
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onCapture}
          placeholder="Ctrl+Alt+U"
          className="rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: `1px solid ${capturing ? "var(--color-accent)" : "var(--color-border-strong)"}`,
            outline: "none",
            fontFamily: "var(--font-mono)",
            minWidth: 220,
          }}
        />
        <button
          type="button"
          onClick={() => setCapturing(!capturing)}
          className="rounded px-2.5 py-1 text-[11px]"
          style={{
            background: capturing ? "var(--color-surface-3)" : "transparent",
            color: capturing ? "var(--color-text)" : "var(--color-text-tertiary)",
            border: `1px solid ${capturing ? "var(--color-border-strong)" : "var(--color-border)"}`,
          }}
          title="Activa la captura de teclas para grabar la combinación"
        >
          {capturing ? "Cancelar captura" : "Capturar tecla"}
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={busy || !draft.trim() || draft === spec}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {busy ? "Aplicando…" : "Aplicar"}
        </button>
        <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
          activo: <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>{spec || "—"}</span>
        </span>
      </div>

      {error && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
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
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Button prompts section — every Control Center button that spawns a Claude
// or Codex session now reads its prompt from a catalog persisted at
// `~/.ultron/cockpit/button-prompts.json`. This panel lists every catalog
// entry with an editable textarea, a Save button (atomic write), a
// "Refine with Claude" button (opens a session asking Claude to improve the
// prompt) and a "Reset" button (drops the override). The consumer components
// import `getPrompt(key, vars)` from `src/lib/button-prompts.ts` so the
// edits take effect on the next click — no app reload required.
// ---------------------------------------------------------------------------

function ButtonPromptsSection() {
  const [catalog, setCatalog] = useState<ButtonPromptsCatalog | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const c = (await invoke("list_button_prompts")) as ButtonPromptsCatalog;
      setCatalog(c);
      const next: Record<string, string> = {};
      for (const b of c.buttons) next[b.key] = b.prompt;
      setDrafts(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function flashSuccess(msg: string) {
    setSuccess(msg);
    window.setTimeout(() => setSuccess(null), 2500);
  }

  async function onSave(key: string) {
    const draft = drafts[key] ?? "";
    setBusy(key);
    setError(null);
    try {
      await updateButtonPrompt(key, draft);
      const next = await refreshButtonPrompts();
      setCatalog(next);
      const persisted = next.buttons.find((b) => b.key === key)?.prompt ?? draft;
      setDrafts((prev) => ({ ...prev, [key]: persisted }));
      flashSuccess(`Saved ${key}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onReset(key: string) {
    setBusy(key);
    setError(null);
    try {
      const restored = await resetButtonPrompt(key);
      const next = await refreshButtonPrompts();
      setCatalog(next);
      setDrafts((prev) => ({ ...prev, [key]: restored.prompt }));
      flashSuccess(`Reset ${key}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onRefineWithAI(entry: ButtonPrompt) {
    setBusy(entry.key);
    setError(null);
    try {
      const current = drafts[entry.key] ?? entry.prompt;
      const refinePrompt = [
        `Quiero mejorar el prompt asociado al botón "${entry.label}" del ULTRON Control Center.`,
        `Ubicación: ${entry.location}`,
        `Propósito: ${entry.description || "(sin descripción)"}`,
        entry.vars.length > 0
          ? `Variables disponibles (se sustituyen con valores en runtime): ${entry.vars.map((v) => `{${v}}`).join(", ")}.`
          : "Este prompt no usa variables.",
        "",
        "Prompt actual:",
        "```",
        current,
        "```",
        "",
        "Hazme 1-2 preguntas concretas si necesitas contexto y luego propón una versión mejorada. Mantén las variables {var} intactas. Devuelve sólo el prompt nuevo entre triples backticks para que lo pueda pegar en el Control Center.",
      ].join("\n");
      const { getHomeDir, joinPath } = await import("../lib/paths");
      const cwd = joinPath(await getHomeDir(), ".ultron");
      await invoke("spawn_session", {
        provider: "claude",
        prompt: refinePrompt,
        cwd,
        flags: { dangerouslySkipPermissions: false },
      });
      flashSuccess(`Claude session opened to refine "${entry.label}"`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => {
    if (!catalog) return [] as ButtonPrompt[];
    const q = filter.trim().toLowerCase();
    if (!q) return catalog.buttons;
    return catalog.buttons.filter(
      (b) =>
        b.key.toLowerCase().includes(q) ||
        b.label.toLowerCase().includes(q) ||
        b.location.toLowerCase().includes(q),
    );
  }, [catalog, filter]);

  if (loading) {
    return (
      <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
        Loading button prompts…
      </div>
    );
  }

  return (
    <div>
      <p className="text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
        Each entry here is the prompt that fires when you press an AI-powered
        button somewhere in the Control Center. Edit it, click Save, and the
        next click of that button uses your version. "Refine with Claude"
        opens a Claude session that helps you rewrite the prompt; "Reset"
        drops the override and goes back to the canonical default.
      </p>
      <p
        className="mt-1 text-[10.5px]"
        style={{
          color: "var(--color-text-faint)",
          fontFamily: "var(--font-mono)",
        }}
      >
        ~/.ultron/cockpit/button-prompts.json
      </p>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          placeholder="Filter by key, label or location…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 rounded px-2 py-1.5 text-[12px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={() => void load()}
          className="rounded px-2.5 py-1.5 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          Reload
        </button>
      </div>

      {error && (
        <div
          className="mt-3 rounded p-3 text-[12px]"
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
          className="mt-3 rounded p-2 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {filtered.map((b) => {
          const draft = drafts[b.key] ?? "";
          const dirty = draft !== b.prompt;
          const isBusy = busy === b.key;
          return (
            <div
              key={b.key}
              className="rounded p-3"
              style={{
                background: "var(--color-surface-2)",
                border: `1px solid ${b.overridden ? "var(--color-accent)" : "var(--color-border)"}`,
              }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[13px] font-semibold"
                      style={{ color: "var(--color-text)" }}
                    >
                      {b.label}
                    </span>
                    {b.overridden && (
                      <span
                        className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                        style={{
                          background: "rgba(88, 166, 255, 0.12)",
                          color: "var(--color-accent)",
                        }}
                      >
                        custom
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-0.5 text-[11px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {b.location} ·{" "}
                    <span style={{ fontFamily: "var(--font-mono)" }}>{b.key}</span>
                  </div>
                  {b.description && (
                    <div
                      className="mt-1 text-[11.5px]"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {b.description}
                    </div>
                  )}
                  {b.vars.length > 0 && (
                    <div
                      className="mt-1 text-[10.5px]"
                      style={{
                        color: "var(--color-text-faint)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      vars: {b.vars.map((v) => `{${v}}`).join(", ")}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void onRefineWithAI(b)}
                    disabled={isBusy}
                    className="rounded px-2.5 py-1 text-[11px] disabled:opacity-40"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                    title="Open a Claude session that helps you rewrite this prompt"
                  >
                    Refine with Claude
                  </button>
                  <button
                    type="button"
                    onClick={() => void onReset(b.key)}
                    disabled={isBusy || !b.overridden}
                    className="rounded px-2.5 py-1 text-[11px] disabled:opacity-30"
                    style={{
                      background: "transparent",
                      color: "var(--color-text-tertiary)",
                      border: "1px solid var(--color-border)",
                    }}
                    title="Drop the override and go back to the default"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => void onSave(b.key)}
                    disabled={isBusy || !dirty}
                    className="rounded px-2.5 py-1 text-[11px] font-medium disabled:opacity-40"
                    style={{
                      background: "var(--color-accent)",
                      color: "var(--color-accent-text)",
                    }}
                  >
                    {isBusy ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              <textarea
                value={draft}
                onChange={(e) =>
                  setDrafts((prev) => ({ ...prev, [b.key]: e.target.value }))
                }
                rows={Math.min(14, Math.max(4, draft.split("\n").length))}
                className="mt-3 w-full rounded p-2.5 text-[12px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: `1px solid ${dirty ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  resize: "vertical",
                }}
                spellCheck={false}
              />
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div
            className="rounded p-6 text-center text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No buttons match the filter.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InAppShortcutsEditor — replaces the old read-only grid. Each row is a
// fixed label + an editable input with the same "Capturar tecla" affordance
// as HotkeyEditor. Persisted via the in_app_shortcuts Tauri commands. We
// dispatch an in-window event after every save so App.tsx can refresh its
// binding cache without polling.
// ---------------------------------------------------------------------------

/** Display rows for the editor — order = display order. Keys MUST match
 *  the action ids in `in_app_shortcuts::default_bindings` (Rust) AND the
 *  switch in App.tsx, otherwise the binding silently won't fire. */
const IN_APP_ROWS: { key: string; label: string }[] = [
  { key: "command.palette", label: "Command palette" },
  { key: "open.settings", label: "Settings (via Ctrl+,)" },
  { key: "refresh.all", label: "Refresh dashboard data" },
  { key: "tab.dashboard", label: "Dashboard" },
  { key: "tab.usage", label: "Usage" },
  { key: "tab.notifications", label: "Notifications" },
  { key: "tab.sessions", label: "Sessions" },
  { key: "tab.projects", label: "Projects" },
  { key: "tab.plans", label: "Plans" },
  { key: "tab.memory", label: "Memory" },
  { key: "tab.skills", label: "Skills" },
  { key: "tab.logs", label: "Logs" },
  { key: "tab.settings", label: "Settings (tab)" },
];

function comboFromEvent(e: React.KeyboardEvent<HTMLInputElement>): string | null {
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  let k = e.key;
  if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join("+");
}

function InAppShortcutsEditor() {
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    (async () => {
      try {
        const m = (await invoke("get_in_app_shortcuts")) as Record<string, string>;
        setBindings(m || {});
        setDirty(m || {});
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (capturing) inputRefs.current[capturing]?.focus();
  }, [capturing]);

  const isDirty = useMemo(() => {
    const keys = new Set([...Object.keys(bindings), ...Object.keys(dirty)]);
    for (const k of keys) {
      if ((bindings[k] ?? "") !== (dirty[k] ?? "")) return true;
    }
    return false;
  }, [bindings, dirty]);

  async function save() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      // Send only non-empty values; backend persists what we send and
      // falls back to defaults for everything missing.
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(dirty)) {
        const t = (v || "").trim();
        if (t) filtered[k] = t;
      }
      await invoke("set_in_app_shortcuts", { map: filtered });
      setBindings(filtered);
      // App.tsx listens for this and refetches its binding cache.
      window.dispatchEvent(new Event("in-app-shortcuts-updated"));
      setSuccess("Saved");
      window.setTimeout(() => setSuccess(null), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onCapture(actionKey: string, e: React.KeyboardEvent<HTMLInputElement>) {
    if (capturing !== actionKey) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e);
    if (!combo) return;
    setDirty((prev) => ({ ...prev, [actionKey]: combo }));
    setCapturing(null);
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          In-app shortcuts
        </div>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
        >
          ~/.ultron/.tmp/in-app-shortcuts.json
        </span>
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Atajos dentro del Control Center. Edita el combo o pulsa "Capturar"
        y aprieta la combinación. Tab-jumps no roban teclas si estás en un input.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        {IN_APP_ROWS.map(({ key, label }) => {
          const current = dirty[key] ?? "";
          const isCap = capturing === key;
          return (
            <div key={key} className="flex items-center gap-2">
              <span
                className="w-40 shrink-0 text-[11.5px]"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {label}
              </span>
              <input
                ref={(el) => {
                  inputRefs.current[key] = el;
                }}
                type="text"
                value={current}
                onChange={(e) =>
                  setDirty((prev) => ({ ...prev, [key]: e.target.value }))
                }
                onKeyDown={(e) => onCapture(key, e)}
                placeholder="Alt+1"
                className="flex-1 rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: `1px solid ${isCap ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  minWidth: 0,
                }}
              />
              <button
                type="button"
                onClick={() => setCapturing(isCap ? null : key)}
                className="rounded px-2 py-1 text-[10.5px]"
                style={{
                  background: isCap ? "var(--color-surface-3)" : "transparent",
                  color: isCap ? "var(--color-text)" : "var(--color-text-tertiary)",
                  border: `1px solid ${isCap ? "var(--color-border-strong)" : "var(--color-border)"}`,
                }}
                title="Pulsa para capturar la siguiente combinación"
              >
                {isCap ? "…" : "Capturar"}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !isDirty}
          className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {busy ? "Guardando…" : "Guardar atajos"}
        </button>
        {success && (
          <span className="text-[11px]" style={{ color: "var(--color-success)" }}>
            {success}
          </span>
        )}
      </div>

      {error && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
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
  );
}

// ---------------------------------------------------------------------------
// ProjectHotkeysEditor — 10 slots, each with a combo + project dropdown.
// Slot N may be empty. Saving registers the global hotkey via Tauri
// (Rust side: project_hotkeys::set_project_at_slot). Pressing the hotkey
// emits "project-hotkey-custom" which App.tsx wires to open_project.
// ---------------------------------------------------------------------------

interface ProjectHotkeySlotRow {
  slot: number;
  combo: string;
  project_id: string;
}

interface MiniProject {
  id: string;
  name: string | null;
}

function ProjectHotkeysEditor() {
  const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
  const [projects, setProjects] = useState<MiniProject[]>([]);
  const [slots, setSlots] = useState<Record<number, { combo: string; projectId: string }>>({});
  const [capturing, setCapturing] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  async function loadAll() {
    try {
      const ps = (await invoke("list_projects")) as Array<{
        id: string;
        name: string | null;
      }>;
      setProjects(ps.map((p) => ({ id: p.id, name: p.name })));
    } catch (e) {
      setError(String(e));
    }
    try {
      const rows = (await invoke("get_project_hotkeys")) as ProjectHotkeySlotRow[];
      const next: Record<number, { combo: string; projectId: string }> = {};
      for (const r of rows) {
        next[r.slot] = { combo: r.combo, projectId: r.project_id };
      }
      setSlots(next);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (capturing != null) inputRefs.current[capturing]?.focus();
  }, [capturing]);

  function onCapture(slot: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (capturing !== slot) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e);
    if (!combo) return;
    setSlots((prev) => ({
      ...prev,
      [slot]: { combo, projectId: prev[slot]?.projectId ?? "" },
    }));
    setCapturing(null);
  }

  async function saveSlot(slot: number) {
    const entry = slots[slot];
    if (!entry || !entry.combo.trim() || !entry.projectId) {
      setError(`Slot ${slot}: pick a combo AND a project before saving`);
      return;
    }
    setBusy(slot);
    setError(null);
    setSuccess(null);
    try {
      await invoke("set_project_at_slot", {
        slot,
        projectId: entry.projectId,
        combo: entry.combo.trim(),
      });
      setSuccess(`Slot ${slot} saved (${entry.combo.trim()})`);
      window.setTimeout(() => setSuccess(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function clearSlot(slot: number) {
    setBusy(slot);
    setError(null);
    try {
      await invoke("clear_project_at_slot", { slot });
      setSlots((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Project hotkeys
        </div>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
        >
          ~/.ultron/cockpit/project-hotkeys.json
        </span>
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Asigna un hotkey global (al estilo Ctrl+Alt+P) para abrir un proyecto
        concreto desde cualquier app de Windows. Distinto del set legacy
        Ctrl+Alt+1..9 (que sigue los pinned). Necesita ≥1 modificador.
      </p>

      <div className="mt-3 space-y-2">
        {SLOTS.map((slot) => {
          const entry = slots[slot] ?? { combo: "", projectId: "" };
          const isCap = capturing === slot;
          const isBusy = busy === slot;
          return (
            <div
              key={slot}
              className="flex flex-wrap items-center gap-2"
              style={{ minHeight: 32 }}
            >
              <span
                className="w-12 shrink-0 text-[11px]"
                style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
              >
                #{slot}
              </span>
              <input
                ref={(el) => {
                  inputRefs.current[slot] = el;
                }}
                type="text"
                value={entry.combo}
                onChange={(e) =>
                  setSlots((prev) => ({
                    ...prev,
                    [slot]: { combo: e.target.value, projectId: prev[slot]?.projectId ?? "" },
                  }))
                }
                onKeyDown={(e) => onCapture(slot, e)}
                placeholder="Ctrl+Alt+P"
                className="rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: `1px solid ${isCap ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  width: 160,
                }}
              />
              <button
                type="button"
                onClick={() => setCapturing(isCap ? null : slot)}
                className="rounded px-2 py-1 text-[10.5px]"
                style={{
                  background: isCap ? "var(--color-surface-3)" : "transparent",
                  color: isCap ? "var(--color-text)" : "var(--color-text-tertiary)",
                  border: `1px solid ${isCap ? "var(--color-border-strong)" : "var(--color-border)"}`,
                }}
              >
                {isCap ? "…" : "Capturar"}
              </button>
              <select
                value={entry.projectId}
                onChange={(e) =>
                  setSlots((prev) => ({
                    ...prev,
                    [slot]: { combo: prev[slot]?.combo ?? "", projectId: e.target.value },
                  }))
                }
                className="rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  outline: "none",
                  minWidth: 180,
                  flex: "1 1 200px",
                }}
              >
                <option value="">— project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void saveSlot(slot)}
                disabled={isBusy || !entry.combo.trim() || !entry.projectId}
                className="rounded px-2 py-1 text-[10.5px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {isBusy ? "…" : "Guardar"}
              </button>
              <button
                type="button"
                onClick={() => void clearSlot(slot)}
                disabled={isBusy || (!entry.combo && !entry.projectId)}
                className="rounded px-2 py-1 text-[10.5px] disabled:opacity-40"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border)",
                }}
                title="Borra el slot y desregistra el hotkey"
              >
                Borrar
              </button>
            </div>
          );
        })}
      </div>

      {success && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}
      {error && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
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
  );
}

function GeneralSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wipe legacy autostart artifacts (Startup-folder .lnk, dangling
  // StartupApproved record) before/after every interaction so the plugin's
  // registry value is the single source of truth. Best-effort: a failure
  // here must not block the user from reading the toggle state.
  async function purgeLegacy(): Promise<string[]> {
    try {
      const res = await invoke<{ removed: string[]; warnings: string[] }>(
        "purge_legacy_autostart",
      );
      return res.removed ?? [];
    } catch {
      return [];
    }
  }

  useEffect(() => {
    (async () => {
      await purgeLegacy();
      try {
        setEnabled(await isAutostartEnabled());
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  async function toggle() {
    if (enabled === null) return;
    setBusy(true);
    setError(null);
    try {
      if (enabled) {
        await disableAutostart();
        setEnabled(false);
      } else {
        await enableAutostart();
        setEnabled(true);
      }
      // After every toggle clean any rogue artifact so the registry stays
      // the only source of truth on subsequent isAutostartEnabled() reads.
      await purgeLegacy();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Autostart with Windows */}
      <div
        className="flex items-start gap-3 rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <button
          type="button"
          onClick={toggle}
          disabled={busy || enabled === null}
          className="mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
          style={{
            background: enabled
              ? "var(--color-success)"
              : "var(--color-surface-3)",
            border: "1px solid var(--color-border-strong)",
            padding: "1px",
          }}
          title={
            enabled
              ? "Click to stop launching ULTRON at Windows logon"
              : "Click to launch ULTRON at Windows logon"
          }
        >
          <span
            className="block h-3.5 w-3.5 rounded-full transition-transform"
            style={{
              background: "var(--color-text)",
              transform: enabled ? "translateX(16px)" : "translateX(0)",
            }}
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
            Start with Windows
          </div>
          <p
            className="mt-1 text-[12px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Adds <span style={{ fontFamily: "var(--font-mono)" }}>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</span>{" "}
            entry so the Control Center launches on logon with{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>--from-autostart</span>.
            The main window opens automatically and appears in the taskbar.
          </p>
        </div>
      </div>

      {/* Global hotkey */}
      <HotkeyEditor />

      {/* In-app shortcuts — now editable. Persisted at
          ~/.ultron/.tmp/in-app-shortcuts.json via get/set_in_app_shortcuts.
          App.tsx mirrors the map and dispatches keys against it. */}
      <InAppShortcutsEditor />

      {/* Custom per-project global hotkeys (Settings → Project hotkeys).
          Distinct from the legacy Ctrl+Alt+1..9 pin-derived slots —
          these let the user pick (slot, combo, project_id) tuples. */}
      <ProjectHotkeysEditor />


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
    </div>
  );
}

function ModeSection() {
  const { mode, autodetectDefault, isAuto, refresh } = useUltronMode();
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function resetToAuto() {
    setResetting(true);
    setResetError(null);
    try {
      await invoke("reset_mode_to_autodetect");
      refresh();
    } catch (e) {
      setResetError(String(e));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h3 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Orchestration mode
        </h3>
        <p
          className="mt-1 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          The mode the hook system primes for the next ULTRON session. Source of truth:
          {" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>~/.ultron/.tmp/current-session.json</span>.
        </p>
      </header>

      {/* v15.2 F7: prominent current + default + reset row.
          - Currently active (big): the resolved mode now (or AUTO if user
            hit the reset button — the hooks will pick a concrete mode on
            the next SessionStart).
          - Default (small): what autodetect would pick — currently MEDIUM
            per mode-trigger.py heuristics. */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div
              className="text-[10.5px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Currently active
            </div>
            <div
              className="mt-1 text-[24px] font-semibold leading-none tabular-nums"
              style={{ color: "var(--color-text)" }}
            >
              {isAuto ? "AUTO" : (mode ?? "—")}
            </div>
            <div
              className="mt-2 text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Default (autodetect would pick):{" "}
              <strong style={{ color: "var(--color-text-secondary)" }}>
                {autodetectDefault}
              </strong>
            </div>
          </div>
          <button
            type="button"
            onClick={resetToAuto}
            disabled={resetting}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Writes mode=auto to current-session.json — the next SessionStart hook will pick the mode from the prompt instead of using a stored override."
          >
            {resetting ? "Resetting…" : "Reset to autodetect"}
          </button>
        </div>
        {resetError && (
          <div
            className="mt-3 rounded p-2 text-[11.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {resetError}
          </div>
        )}
      </div>

      <ModeSwitcher current={mode} onChange={() => refresh()} />
    </div>
  );
}

export function Settings() {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("general");
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SettingsSaveResult | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("settings_read")) as SettingsSnapshot;
      setSnapshot(r);
      setDraft(JSON.parse(JSON.stringify(r.content)));
      setDirty(false);
      setError(null);
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
    setSaveResult(null);
    try {
      const r = (await invoke("settings_save", { content: draft })) as SettingsSaveResult;
      setSaveResult(r);
      // reload to pick up server-side normalization
      await load();
    } catch (e) {
      setSaveResult({
        success: false,
        backup_path: null,
        new_size_bytes: 0,
      });
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (snapshot) {
      setDraft(JSON.parse(JSON.stringify(snapshot.content)));
      setDirty(false);
      setSaveResult(null);
    }
  }

  // v15.2 F7: toggleMcp / mcps memo removed — MCP enable/disable now lives
  // in the MCPs top-level tab (EnableDisableSection in MCPs.tsx).

  return (
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Settings</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            Edit ~/.claude/settings.json · backups automáticos a ~/.ultron/backups/control-center-settings
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <>
              <button
                type="button"
                onClick={discard}
                disabled={saving}
                className="rounded px-3 py-1.5 text-[12px] transition-colors"
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
                disabled={saving}
                className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={load}
            disabled={loading || saving}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Reload
          </button>
        </div>
      </header>

      {/* Section tabs */}
      <div
        className="inline-flex rounded p-0.5"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        {[
          { id: "general" as Section, label: "General" },
          { id: "auth" as Section, label: "Auth" },
          { id: "mode" as Section, label: "Mode" },
          { id: "ai-router" as Section, label: "AI Router" },
          { id: "button-prompts" as Section, label: "Button prompts" },
          // v15.2 F7: "MCPs" sub-tab removed — moved to top-level MCPs tab.
          { id: "raw" as Section, label: "Editor" },
          { id: "backups" as Section, label: "Backups" },
          { id: "lifecycle" as Section, label: "App lifecycle" },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSection(t.id)}
            className="rounded px-3 py-1 text-[12px] font-medium transition-colors"
            style={{
              background: section === t.id ? "var(--color-surface-3)" : "transparent",
              color: section === t.id ? "var(--color-text)" : "var(--color-text-tertiary)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div
          className="mt-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {saveResult && saveResult.success && (
        <div
          className="mt-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          Saved. Backup at{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {saveResult.backup_path}
          </span>
        </div>
      )}

      <div className="mt-5">
        {section === "general" && <GeneralSection />}
        {section === "auth" && <AuthStatus />}
        {section === "mode" && <ModeSection />}
        {section === "ai-router" && <AiRouterSection />}
        {section === "button-prompts" && <ButtonPromptsSection />}
        {/* v15.2 F7: MCPs enable/disable moved to the top-level MCPs tab.
            The MCPRow / toggleMcp / mcps memo below remain in scope as
            inert helpers — kept for retrocompat in case external code
            imports them, will be removed in F8. */}

        {section === "raw" && draft && (
          <JsonEditor
            obj={draft}
            onChange={(next) => {
              setDraft(next);
              setDirty(true);
            }}
          />
        )}

        {section === "backups" && snapshot && (
          <div>
            <BackupRootEditor onChanged={() => { /* DiskBackupStatus refetches on mount */ }} />
            <DiskBackupStatus />
            <p
              className="mb-3 mt-6 text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Each Save creates a timestamped backup of the previous
              settings.json. Last 8 shown.
            </p>
            <div
              className="mb-3 truncate text-[10.5px]"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-faint)",
              }}
            >
              {snapshot.backup_dir}
            </div>
            {snapshot.recent_backups.length === 0 ? (
              <div
                className="rounded p-6 text-center text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                No backups yet. The first Save will create one.
              </div>
            ) : (
              <ul
                className="rounded"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {snapshot.recent_backups.map((b, i) => (
                  <li
                    key={b}
                    className="border-t px-3 py-2 text-[12px]"
                    style={{
                      borderColor: i === 0 ? "transparent" : "var(--color-border)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {section === "lifecycle" && <LifecyclePanel />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LifecyclePanel — Uninstall + Update buttons. Both spawn wt.exe in a new
// window so the user sees the script's output live and can confirm or
// abort. The Control Center keeps running in the meantime; the update
// path produces a new binary alongside the current one, which the user
// can run after closing this instance.
// ---------------------------------------------------------------------------

function LifecyclePanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function run(kind: "uninstall" | "update") {
    setBusy(kind);
    setError(null);
    setStatus(null);
    try {
      await invoke("run_app_lifecycle", { kind });
      setStatus(
        kind === "uninstall"
          ? "Uninstaller opened in a new terminal. Follow the prompts there."
          : "Update opened in a new terminal. Rebuild takes ~3-5 minutes the first time.",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[13px] font-semibold">App lifecycle</h3>
        <p
          className="mt-1 text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          One-shot actions for the Control Center binary itself. Both open a
          new terminal window so you can watch the script run; the app
          keeps working in the meantime.
        </p>
      </div>

      {status && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {status}
        </div>
      )}
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

      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Update</div>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Rebuild the Control Center from the latest source in this
              repo. Runs <code style={{ fontFamily: "var(--font-mono)" }}>
              npm run tauri build</code> in <code style={{ fontFamily: "var(--font-mono)" }}>
              control-center/</code>. The current window keeps running;
              relaunch after the new binary appears in
              <code style={{ fontFamily: "var(--font-mono)" }}> src-tauri/target/release/bundle/</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void run("update")}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy === "update" ? "Opening…" : "Rebuild"}
          </button>
        </div>
      </div>

      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid rgba(248, 81, 73, 0.28)",
        }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <div
              className="text-[13px] font-semibold"
              style={{ color: "var(--color-danger)" }}
            >
              Uninstall
            </div>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Open the uninstaller in a new terminal. Removes
              <code style={{ fontFamily: "var(--font-mono)" }}> ~/.ultron/</code>,
              autostart entry, ULTRON scheduled tasks, Start Menu shortcuts,
              and hook entries that point at ~/.ultron in
              <code style={{ fontFamily: "var(--font-mono)" }}> ~/.claude/settings.json</code>.
              Your Claude Code skills in
              <code style={{ fontFamily: "var(--font-mono)" }}> ~/.claude/skills/</code> are preserved.
              The terminal asks for confirmation before doing anything destructive.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void run("uninstall")}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.32)",
            }}
          >
            {busy === "uninstall" ? "Opening…" : "Uninstall…"}
          </button>
        </div>
      </div>
    </div>
  );
}
