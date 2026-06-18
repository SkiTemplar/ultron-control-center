// ---------------------------------------------------------------------------
// Enable/disable section — moved from Settings tab (v15.2 F7).
// Toggles the `disabled` flag in settings.json for each mcpServers entry.
// This is independent of "delete from settings.json" (the Card action below):
// disabling keeps the entry around so the user can flip it back on without
// re-entering command/args/env.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SettingsSnapshot, SettingsSaveResult } from "../../types";
import type { EnableDisableMcp } from "./types";

export function EnableDisableSection({ onChanged }: { onChanged: () => void }) {
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
          className="text-[11.5px]"
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
