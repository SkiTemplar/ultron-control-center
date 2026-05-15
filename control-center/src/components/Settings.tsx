import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import type { SettingsSaveResult, SettingsSnapshot } from "../types";
import { AuthStatus } from "./AuthStatus";
import { ModeSwitcher, useUltronMode } from "./ModeSwitcher";

// ---------------------------------------------------------------------------
// MCP servers section — toggle enable/disable + show raw config
// ---------------------------------------------------------------------------

type McpServer = {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
  disabled?: boolean;
};

function MCPRow({
  name,
  cfg,
  onToggle,
}: {
  name: string;
  cfg: McpServer;
  onToggle: () => void;
}) {
  const enabled = !cfg.disabled;
  const transport = cfg.type === "sse" ? "sse" : cfg.url ? "http" : "stdio";
  return (
    <div
      className="flex items-start gap-3 rounded p-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        opacity: enabled ? 1 : 0.55,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
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
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
            {name}
          </span>
          <span
            className="text-[10.5px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {transport}
          </span>
          {!enabled && (
            <span
              className="text-[10px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              disabled
            </span>
          )}
        </div>
        <div
          className="mt-1 truncate text-[10.5px]"
          style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}
          title={cfg.url || `${cfg.command || ""} ${(cfg.args || []).join(" ")}`}
        >
          {cfg.url || `${cfg.command || "?"} ${(cfg.args || []).slice(0, 3).join(" ")}`}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raw JSON viewer
// ---------------------------------------------------------------------------

function JsonPreview({ obj }: { obj: unknown }) {
  const text = useMemo(() => JSON.stringify(obj, null, 2), [obj]);
  return (
    <pre
      className="max-h-[420px] overflow-auto rounded p-3 text-[11px] leading-relaxed"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
        fontFamily: "var(--font-mono)",
        color: "var(--color-text-secondary)",
        whiteSpace: "pre-wrap",
      }}
    >
      {text}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Section = "general" | "auth" | "mode" | "mcps" | "raw" | "backups";

function GeneralSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    isAutostartEnabled()
      .then(setEnabled)
      .catch((e) => setError(String(e)));
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
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Global hotkey
        </div>
        <p
          className="mt-1 text-[12px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Press{" "}
          <kbd
            className="rounded px-1.5 py-0.5 text-[11px]"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Ctrl + Alt + U
          </kbd>{" "}
          anywhere on Windows to toggle the Control Center. Registered once at
          launch. If another app already grabs that combo, the registration is
          skipped and only the tray icon works.
        </p>
      </div>

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
  const { mode, refresh } = useUltronMode();
  return (
    <div className="space-y-3">
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
      <ModeSwitcher current={mode} onChange={() => refresh()} />
      {mode && (
        <p
          className="text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Active: <strong style={{ color: "var(--color-text)" }}>{mode}</strong>
        </p>
      )}
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

  function toggleMcp(name: string) {
    if (!draft) return;
    const next = JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
    const mcpServers = (next.mcpServers ?? {}) as Record<string, McpServer>;
    const cfg = mcpServers[name];
    if (!cfg) return;
    cfg.disabled = !cfg.disabled;
    next.mcpServers = mcpServers;
    setDraft(next);
    setDirty(true);
  }

  const mcps = useMemo(() => {
    if (!draft) return [] as [string, McpServer][];
    const obj = (draft.mcpServers ?? {}) as Record<string, McpServer>;
    return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
  }, [draft]);

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
          { id: "mcps" as Section, label: "MCPs" },
          { id: "raw" as Section, label: "Raw JSON" },
          { id: "backups" as Section, label: "Backups" },
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
        {section === "mcps" && (
          <>
            <p
              className="mb-3 text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Toggle enable/disable. The change writes to settings.json on Save.
              Claude Code picks up the change on the next session start.
            </p>
            {mcps.length === 0 ? (
              <div
                className="rounded p-6 text-center text-[13px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                }}
              >
                No mcpServers in settings.json.
              </div>
            ) : (
              <div className="space-y-2">
                {mcps.map(([name, cfg]) => (
                  <MCPRow
                    key={name}
                    name={name}
                    cfg={cfg}
                    onToggle={() => toggleMcp(name)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {section === "raw" && draft && <JsonPreview obj={draft} />}

        {section === "backups" && snapshot && (
          <div>
            <p
              className="mb-3 text-[12px]"
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
      </div>
    </div>
  );
}
