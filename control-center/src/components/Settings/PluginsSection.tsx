// Plugins panel (rewrite 2026-05-23).
//
// Lists every plugin under ~/.claude/plugins/cache/<marketplace>/<plugin>/
// (not just ECC). Per row: name, version, marketplace, install state, the
// per-component counts (skills/agents/hooks/mcp), an update button that
// copies `/plugin install <coord>` to the clipboard so the user can paste
// it into Claude Code, and an uninstall button that wipes the cache dir
// after confirmation.
//
// Backend: list_all_plugins + uninstall_plugin_cache (plugins_info.rs).
//
// The "Browse marketplaces" section is a static list of the curated
// marketplaces USER already uses; each entry copies the canonical
// `/plugin marketplace add` URL so the user can paste it into Claude Code.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../../lib/dialog";

type Props = {
  onNavigate?: (tab: string) => void;
};

type PluginEntry = {
  name: string;
  marketplace: string;
  coordinate: string;
  version: string;
  root: string;
  installed: boolean;
  last_update_iso: string | null;
  skills_count: number;
  agents_count: number;
  hooks_count: number;
  mcp_servers_count: number;
};

interface Marketplace {
  id: string;
  label: string;
  source: string;
  notes: string;
}

const KNOWN_MARKETPLACES: Marketplace[] = [
  {
    id: "ecc",
    label: "ECC (Everything Claude Code)",
    source: "/plugin marketplace add affaan-m/ECC",
    notes: "USER's primary stack — skills, agents, hooks, mcps in one bundle.",
  },
  {
    id: "anthropics-skills",
    label: "Anthropic official skills",
    source: "/plugin marketplace add anthropics/claude-code-skills",
    notes: "Reference skills published by Anthropic (skill-creator, etc).",
  },
  {
    id: "wshobson-agents",
    label: "wshobson/agents",
    source: "/plugin marketplace add wshobson/agents",
    notes: "Community-curated agent collection (high-volume, varied quality).",
  },
  {
    id: "superpowers",
    label: "Superpowers",
    source: "/plugin marketplace add obra/superpowers-marketplace",
    notes: "Disciplined-execution skill bundle (writing-plans, TDD, debugging).",
  },
];

export function PluginsSection({ onNavigate }: Props) {
  const [plugins, setPlugins] = useState<PluginEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    invoke<PluginEntry[]>("list_all_plugins")
      .then(setPlugins)
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    } catch (e) {
      setErr(`Clipboard copy failed: ${String(e)}`);
    }
  }

  async function uninstall(p: PluginEntry) {
    const ok = await confirmDialog(
      `Delete the cache for ${p.coordinate}?\n\n` +
        `Removes ${p.root}.\n\n` +
        "Claude Code will not see this plugin's skills/agents until you " +
        "reinstall with /plugin install " +
        p.coordinate +
        ". The plugin's marketplace registration is untouched.",
      { title: "Uninstall plugin", kind: "warning" },
    );
    if (!ok) return;
    setBusy(p.coordinate);
    setErr(null);
    setRemoved(null);
    try {
      await invoke("uninstall_plugin_cache", {
        name: p.name,
        marketplace: p.marketplace,
      });
      setRemoved(p.coordinate);
      window.setTimeout(() => setRemoved((r) => (r === p.coordinate ? null : r)), 2500);
      load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

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
  if (!plugins) {
    return (
      <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Loading installed plugins…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Installed plugins list */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[14px] font-semibold">Installed plugins</h2>
          <button
            type="button"
            onClick={load}
            className="text-[11px] transition-colors"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Refresh
          </button>
        </div>
        <p
          className="mb-3 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Read from{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            ~/.claude/plugins/cache/&lt;marketplace&gt;/&lt;plugin&gt;/&lt;version&gt;/
          </span>
          . Counts reflect the most recently installed version on disk; the
          "active" badge means the plugin is also referenced in{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            installed_plugins.json
          </span>
          .
        </p>

        {removed && (
          <div
            className="mb-3 rounded p-2 text-[11.5px]"
            style={{
              background: "rgba(63, 185, 80, 0.06)",
              border: "1px solid rgba(63, 185, 80, 0.22)",
              color: "var(--color-success)",
            }}
          >
            Removed cache for {removed}.
          </div>
        )}

        {plugins.length === 0 ? (
          <div
            className="rounded p-4 text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No plugins found in the cache. Install one from a marketplace
            below via Claude Code.
          </div>
        ) : (
          <div
            className="overflow-hidden rounded"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            {plugins.map((p, i) => {
              const counts: { label: string; n: number; tab: string }[] = [
                { label: "skills", n: p.skills_count, tab: "skills" },
                { label: "agents", n: p.agents_count, tab: "agents" },
                { label: "hooks", n: p.hooks_count, tab: "hooks" },
                { label: "mcp", n: p.mcp_servers_count, tab: "mcps" },
              ];
              const installCmd = `/plugin install ${p.coordinate}`;
              return (
                <div
                  key={p.coordinate}
                  className="px-3 py-3"
                  style={{
                    borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
                  }}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span
                      className="text-[13px] font-semibold"
                      style={{ color: "var(--color-text)" }}
                    >
                      {p.name}
                    </span>
                    <span
                      className="rounded px-1.5 py-px text-[10px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      v{p.version}
                    </span>
                    <span
                      className="text-[11px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      @{p.marketplace}
                    </span>
                    {p.installed ? (
                      <span
                        className="rounded px-1.5 py-px text-[9.5px] uppercase tracking-wide"
                        style={{
                          background: "rgba(63, 185, 80, 0.08)",
                          color: "var(--color-success)",
                          border: "1px solid rgba(63, 185, 80, 0.22)",
                        }}
                      >
                        active
                      </span>
                    ) : (
                      <span
                        className="rounded px-1.5 py-px text-[9.5px] uppercase tracking-wide"
                        style={{
                          background: "var(--color-surface-1)",
                          color: "var(--color-text-tertiary)",
                          border: "1px solid var(--color-border)",
                        }}
                      >
                        cached
                      </span>
                    )}
                    {p.last_update_iso && (
                      <span
                        className="text-[10.5px]"
                        style={{ color: "var(--color-text-faint)" }}
                      >
                        updated {p.last_update_iso.slice(0, 10)}
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-1 truncate text-[10.5px]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-faint)",
                    }}
                    title={p.root}
                  >
                    {p.root}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {counts.map((c) => (
                      <button
                        key={c.label}
                        type="button"
                        onClick={() => onNavigate?.(c.tab)}
                        className="rounded px-2 py-0.5 text-[11px] transition-colors"
                        style={{
                          background: "var(--color-surface-1)",
                          color:
                            c.n > 0
                              ? "var(--color-text)"
                              : "var(--color-text-faint)",
                          border: "1px solid var(--color-border)",
                          cursor: onNavigate ? "pointer" : "default",
                          fontFamily: "var(--font-mono)",
                        }}
                        title={
                          onNavigate
                            ? `Jump to the ${c.label} tab`
                            : c.label
                        }
                      >
                        {c.n} {c.label}
                      </button>
                    ))}
                    <span className="grow" />
                    <button
                      type="button"
                      onClick={() => copy(installCmd, `update:${p.coordinate}`)}
                      className="rounded px-2.5 py-1 text-[11px] transition-colors"
                      style={{
                        background: "var(--color-surface-1)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                      title="Copy /plugin install <coord> for re-install / update"
                    >
                      {copied === `update:${p.coordinate}`
                        ? "Copied"
                        : "Update / reinstall"}
                    </button>
                    <button
                      type="button"
                      onClick={() => uninstall(p)}
                      disabled={busy === p.coordinate}
                      className="rounded px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40"
                      style={{
                        background: "transparent",
                        color: "var(--color-danger)",
                        border: "1px solid rgba(248, 81, 73, 0.32)",
                      }}
                      title="Delete the plugin's cache directory"
                    >
                      {busy === p.coordinate ? "Removing…" : "Uninstall"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Browse marketplaces */}
      <section>
        <h2 className="text-[14px] font-semibold">Browse marketplaces</h2>
        <p
          className="mt-1 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Click "Copy" on any entry and paste the command into Claude Code to
          add the marketplace. Once added, run{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            /plugin install &lt;name&gt;@&lt;marketplace&gt;
          </span>{" "}
          to install individual plugins.
        </p>
        <div
          className="mt-3 overflow-hidden rounded"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          {KNOWN_MARKETPLACES.map((m, i) => (
            <div
              key={m.id}
              className="flex flex-wrap items-center gap-3 px-3 py-3"
              style={{
                borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
              }}
            >
              <div className="min-w-0 flex-1">
                <div
                  className="text-[12.5px] font-semibold"
                  style={{ color: "var(--color-text)" }}
                >
                  {m.label}
                </div>
                <div
                  className="mt-0.5 text-[11px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {m.notes}
                </div>
                <div
                  className="mt-1 truncate text-[10.5px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-faint)",
                  }}
                  title={m.source}
                >
                  {m.source}
                </div>
              </div>
              <button
                type="button"
                onClick={() => copy(m.source, `market:${m.id}`)}
                className="shrink-0 rounded px-2.5 py-1 text-[11px] transition-colors"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {copied === `market:${m.id}` ? "Copied" : "Copy"}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default PluginsSection;
