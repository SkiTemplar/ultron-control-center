// ECC plugin status — installed flag + counts for skills/agents/hooks/mcps.

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
      accent={accent}
      loading={loading}
      error={error}
      action={
        info?.root ? (
          <SmallButton onClick={() => void openRoot()} title="Open plugin folder">
            folder
          </SmallButton>
        ) : null
      }
    >
      {info && (
        <div className="space-y-1">
          <div className="flex items-baseline gap-2">
            <span
              className="text-[12.5px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {info.installed ? "Installed" : "Not installed"}
            </span>
            {info.version && (
              <span
                className="text-[10.5px] tabular-nums"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                v{info.version}
              </span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2 pt-1">
            <CountChip label="skills" value={info.skills_count} />
            <CountChip label="agents" value={info.agents_count} />
            <CountChip label="hooks" value={info.hooks_count} />
            <CountChip label="mcps" value={info.mcp_servers_count} />
          </div>
          {info.last_update_iso && (
            <div
              className="pt-1 text-[11.5px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              Updated {relativeTime(info.last_update_iso)}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="rounded px-2 py-1 text-center"
      style={{
        background: "var(--color-surface-3)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="text-[14px] font-semibold tabular-nums leading-none"
        style={{ color: "var(--color-text)" }}
      >
        {value}
      </div>
      <div
        className="mt-0.5 text-[9.5px] uppercase tracking-[0.05em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
    </div>
  );
}
