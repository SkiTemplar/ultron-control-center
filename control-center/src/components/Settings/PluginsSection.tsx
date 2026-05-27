// Plugins panel — v2.9.5 SHA-aware update system.
//
// Previous versions (v2.6 fb-022) detected updates by comparing the
// marketplace repo's `pushedAt` timestamp against the local cache mtime,
// which fired false positives whenever any file in the marketplace changed
// (even unrelated plugins).
//
// v2.9.5 improvements:
//   - Calls `plugin_check_updates_bulk` which compares the `gitCommitSha`
//     from `installed_plugins.json` against the HEAD commit of the plugin's
//     specific sub-path in the upstream repo. Plugins without a stored SHA
//     fall back to ISO timestamp comparison.
//   - Results are cached 1 h on disk so the panel doesn't hammer the
//     GitHub API on every open.
//   - Each card has an expandable "Changelog" section that streams an AI
//     summary (via `plugin_changelog_summary`) from Haiku / Gemini Flash.
//   - "Update all" button in the header copies all outstanding update
//     commands to the clipboard as a newline-separated list.
//   - "Check updates" button in the header accepts a `force` flag to bypass
//     the cache.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../../lib/dialog";

// ---------------------------------------------------------------------------
// Types (mirror Rust structs)
// ---------------------------------------------------------------------------

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

/** Rich update record from `plugin_check_updates_bulk`. */
type PluginBulkUpdate = {
  coordinate: string;
  name: string;
  marketplace: string;
  installed_sha: string | null;
  latest_sha: string | null;
  update_available: boolean;
  latest_commit_msg: string;
  latest_commit_date: string;
  last_check: string;
  error: string | null;
};

type Props = {
  onNavigate?: (tab: string) => void;
};

// ---------------------------------------------------------------------------
// Helper: short SHA display
// ---------------------------------------------------------------------------

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "";
  return sha.slice(0, 8);
}

// ---------------------------------------------------------------------------
// ChangelogPanel — lazy-loaded per-plugin changelog summary
// ---------------------------------------------------------------------------

type ChangelogPanelProps = {
  coordinate: string;
  installedSha: string | null;
};

function ChangelogPanel({ coordinate, installedSha }: ChangelogPanelProps) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Abort ref: if the user closes and reopens quickly we cancel the in-flight
  // invoke by ignoring stale responses.
  const activeCoord = useRef<string>(coordinate);

  useEffect(() => {
    activeCoord.current = coordinate;
    setLoading(true);
    setSummary(null);
    setErr(null);

    invoke<string>("plugin_changelog_summary", {
      coordinate,
      installedSha,
    })
      .then((text) => {
        if (activeCoord.current !== coordinate) return;
        setSummary(text);
      })
      .catch((e) => {
        if (activeCoord.current !== coordinate) return;
        setErr(String(e));
      })
      .finally(() => {
        if (activeCoord.current === coordinate) setLoading(false);
      });
  }, [coordinate, installedSha]);

  if (loading) {
    return (
      <div
        className="mt-2 rounded p-2 text-[11px]"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-tertiary)",
        }}
      >
        <span
          aria-hidden
          className="mr-1.5 inline-block h-2.5 w-2.5 animate-spin rounded-full align-middle"
          style={{
            border: "1.5px solid var(--color-border-strong)",
            borderTopColor: "var(--color-accent)",
          }}
        />
        Loading changelog…
      </div>
    );
  }

  if (err) {
    return (
      <div
        className="mt-2 rounded p-2 text-[11px]"
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

  if (!summary) return null;

  return (
    <div
      className="mt-2 rounded p-2 text-[11px] leading-relaxed"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
        color: "var(--color-text-secondary)",
        whiteSpace: "pre-wrap",
        fontFamily: "var(--font-mono)",
      }}
    >
      {summary}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PluginsSection({ onNavigate }: Props) {
  const [plugins, setPlugins] = useState<PluginEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);

  // SHA-aware update state (v2.9.5)
  const [updates, setUpdates] = useState<Record<string, PluginBulkUpdate>>({});
  const [checking, setChecking] = useState(false);
  const [checkSummary, setCheckSummary] = useState<string | null>(null);
  const [checkErr, setCheckErr] = useState<string | null>(null);

  // Per-card expanded changelog panels
  const [expandedChangelog, setExpandedChangelog] = useState<string | null>(null);

  // "Update all" state
  const [copiedAll, setCopiedAll] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    invoke<PluginEntry[]>("list_all_plugins")
      .then(setPlugins)
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-check on mount using cached results (force=false) — silent, no
  // spinner so the panel doesn't feel heavy on every open.
  useEffect(() => {
    invoke<PluginBulkUpdate[]>("plugin_check_updates_bulk", { force: false })
      .then((rows) => {
        const next: Record<string, PluginBulkUpdate> = {};
        for (const r of rows) next[r.coordinate] = r;
        setUpdates(next);
      })
      .catch(() => {
        // Silent auto-check failure — user can retry manually.
      });
  }, []);

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

  /** Force-refresh from GitHub, bypassing the 1-hour cache. */
  async function checkForUpdates() {
    setChecking(true);
    setCheckSummary(null);
    setCheckErr(null);
    try {
      const rows = await invoke<PluginBulkUpdate[]>("plugin_check_updates_bulk", {
        force: true,
      });
      const next: Record<string, PluginBulkUpdate> = {};
      for (const r of rows) next[r.coordinate] = r;
      setUpdates(next);

      const available = rows.filter((r) => r.update_available).length;
      const errors = rows.filter((r) => r.error && !r.update_available).length;
      setCheckSummary(
        `${available} update${available === 1 ? "" : "s"} available` +
          (errors > 0 ? ` · ${errors} could not be checked` : ""),
      );
      window.setTimeout(() => setCheckSummary(null), 8000);
    } catch (e) {
      setCheckErr(String(e));
    } finally {
      setChecking(false);
    }
  }

  /** Copy `/plugin install <coord>` for every plugin with an update. */
  async function updateAll() {
    const cmds = (plugins ?? [])
      .filter((p) => updates[p.coordinate]?.update_available)
      .map((p) => `/plugin install ${p.coordinate}`)
      .join("\n");
    if (!cmds) return;
    try {
      await navigator.clipboard.writeText(cmds);
      setCopiedAll(true);
      window.setTimeout(() => setCopiedAll(false), 2000);
    } catch (e) {
      setErr(`Clipboard copy failed: ${String(e)}`);
    }
  }

  const updatesAvailableCount = (plugins ?? []).filter(
    (p) => updates[p.coordinate]?.update_available,
  ).length;

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
        <button
          type="button"
          className="ml-3 underline"
          onClick={() => { setErr(null); load(); }}
        >
          Retry
        </button>
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
      <section>
        {/* ---- Header row ---- */}
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold">Installed plugins</h2>

          <div className="flex flex-wrap items-center gap-2">
            {/* Update all */}
            {updatesAvailableCount > 0 && (
              <button
                type="button"
                onClick={updateAll}
                className="inline-flex items-center gap-1.5 rounded px-2.5 py-0.5 text-[11.5px] transition-colors"
                style={{
                  background: "rgba(56, 139, 253, 0.14)",
                  color: "#79b8ff",
                  border: "1px solid rgba(56, 139, 253, 0.40)",
                }}
                title={`Copy /plugin install commands for all ${updatesAvailableCount} available updates`}
              >
                {copiedAll
                  ? "Copied!"
                  : `Update all (${updatesAvailableCount})`}
              </button>
            )}

            {/* Check updates */}
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
              title="Compare installed SHAs against upstream commits via gh API. Results cached 1 h."
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
              {checking ? "Checking…" : "Check updates"}
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

        {/* Description */}
        <p
          className="mb-3 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Read from{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            ~/.claude/plugins/cache/&lt;marketplace&gt;/&lt;plugin&gt;/&lt;version&gt;/
          </span>
          . Update detection uses the{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>gitCommitSha</span>{" "}
          from{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>installed_plugins.json</span>
          {" "}compared against the upstream commit at the plugin's path. Results
          are cached 1 h.
        </p>

        {/* Banners */}
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

        {checkErr && (
          <div
            className="mb-3 rounded p-2 text-[11.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            Update check failed: {checkErr}
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

        {/* Empty state */}
        {plugins.length === 0 ? (
          <div
            className="rounded p-4 text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No plugins found in the cache. Install one via{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>/plugin install</span>{" "}
            inside Claude Code.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {plugins.map((p) => {
              const counts: { label: string; n: number; tab: string }[] = [
                { label: "skills", n: p.skills_count, tab: "library" },
                { label: "agents", n: p.agents_count, tab: "library" },
                { label: "hooks", n: p.hooks_count, tab: "system" },
                { label: "mcp", n: p.mcp_servers_count, tab: "mcps" },
              ];
              const installCmd = `/plugin install ${p.coordinate}`;
              const update = updates[p.coordinate];
              const hasUpdate = update?.update_available === true;
              const isExpanded = expandedChangelog === p.coordinate;

              return (
                <div
                  key={p.coordinate}
                  className="flex flex-col gap-2 rounded p-3"
                  style={{
                    background: "var(--color-surface-2)",
                    border: hasUpdate
                      ? "1px solid rgba(56, 139, 253, 0.40)"
                      : "1px solid var(--color-border)",
                  }}
                >
                  {/* ---- Card header ---- */}
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

                    {/* Active / cached badge */}
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

                    {/* Update available badge — red/blue pill */}
                    {hasUpdate && (
                      <span
                        className="rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide"
                        style={{
                          background: "rgba(248, 81, 73, 0.12)",
                          color: "#ff7b72",
                          border: "1px solid rgba(248, 81, 73, 0.40)",
                        }}
                        title={
                          update.latest_sha
                            ? `Installed: ${shortSha(update.installed_sha)} · Remote: ${shortSha(update.latest_sha)}`
                            : "Update available"
                        }
                      >
                        Update available
                      </span>
                    )}

                    {/* Stale/old warning (no confirmed update, just age) */}
                    {!hasUpdate && p.last_update_iso && (() => {
                      const ageDays =
                        (Date.now() - new Date(p.last_update_iso).getTime()) /
                        86_400_000;
                      if (ageDays < 30) return null;
                      return (
                        <span
                          key="age"
                          className="rounded px-1.5 py-px text-[9.5px] uppercase tracking-wide"
                          style={{
                            background: "rgba(210, 153, 34, 0.12)",
                            color: "var(--color-warn)",
                            border: "1px solid rgba(210, 153, 34, 0.30)",
                          }}
                          title={`Cached ${Math.round(ageDays)} days ago`}
                        >
                          {ageDays > 90 ? "stale" : "old"}
                        </span>
                      );
                    })()}

                    {/* Date */}
                    {p.last_update_iso && (
                      <span
                        className="text-[10px]"
                        style={{ color: "var(--color-text-faint)" }}
                      >
                        {p.last_update_iso.slice(0, 10)}
                      </span>
                    )}
                  </div>

                  {/* SHA diff row — visible only after a check */}
                  {update && (update.installed_sha || update.latest_sha) && (
                    <div
                      className="text-[10px]"
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: "var(--color-text-faint)",
                      }}
                    >
                      {update.installed_sha && (
                        <span title="Installed commit SHA">
                          local {shortSha(update.installed_sha)}
                        </span>
                      )}
                      {update.installed_sha && update.latest_sha && (
                        <span className="mx-1">→</span>
                      )}
                      {update.latest_sha && (
                        <span
                          title={
                            update.latest_commit_msg
                              ? `Latest: ${update.latest_commit_msg}`
                              : "Latest remote commit SHA"
                          }
                          style={{
                            color: hasUpdate ? "#79b8ff" : "var(--color-text-faint)",
                          }}
                        >
                          remote {shortSha(update.latest_sha)}
                        </span>
                      )}
                      {update.latest_commit_msg && (
                        <span
                          className="ml-2 truncate"
                          style={{ color: "var(--color-text-tertiary)" }}
                          title={update.latest_commit_msg}
                        >
                          — {update.latest_commit_msg.slice(0, 48)}
                          {update.latest_commit_msg.length > 48 ? "…" : ""}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Path */}
                  <div
                    className="truncate text-[10px]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-faint)",
                    }}
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
                          color:
                            c.n > 0
                              ? "var(--color-text)"
                              : "var(--color-text-faint)",
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

                  {/* Changelog panel (lazy) */}
                  {isExpanded && (
                    <ChangelogPanel
                      coordinate={p.coordinate}
                      installedSha={update?.installed_sha ?? null}
                    />
                  )}

                  {/* Action buttons */}
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    {/* Update / reinstall */}
                    <button
                      type="button"
                      onClick={() => copy(installCmd, `update:${p.coordinate}`)}
                      className="w-fit rounded px-2.5 py-1 text-[11.5px] transition-colors"
                      style={{
                        background: hasUpdate
                          ? "rgba(248, 81, 73, 0.12)"
                          : "var(--color-surface-1)",
                        color: hasUpdate ? "#ff7b72" : "var(--color-text)",
                        border: hasUpdate
                          ? "1px solid rgba(248, 81, 73, 0.40)"
                          : "1px solid var(--color-border-strong)",
                      }}
                      title={
                        hasUpdate
                          ? `Copy /plugin install ${p.coordinate} — update available`
                          : `Copy /plugin install ${p.coordinate}`
                      }
                    >
                      {copied === `update:${p.coordinate}`
                        ? "Copied!"
                        : hasUpdate
                          ? "Update"
                          : "Reinstall"}
                    </button>

                    {/* Changelog toggle */}
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedChangelog((prev) =>
                          prev === p.coordinate ? null : p.coordinate,
                        )
                      }
                      className="w-fit rounded px-2.5 py-1 text-[11.5px] transition-colors"
                      style={{
                        background: isExpanded
                          ? "var(--color-surface-3)"
                          : "var(--color-surface-1)",
                        color: "var(--color-text-secondary)",
                        border: "1px solid var(--color-border)",
                      }}
                      title="Show AI-generated changelog summary for recent upstream commits"
                    >
                      {isExpanded ? "Hide changelog" : "Changelog"}
                    </button>

                    {/* Uninstall */}
                    <button
                      type="button"
                      onClick={() => uninstall(p)}
                      disabled={busy === p.coordinate}
                      className="w-fit rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40"
                      style={{
                        background: "transparent",
                        color: "var(--color-danger)",
                        border: "1px solid rgba(248, 81, 73, 0.32)",
                      }}
                      title="Delete the plugin's cache directory"
                    >
                      {busy === p.coordinate ? "Removing…" : "Uninstall"}
                    </button>

                    {/* Update check error indicator */}
                    {update?.error && !hasUpdate && (
                      <span
                        className="text-[10px]"
                        style={{ color: "var(--color-text-faint)" }}
                        title={update.error}
                      >
                        Check failed
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
