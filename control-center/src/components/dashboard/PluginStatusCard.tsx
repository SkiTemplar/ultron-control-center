// ECC plugin status — installed flag + counts for skills/agents/hooks/mcps.
//
// v2.7 redesign: bigger card, stat chips with 18px values, consistent with
// the rest of the dashboard.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { PluginInfo } from "../../types";
import { Card, SmallButton, relativeTime } from "./Card";

export function PluginStatusCard() {
  const [info, setInfo] = useState<PluginInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const r = await invoke<PluginInfo>("read_plugin_info");
        if (!cancelled) setInfo(r);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const accent = info?.installed ? "ok" : info ? "warn" : "neutral";

  async function openRoot() {
    if (info?.root) {
      try {
        await openPath(info.root);
      } catch {
        // best-effort — surface in console only
      }
    }
  }

  return (
    <Card
      title="ECC plugin"
      subtitle={info?.version ? `v${info.version}` : "Everything Claude Code"}
      accent={accent}
      loading={loading}
      error={error}
      action={
        info?.root ? (
          <SmallButton
            onClick={() => void openRoot()}
            size="md"
            title="Open plugin folder"
          >
            Folder
          </SmallButton>
        ) : null
      }
    >
      {info && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{
                background: info.installed
                  ? "var(--color-success)"
                  : "var(--color-warn)",
              }}
            />
            <span
              className="text-[16px] font-semibold leading-none"
              style={{ color: "var(--color-text)" }}
            >
              {info.installed ? "Installed" : "Not installed"}
            </span>
            {info.last_update_iso && (
              <span
                className="ml-auto text-[11px] tabular-nums"
                style={{ color: "var(--color-text-faint)" }}
              >
                {relativeTime(info.last_update_iso)}
              </span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2">
            <CountChip label="skills" value={info.skills_count} />
            <CountChip label="agents" value={info.agents_count} />
            <CountChip label="hooks" value={info.hooks_count} />
            <CountChip label="mcps" value={info.mcp_servers_count} />
          </div>
        </div>
      )}
    </Card>
  );
}

function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="rounded px-2 py-2 text-center"
      style={{
        background: "var(--color-surface-3)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="text-[18px] font-semibold leading-none tabular-nums"
        style={{ color: "var(--color-text)" }}
      >
        {value}
      </div>
      <div
        className="mt-1 text-[10px] uppercase tracking-[0.05em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
    </div>
  );
}
