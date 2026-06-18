import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AlertEntry } from "../types";
import { getUltronRoot } from "../lib/paths";
import { confirmDialog } from "../lib/dialog";
import { useRoutingTitle } from "../lib/button-prompts";

import type { SevKey, DateFilter, FixProvider, Props } from "./notifications/types";
import { severityStyle } from "./notifications/severity";
import { DATE_LABEL, passesDateFilter } from "./notifications/dateFilter";
import { getTs, dedupe } from "./notifications/dedupe";
import {
  loadDismissed,
  saveDismissed,
  loadSevFilters,
  saveSevFilters,
  loadDateFilter,
  saveDateFilter,
} from "./notifications/persistence";
import { Row } from "./notifications/Row";
import { Pill } from "./notifications/Pill";
import { buildBulkAlertsBlock } from "./notifications/buildBulkAlertsBlock";

export { buildBulkAlertsBlock };

export function Notifications({ alerts: alertsProp, onDeleted }: Props) {
  const alerts: AlertEntry[] = alertsProp ?? [];
  const [sevFilters, setSevFilters] = useState<Set<SevKey>>(() => loadSevFilters());
  const [dateFilter, setDateFilter] = useState<DateFilter>(() => loadDateFilter());
  // Client-side "I've already seen this" set. Used as an immediate visual
  // mask while the disk delete is in flight (and as a soft hide for
  // alerts the backend couldn't physically remove — e.g. malformed lines
  // whose fingerprint we can't reproduce). The authoritative source is
  // always `~/.ultron/alerts.jsonl`.
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
  const [deleting, setDeleting] = useState(false);
  // Bulk "Fix all" state. Lifted to the parent because the buttons live
  // in the global toolbar, not inside a Row. Mirrors the per-card flow:
  // {busy:provider} during spawn, {toast} on success, {error} on failure.
  const [bulkFixBusy, setBulkFixBusy] = useState<FixProvider | null>(null);
  const [bulkFixToast, setBulkFixToast] = useState<string | null>(null);
  const [bulkFixError, setBulkFixError] = useState<string | null>(null);
  // Routing fragment for the bulk Fix-all buttons (zone notif_fix). Provider
  // is forced by the button; the zone lends model/agent only.
  const bulkRouting = useRoutingTitle("notif.fix_all", "");

  useEffect(() => saveSevFilters(sevFilters), [sevFilters]);
  useEffect(() => saveDateFilter(dateFilter), [dateFilter]);
  useEffect(() => saveDismissed(dismissed), [dismissed]);

  // Stats per severity (after date filter, before dedupe — counts raw alerts).
  // A1 regression guard: skip null / non-object entries so getTs() never sees them.
  const dateFiltered = useMemo(
    () =>
      alerts.filter(
        (a) => a && typeof a === "object" && passesDateFilter(getTs(a), dateFilter),
      ),
    [alerts, dateFilter],
  );

  const sevCounts = useMemo(() => {
    let info = 0,
      warn = 0,
      crit = 0;
    for (const a of dateFiltered) {
      const w = severityStyle(a.severity).weight;
      if (w === 0) info++;
      else if (w === 1) warn++;
      else crit++;
    }
    return { info, warn, critical: crit };
  }, [dateFiltered]);

  const allGroups = useMemo(() => dedupe(dateFiltered), [dateFiltered]);

  // Compute group fingerprint the same way dedupe does so dismissed-set
  // lookups line up.
  const groupKey = (g: { source: string; message: string }) =>
    `${g.source}::${(g.message ?? "").trim().replace(/\s+/g, " ").slice(0, 80)}`;

  const visibleGroups = useMemo(
    () =>
      allGroups
        .filter((g) => sevFilters.has(severityStyle(g.severity).key))
        .filter((g) => !dismissed.has(groupKey(g)))
        .sort(
          (a, b) =>
            severityStyle(b.severity).weight - severityStyle(a.severity).weight ||
            b.count - a.count,
        ),
    [allGroups, sevFilters, dismissed],
  );

  const visibleTotal = visibleGroups.reduce((acc, g) => acc + (g.count ?? 0), 0);

  // "Actionable" = severity that the LLM can do something about.
  // Mirrors the per-row Row component, which only renders Fix buttons
  // when severityStyle.weight === 2 (critical/blocking). We also include
  // warn here because the user explicitly asked for warn in the mega-
  // prompt — bulk mode is more aggressive than per-row mode.
  const actionableGroups = useMemo(
    () =>
      visibleGroups.filter((g) => {
        const w = severityStyle(g.severity).weight;
        return w === 2 || w === 1;
      }),
    [visibleGroups],
  );

  async function openBulkFixSession(provider: FixProvider) {
    if (bulkFixBusy || actionableGroups.length === 0) return;
    setBulkFixBusy(provider);
    setBulkFixError(null);
    setBulkFixToast(null);
    try {
      // v15.2.40: prompt template lives in the central catalog
      // (key `notif.fix_all`, zone `notif_fix`). `buildBulkAlertsBlock`
      // is now just the variable body — header / footer come from the
      // editable template.
      const { getPrompt } = await import("../lib/button-prompts");
      const bulkBlock = buildBulkAlertsBlock(actionableGroups);
      const prompt = await getPrompt("notif.fix_all", { bulk_block: bulkBlock });
      // cwd = ~/.ultron so the spawned shell starts where the relevant
      // scripts, hooks, alerts.jsonl and logs live — diagnosing a system
      // alert from C:\Users\<user>\ has zero context.
      const cwd = await getUltronRoot().catch(() => null);
      // v2.0: no AI Router. Provider is the bulk Fix toggle's pick;
      // model/agent are the provider's defaults.
      await invoke("spawn_session", {
        provider,
        prompt,
        cwd,
        // paste_only mirrors the per-row Fix flow: the prompt lands on
        // the clipboard so the user controls when the session actually
        // starts answering.
        flags: { dangerouslySkipPermissions: false, pasteOnly: true },
      });
      setBulkFixToast(
        `Claude session opened — paste prompt with Ctrl+V to fix ${actionableGroups.length} issue${actionableGroups.length === 1 ? "" : "s"}`,
      );
      window.setTimeout(() => setBulkFixToast(null), 6000);
    } catch (e) {
      setBulkFixError(String(e));
    } finally {
      setBulkFixBusy(null);
    }
  }

  function toggleSev(key: SevKey) {
    const next = new Set(sevFilters);
    if (next.has(key)) {
      if (next.size > 1) next.delete(key);
    } else {
      next.add(key);
    }
    setSevFilters(next);
  }

  const dateFilters: DateFilter[] = ["1h", "24h", "7d", "all"];

  return (
    <div className="px-10 py-8">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold leading-tight">Notifications</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
          {visibleGroups.length} unique · {visibleTotal} total {DATE_LABEL[dateFilter].toLowerCase()}
        </p>
      </header>

      {/* Severity filters */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Pill
          label="Critical"
          color="var(--color-danger)"
          active={sevFilters.has("critical")}
          count={sevCounts.critical}
          onClick={() => toggleSev("critical")}
        />
        <Pill
          label="Warn"
          color="var(--color-warn)"
          active={sevFilters.has("warn")}
          count={sevCounts.warn}
          onClick={() => toggleSev("warn")}
        />
        <Pill
          label="Info"
          color="var(--color-text-tertiary)"
          active={sevFilters.has("info")}
          count={sevCounts.info}
          onClick={() => toggleSev("info")}
        />

        <div className="mx-2 h-4 w-px" style={{ background: "var(--color-border-strong)" }} />

        {/* Date filters */}
        {dateFilters.map((d) => (
          <Pill
            key={d}
            label={DATE_LABEL[d]}
            active={dateFilter === d}
            onClick={() => setDateFilter(d)}
          />
        ))}

        <div className="ml-auto flex items-center gap-2">
          {(() => {
            const infoVisible = visibleGroups.filter(
              (g) => severityStyle(g.severity).key === "info",
            );
            return (
              <button
                type="button"
                onClick={async () => {
                  if (infoVisible.length === 0 || deleting) return;
                  const fps = infoVisible.map((g) => groupKey(g));
                  // Optimistic hide so the row disappears before the
                  // backend round-trip finishes. The dismissed set is
                  // ignored for fingerprints that no longer exist on
                  // disk after the reload — they just stop showing up.
                  const masked = new Set(dismissed);
                  for (const fp of fps) masked.add(fp);
                  setDismissed(masked);
                  setDeleting(true);
                  try {
                    await invoke("delete_alert_entries", { fingerprints: fps });
                    if (onDeleted) {
                      await onDeleted();
                    } else {
                      // Fallback: parent didn't wire the callback, so we
                      // brute-force a fresh read of alerts.jsonl by
                      // reloading the webview. Ugly but correct.
                      window.location.reload();
                    }
                  } catch (e) {
                    // Roll back the optimistic mask on failure so the
                    // user can retry — the disk file is unchanged.
                    const rollback = new Set(dismissed);
                    setDismissed(rollback);
                    console.error("delete_alert_entries failed:", e);
                  } finally {
                    setDeleting(false);
                  }
                }}
                disabled={infoVisible.length === 0 || deleting}
                title="Permanently delete the visible info notifications from ~/.ultron/alerts.jsonl"
                className="text-[11.5px] transition-colors disabled:opacity-30"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {deleting ? "Deleting…" : `Delete info (${infoVisible.length})`}
              </button>
            );
          })()}
          {/* Clear all — wipes EVERY visible group (info + warn + critical).
              Same backend (delete_alert_entries) + same optimistic hide as
              Delete info, just no severity filter. Confirms first since
              critical alerts shouldn't disappear by accident. */}
          {visibleGroups.length > 0 && (
            <button
              type="button"
              onClick={async () => {
                if (deleting || visibleGroups.length === 0) return;
                const ok = await confirmDialog(
                  `Permanently delete ${visibleGroups.length} notification${visibleGroups.length === 1 ? "" : "s"} (including critical and warn)?`,
                  { title: "Clear all notifications", kind: "warning" },
                );
                if (!ok) return;
                const fps = visibleGroups.map((g) => groupKey(g));
                const masked = new Set(dismissed);
                for (const fp of fps) masked.add(fp);
                setDismissed(masked);
                setDeleting(true);
                try {
                  await invoke("delete_alert_entries", { fingerprints: fps });
                  if (onDeleted) {
                    await onDeleted();
                  } else {
                    window.location.reload();
                  }
                } catch (e) {
                  setDismissed(new Set(dismissed));
                  console.error("delete_alert_entries (all) failed:", e);
                } finally {
                  setDeleting(false);
                }
              }}
              disabled={deleting}
              title="Delete ALL visible notifications (info + warn + critical) from the alerts.jsonl file. Asks for confirmation first."
              className="text-[11.5px] transition-colors disabled:opacity-30"
              style={{ color: "var(--color-danger)" }}
            >
              {deleting ? "Deleting…" : `Clear all (${visibleGroups.length})`}
            </button>
          )}

          {/* Bulk "Fix all" button. Visible only when there is at least
              one actionable (critical/warn) group — otherwise we'd be
              spawning a session with nothing to fix. The button is
              deliberately larger than the surrounding pill controls
              (px-3 py-1 vs px-2.5 py-1) because it triggers an
              external process and we want it to feel weightier than
              the in-tab filters. */}
          {actionableGroups.length > 0 && (
            <>
              <div
                className="mx-1 h-4 w-px"
                style={{ background: "var(--color-border-strong)" }}
              />
              <button
                type="button"
                onClick={() => openBulkFixSession("claude")}
                disabled={bulkFixBusy !== null}
                title={`Spawn a Claude session pre-loaded with ALL ${actionableGroups.length} actionable notification${actionableGroups.length === 1 ? "" : "s"}. The mega-prompt lands on the clipboard — paste with Ctrl+V.${bulkRouting ? ` · ${bulkRouting}` : ""}`}
                className="rounded px-3 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {bulkFixBusy === "claude"
                  ? "Opening…"
                  : `Fix all with Claude (${actionableGroups.length})`}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Bulk-fix status line. Rendered outside the toolbar so wide
          success/error text doesn't push the buttons off-screen. */}
      {(bulkFixToast || bulkFixError) && (
        <div
          className="mb-3 text-[11.5px]"
          style={{
            color: bulkFixError ? "var(--color-danger)" : "var(--color-text-tertiary)",
          }}
          title={bulkFixError ?? undefined}
        >
          {bulkFixError
            ? `Failed to open bulk session: ${bulkFixError.slice(0, 160)}`
            : bulkFixToast}
        </div>
      )}

      {/* Empty state */}
      {visibleGroups.length === 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {alerts.length === 0
            ? "No notifications. System is quiet."
            : "No notifications match the current filters."}
        </div>
      )}

      <div className="space-y-2">
        {visibleGroups.map((g, i) => (
          <Row
            key={`${g.source}-${i}`}
            g={g}
            onDismiss={(fp) => {
              const next = new Set(dismissed);
              next.add(fp);
              setDismissed(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}
