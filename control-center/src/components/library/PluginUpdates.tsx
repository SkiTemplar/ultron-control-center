// PluginUpdates — Library "updates" sub-tab that surfaces the plugin
// update-check commands registered in the Tauri backend (v2.9.5).
//
// WIRED: rendered as the "updates" sub-tab of the Library tab (Download icon,
// between "plugins" and "hooks") since commit 21fc0ef. This panel is live, not
// a stub.
//
// Commands consumed (all async):
//   - plugin_check_updates_bulk(force: bool) → PluginBulkUpdate[]
//   - plugin_changelog_summary(coordinate: string, installed_sha?: string) → string
//
// The component is intentionally standalone (no props).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  Download,
  Folder,
  Loader,
  Sparkles,
} from "./icons";

// ---------------------------------------------------------------------------
// Types — mirror the Rust structs exactly
// ---------------------------------------------------------------------------

/** Mirrors `plugins_info::PluginBulkUpdate` */
interface PluginBulkUpdate {
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
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function shortSha(sha: string | null): string {
  if (!sha || sha.length === 0) return "—";
  return sha.slice(0, 8);
}

function formatDate(iso: string): string {
  if (!iso || iso.length === 0) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Sub-component: changelog drawer for a single plugin
// ---------------------------------------------------------------------------

interface ChangelogDrawerProps {
  coordinate: string;
  installed_sha: string | null;
  onClose: () => void;
}

function ChangelogDrawer({
  coordinate,
  installed_sha,
  onClose,
}: ChangelogDrawerProps) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSummary(null);

    const params: { coordinate: string; installed_sha?: string } = {
      coordinate,
    };
    if (installed_sha && installed_sha.length > 0) {
      params.installed_sha = installed_sha;
    }

    invoke<string>("plugin_changelog_summary", params)
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [coordinate, installed_sha]);

  return (
    <div
      className="rounded-md p-4"
      style={{
        border: "1px solid var(--color-border-strong)",
        background: "var(--color-surface-1)",
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles size={13} />
          <span className="text-[12px] font-semibold">
            Changelog — {coordinate}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-0.5 text-[11px]"
          style={{
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border-strong)",
            background: "var(--color-surface-2)",
          }}
        >
          Close
        </button>
      </div>

      {loading && (
        <div
          className="flex items-center gap-1.5 text-[12px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <Loader size={12} className="animate-spin" />
          Generating summary…
        </div>
      )}

      {error && (
        <div
          className="rounded p-2 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {summary && (
        <pre
          className="whitespace-pre-wrap text-[12px] leading-relaxed"
          style={{
            color: "var(--color-text-secondary)",
            fontFamily: "inherit",
          }}
        >
          {summary}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

type BadgeKind = "update" | "uptodate" | "unknown";

function badge(kind: BadgeKind) {
  if (kind === "update") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
        style={{
          background: "rgba(255, 166, 0, 0.15)",
          color: "#ffa600",
          border: "1px solid rgba(255, 166, 0, 0.35)",
        }}
      >
        <Download size={10} />
        Update available
      </span>
    );
  }
  if (kind === "uptodate") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
        style={{
          background: "rgba(35, 197, 94, 0.12)",
          color: "#23c55e",
          border: "1px solid rgba(35, 197, 94, 0.30)",
        }}
      >
        <Check size={10} />
        Up to date
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={{
        background: "rgba(128, 128, 128, 0.10)",
        color: "var(--color-text-tertiary)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      <AlertTriangle size={10} />
      Unknown
    </span>
  );
}

function rowBadge(item: PluginBulkUpdate): BadgeKind {
  if (item.error) return "unknown";
  return item.update_available ? "update" : "uptodate";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PluginUpdates() {
  const [items, setItems] = useState<PluginBulkUpdate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openChangelog, setOpenChangelog] = useState<string | null>(null);

  const fetchUpdates = useCallback(async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<PluginBulkUpdate[]>(
        "plugin_check_updates_bulk",
        { force },
      );
      setItems(result);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load from cache on mount (force = false)
  useEffect(() => {
    void fetchUpdates(false);
  }, [fetchUpdates]);

  const updatesAvailable = items.filter((i) => i.update_available).length;
  const unknownCount = items.filter((i) => !!i.error).length;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Plugin Updates</h2>
          {!loading && items.length > 0 && (
            <span
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {updatesAvailable > 0
                ? `${updatesAvailable} update${updatesAvailable !== 1 ? "s" : ""} available`
                : "All plugins up to date"}
              {unknownCount > 0 && ` · ${unknownCount} unknown`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchUpdates(false)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              opacity: loading ? 0.5 : 1,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading && <Loader size={11} className="animate-spin" />}
            Refresh (cached)
          </button>
          <button
            type="button"
            onClick={() => void fetchUpdates(true)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              opacity: loading ? 0.5 : 1,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading && <Loader size={11} className="animate-spin" />}
            Check for updates
          </button>
        </div>
      </header>

      {/* Top-level error */}
      {error && (
        <div
          className="rounded-md p-3 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && items.length === 0 && (
        <div
          className="flex flex-1 items-center justify-center gap-2 text-sm"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <Loader size={14} className="animate-spin" />
          Checking updates from GitHub…
        </div>
      )}

      {/* Empty state */}
      {!loading && items.length === 0 && !error && (
        <div
          className="flex flex-1 items-center justify-center text-sm"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          No plugins found in ~/.claude/plugins/cache/
        </div>
      )}

      {/* Plugin list */}
      {items.length > 0 && (
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
          {items.map((item) => {
            const kind = rowBadge(item);
            const isChangelogOpen = openChangelog === item.coordinate;

            return (
              <div
                key={item.coordinate}
                className="rounded-md"
                style={{
                  border: `1px solid ${
                    item.update_available
                      ? "rgba(255, 166, 0, 0.25)"
                      : "var(--color-border-strong)"
                  }`,
                  background: "var(--color-surface-2)",
                }}
              >
                {/* Main row */}
                <div className="flex items-start gap-3 p-3">
                  <Folder
                    size={14}
                    className="mt-0.5 shrink-0"
                  />

                  {/* Plugin identity */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold">
                        {item.name}
                      </span>
                      <span
                        className="text-[11px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        {item.marketplace}
                      </span>
                      {badge(kind)}
                    </div>

                    {/* SHA row */}
                    <div
                      className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      <span>
                        Installed:{" "}
                        <code
                          className="rounded px-1"
                          style={{
                            fontFamily: "var(--font-mono)",
                            background: "var(--color-surface-3)",
                            color: "var(--color-text)",
                          }}
                        >
                          {shortSha(item.installed_sha)}
                        </code>
                      </span>
                      <span>
                        Latest:{" "}
                        <code
                          className="rounded px-1"
                          style={{
                            fontFamily: "var(--font-mono)",
                            background: "var(--color-surface-3)",
                            color: "var(--color-text)",
                          }}
                        >
                          {shortSha(item.latest_sha)}
                        </code>
                      </span>
                      {item.latest_commit_date && (
                        <span>
                          Remote commit:{" "}
                          {formatDate(item.latest_commit_date)}
                        </span>
                      )}
                      {item.last_check && (
                        <span>
                          Checked:{" "}
                          {formatDate(item.last_check)}
                        </span>
                      )}
                    </div>

                    {/* Latest commit message */}
                    {item.latest_commit_msg && (
                      <div
                        className="mt-1 truncate text-[11.5px]"
                        style={{ color: "var(--color-text-secondary)" }}
                        title={item.latest_commit_msg}
                      >
                        {item.latest_commit_msg}
                      </div>
                    )}

                    {/* Per-row error */}
                    {item.error && (
                      <div
                        className="mt-1 text-[11px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                        title={item.error}
                      >
                        <AlertTriangle
                          size={10}
                          className="mr-1 inline-block"
                        />
                        {item.error}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <button
                    type="button"
                    onClick={() =>
                      setOpenChangelog(isChangelogOpen ? null : item.coordinate)
                    }
                    className="inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[11px]"
                    style={{
                      borderColor: "var(--color-border-strong)",
                      background: isChangelogOpen
                        ? "var(--color-surface-4)"
                        : "var(--color-surface-3)",
                      color: "var(--color-text)",
                    }}
                  >
                    <Sparkles size={11} />
                    Changelog
                  </button>
                </div>

                {/* Expandable changelog drawer */}
                {isChangelogOpen && (
                  <div className="border-t px-3 pb-3 pt-2" style={{ borderColor: "var(--color-border)" }}>
                    <ChangelogDrawer
                      coordinate={item.coordinate}
                      installed_sha={item.installed_sha}
                      onClose={() => setOpenChangelog(null)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer: last check timestamp from first item */}
      {items.length > 0 && items[0].last_check && (
        <p
          className="shrink-0 text-right text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          Results cached · last fetched{" "}
          {formatDate(items[0].last_check)}
          {" · "}
          "Check for updates" bypasses the 1-hour cache
        </p>
      )}
    </div>
  );
}

export default PluginUpdates;
