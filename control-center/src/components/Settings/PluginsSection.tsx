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
// v2.6 fb-022:
//   - 3-column grid (was 2): the cards are wide enough that 3 fit cleanly.
//   - Action buttons are width-fit so they don't stretch across the card.
//   - New toolbar button "Search for updates" → check_plugin_updates calls
//     `gh repo view --json pushedAt` for each marketplace and we badge any
//     plugin whose remote push timestamp is newer than the local cache.
//   - Live "Update available" badges on the card header. Clicking the Update
//     button still copies `/plugin install <coord>` to the clipboard so the
//     user can paste into Claude Code.

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

type PluginUpdateStatus = {
  name: string;
  marketplace: string;
  coordinate: string;
  local_iso: string | null;
  remote_pushed_iso: string | null;
  update_available: boolean;
  error: string | null;
};

// v2.6 (fb-016): "Browse marketplaces" section removed at the user's
// request — the list of curated marketplaces wasn't going to be used and
// just added vertical noise below the installed plugins grid.

export function PluginsSection({ onNavigate }: Props) {
  const [plugins, setPlugins] = useState<PluginEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  // v2.6 fb-022 — per-coordinate update status (keyed by `<plugin>@<market>`).
  const [updates, setUpdates] = useState<Record<string, PluginUpdateStatus>>({});
  const [checking, setChecking] = useState(false);
  const [checkSummary, setCheckSummary] = useState<string | null>(null);

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

  async function checkForUpdates() {
    setChecking(true);
    setCheckSummary(null);
    setErr(null);
    try {
      const rows = await invoke<PluginUpdateStatus[]>("check_plugin_updates");
      const next: Record<string, PluginUpdateStatus> = {};
      for (const r of rows) {
        next[r.coordinate] = r;
      }
      setUpdates(next);
      const availableCount = rows.filter((r) => r.update_available).length;
      const errorCount = rows.filter((r) => r.error).length;
      setCheckSummary(
        `${availableCount} update${availableCount === 1 ? "" : "s"} available` +
          (errorCount > 0 ? ` · ${errorCount} could not be checked` : ""),
      );
      window.setTimeout(() => setCheckSummary(null), 6000);
    } catch (e) {
      setErr(String(e));
    } finally {
      setChecking(false);
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
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold">Installed plugins</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={checkForUpdates}
              disabled={checking}
              className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11.5px] transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              title="Ask GitHub (via gh) whether any plugin marketplace has been pushed since the local cache was written."
            >
              {checking && (
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 animate-spin rounded-full"
                  style={{
                    border: "1.5px solid var(--color-border-strong)",
                    borderTopColor: "var(--color-accent)",
                  }}
                />
              )}
              {checking ? "Checking…" : "Search for updates"}
            </button>
            <button
              type="button"
              onClick={load}
              className="text-[11.5px] transition-colors"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Refresh
            </button>
          </div>
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

        {checkSummary && (
          <div
            className="mb-3 rounded p-2 text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            {checkSummary}
          </div>
        )}

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
          <div className="grid grid-cols-3 gap-3">
            {plugins.map((p) => {
              // Hooks live inside System; skills+agents live under Library.
              const counts: { label: string; n: number; tab: string }[] = [
                { label: "skills", n: p.skills_count, tab: "library" },
                { label: "agents", n: p.agents_count, tab: "library" },
                { label: "hooks", n: p.hooks_count, tab: "system" },
                { label: "mcp", n: p.mcp_servers_count, tab: "mcps" },
              ];
              const installCmd = `/plugin install ${p.coordinate}`;
              const update = updates[p.coordinate];
              return (
                <div
                  key={p.coordinate}
                  className="flex flex-col gap-2 rounded p-3"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  {/* Header row */}
                  <div className="flex flex-wrap items-baseline gap-1.5">
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
                      className="text-[10.5px]"
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
                    {update?.update_available && (
                      <span
                        className="rounded px-1.5 py-px text-[9.5px] uppercase tracking-wide"
                        style={{
                          background: "rgba(56, 139, 253, 0.14)",
                          color: "#79b8ff",
                          border: "1px solid rgba(56, 139, 253, 0.40)",
                        }}
                        title={
                          update.remote_pushed_iso
                            ? `Remote push: ${update.remote_pushed_iso}`
                            : "Update available"
                        }
                      >
                        Update available
                      </span>
                    )}
                    {p.last_update_iso && (
                      <span
                        className="text-[10px]"
                        style={{ color: "var(--color-text-faint)" }}
                      >
                        {p.last_update_iso.slice(0, 10)}
                      </span>
                    )}
                    {(() => {
                      if (!p.last_update_iso) return null;
                      const updated = new Date(p.last_update_iso).getTime();
                      if (Number.isNaN(updated)) return null;
                      const ageDays = (Date.now() - updated) / (1000 * 60 * 60 * 24);
                      if (ageDays < 30) return null;
                      return (
                        <span
                          className="rounded px-1.5 py-px text-[9.5px] uppercase tracking-wide"
                          style={{
                            background: "rgba(210, 153, 34, 0.12)",
                            color: "var(--color-warn)",
                            border: "1px solid rgba(210, 153, 34, 0.30)",
                          }}
                          title={`Cached for ${Math.round(ageDays)} days`}
                        >
                          {ageDays > 90 ? "stale" : "old"}
                        </span>
                      );
                    })()}
                  </div>

                  {/* Path */}
                  <div
                    className="truncate text-[10px]"
                    style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
                    title={p.root}
                  >
                    {p.root}
                  </div>

                  {/* Count shortcut buttons */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {counts.map((c) => (
                      <button
                        key={c.label}
                        type="button"
                        onClick={() => onNavigate?.(c.tab)}
                        className="rounded px-2 py-0.5 text-[10.5px] transition-colors"
                        style={{
                          background: "var(--color-surface-1)",
                          color: c.n > 0 ? "var(--color-text)" : "var(--color-text-faint)",
                          border: "1px solid var(--color-border)",
                          cursor: onNavigate ? "pointer" : "default",
                          fontFamily: "var(--font-mono)",
                        }}
                        title={onNavigate ? `Jump to ${c.label}` : c.label}
                      >
                        {c.n} {c.label}
                      </button>
                    ))}
                  </div>

                  {/* Action buttons — width-fit so they don't stretch across
                      the (wide) card. Per fb-022 the buttons hugged the full
                      card width and looked oversized; w-fit keeps them
                      proportional and aligned to the left. */}
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => copy(installCmd, `update:${p.coordinate}`)}
                      className="w-fit max-w-[120px] rounded px-2.5 py-1 text-[11.5px] transition-colors"
                      style={{
                        background: update?.update_available
                          ? "rgba(56, 139, 253, 0.14)"
                          : "var(--color-surface-1)",
                        color: update?.update_available ? "#79b8ff" : "var(--color-text)",
                        border: update?.update_available
                          ? "1px solid rgba(56, 139, 253, 0.40)"
                          : "1px solid var(--color-border-strong)",
                      }}
                      title={
                        update?.update_available
                          ? "Copy /plugin install command — remote is newer than your cache."
                          : "Copy /plugin install command"
                      }
                    >
                      {copied === `update:${p.coordinate}`
                        ? "Copied"
                        : update?.update_available
                          ? "Update"
                          : "Update / reinstall"}
                    </button>
                    <button
                      type="button"
                      onClick={() => uninstall(p)}
                      disabled={busy === p.coordinate}
                      className="w-fit max-w-[120px] rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40"
                      style={{
                        background: "transparent",
                        color: "var(--color-danger)",
                        border: "1px solid rgba(248, 81, 73, 0.32)",
                      }}
                      title="Delete the plugin's cache directory"
                    >
                      {busy === p.coordinate ? "Removing…" : "Uninstall"}
                    </button>
                    {update?.error && !update.update_available && (
                      <span
                        className="text-[10px]"
                        style={{ color: "var(--color-text-faint)" }}
                        title={update.error}
                      >
                        Update check failed
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export default PluginsSection;
