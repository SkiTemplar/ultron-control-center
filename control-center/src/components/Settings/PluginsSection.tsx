// Phase 7: ECC plugin introspection panel inside Settings.
//
// Reads ~/.claude/plugins/cache/ecc/ecc/<version>/ and shows version,
// last update, and per-component counts. Each tile jumps to the matching
// top-level Sidebar tab.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PluginInfo } from "../../types";

type Props = {
  onNavigate?: (tab: string) => void;
};

export function PluginsSection({ onNavigate }: Props) {
  const [info, setInfo] = useState<PluginInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<PluginInfo>("read_plugin_info")
      .then(setInfo)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) {
    return (
      <div
        className="rounded p-3 text-[12.5px]"
        style={{
          background: "rgba(248, 81, 73, 0.06)",
          border: "1px solid rgba(248, 81, 73, 0.22)",
          color: "var(--color-danger)",
        }}
      >
        {err}
      </div>
    );
  }
  if (!info) {
    return (
      <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Loading plugin info…
      </div>
    );
  }
  if (!info.installed) {
    return (
      <div
        className="rounded p-3 text-[12.5px]"
        style={{
          background: "rgba(245, 158, 11, 0.06)",
          border: "1px solid rgba(245, 158, 11, 0.22)",
          color: "var(--color-text-secondary)",
        }}
      >
        ECC plugin is not installed. Run{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>/plugin install ecc@ecc</code> in
        Claude Code.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-[14px] font-semibold">ECC plugin</h2>
        <span
          className="rounded px-2 py-0.5 text-[11px]"
          style={{
            background: "var(--color-surface-3)",
            fontFamily: "var(--font-mono)",
            color: "var(--color-text)",
          }}
        >
          v{info.version}
        </span>
        {info.last_update_iso && (
          <span
            className="text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            updated {info.last_update_iso.slice(0, 10)}
          </span>
        )}
      </div>
      {info.root && (
        <div
          className="text-[11px] truncate"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--color-text-faint)",
          }}
        >
          {info.root}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Skills"
          count={info.skills_count}
          onClick={() => onNavigate?.("skills")}
        />
        <Tile
          label="Agents"
          count={info.agents_count}
          onClick={() => onNavigate?.("agents")}
        />
        <Tile
          label="Hooks"
          count={info.hooks_count}
          onClick={() => onNavigate?.("hooks")}
        />
        <Tile
          label="MCP servers"
          count={info.mcp_servers_count}
          onClick={() => onNavigate?.("mcps")}
        />
      </div>
    </div>
  );
}

type TileProps = {
  label: string;
  count: number;
  onClick?: () => void;
};

function Tile({ label, count, onClick }: TileProps) {
  return (
    <button
      type="button"
      className="flex flex-col items-start gap-1 rounded p-3 text-left transition-colors hover:opacity-90"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-strong)",
        color: "var(--color-text)",
      }}
      onClick={onClick}
    >
      <div
        className="text-[11px] uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div className="text-[22px] font-semibold leading-none">{count}</div>
    </button>
  );
}

export default PluginsSection;
