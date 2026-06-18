import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  McpPingResult,
  McpMutationResult,
  SettingsSnapshot,
  SettingsSaveResult,
} from "../types";
import { useRoutingTitle } from "../lib/button-prompts";
import { notifyError } from "../lib/notify";
import { Card } from "./mcps/McpCard";
import { EnableDisableSection } from "./mcps/EnableDisableSection";
import { GenerateModal } from "./mcps/GenerateModal";
import { McpForm } from "./mcps/McpForm";
import { Modal } from "./mcps/Modal";
import type { EditableMcp, McpInfoExt } from "./mcps/types";
import {
  blankMcp,
  configToEditable,
  editableToConfig,
  parseOrigin,
  saveHidden,
  loadHidden,
  validateEditable,
} from "./mcps/utils";

// v2.5.2 (wave 2): EnableDisableSection is intentionally retained but no
// longer rendered. The per-card toggle in <Card> replaces it. Keep this
// reference so TS6133 (unused) doesn't fire and we can resurrect the
// section quickly if the user changes their mind.
/* eslint-disable @typescript-eslint/no-unused-vars */
const _keepEnableDisableSection = EnableDisableSection;
void _keepEnableDisableSection;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function MCPs() {
  const [mcps, setMcps] = useState<McpInfoExt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden());
  const [showHidden, setShowHidden] = useState(false);
  const [probing, setProbing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // P7: per-server ping results (Test button). Independent of the global
  // health check JSON because the spawn-and-initialize handshake is
  // far more reliable than reading mcp-health.json.
  const [pings, setPings] = useState<Record<string, McpPingResult>>({});
  const [pingBusy, setPingBusy] = useState<Set<string>>(new Set());
  // Per-card enable/disable state. Maps MCP name → enabled (true = not disabled).
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});
  const [toggleBusy, setToggleBusy] = useState<Set<string>>(new Set());

  async function testMcp(name: string) {
    setPingBusy((s) => {
      const next = new Set(s);
      next.add(name);
      return next;
    });
    try {
      const r = (await invoke("mcp_ping", { name })) as McpPingResult;
      setPings((p) => ({ ...p, [name]: r }));
    } catch (e) {
      setPings((p) => ({
        ...p,
        [name]: {
          name,
          ok: false,
          latency_ms: null,
          error: String(e),
        },
      }));
    } finally {
      setPingBusy((s) => {
        const next = new Set(s);
        next.delete(name);
        return next;
      });
    }
  }
  const addWithAiTitle = useRoutingTitle(
    "mcps.add_with_ai",
    "Register a new MCP server with AI. cwd=instructions/mcps/ with GUIDE.md auto-loaded.",
  );

  // Modal state
  const [addOpen, setAddOpen] = useState(false);
  const [addModel, setAddModel] = useState<EditableMcp>(blankMcp());
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editModel, setEditModel] = useState<EditableMcp>(blankMcp());
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [genOpen, setGenOpen] = useState(false);

  useEffect(() => saveHidden(hidden), [hidden]);

  // audit verify-audit-2 rank8: useCallback con deps [] para que el setInterval
  // del effect de abajo capture siempre la misma referencia y no se recree en
  // cada render. Las setters de useState son estables por garantía de React.
  const fetchList = useCallback(async () => {
    try {
      const list = (await invoke("list_mcps")) as McpInfoExt[];
      setMcps(list);
      setError(null);
      // Seed enabled/disabled state from the list itself: list_mcps marks
      // `disabled` both from settings.json mcpServers (user scope) AND from
      // Claude Code's `disabledMcpjsonServers` (project/.mcp.json scope), so
      // it's the single authoritative source — no separate settings read.
      const map: Record<string, boolean> = {};
      for (const m of list) map[m.name] = !m.disabled;
      setEnabledMap(map);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  async function toggleEnabled(name: string, origin?: string) {
    if (toggleBusy.has(name)) return;
    setToggleBusy((s) => { const n = new Set(s); n.add(name); return n; });
    try {
      const currentlyEnabled = enabledMap[name] !== false;
      const wantDisabled = currentlyEnabled; // toggling flips the state
      if (origin && origin.startsWith("project:")) {
        // Project / .mcp.json scope → Claude Code's own disabledMcpjsonServers
        // list in settings.json (the only switch that actually disables these).
        const res = (await invoke("mcp_set_disabled", {
          name,
          disabled: wantDisabled,
        })) as SettingsSaveResult;
        if (res.success) setEnabledMap((m) => ({ ...m, [name]: !wantDisabled }));
      } else {
        // User scope → settings.json mcpServers[name].disabled. If the server
        // isn't in settings.json (it lives in ~/.claude.json), say so honestly
        // instead of silently no-op'ing.
        const snap = (await invoke("settings_read")) as SettingsSnapshot;
        const next = JSON.parse(JSON.stringify(snap.content)) as Record<string, unknown>;
        const servers = (next.mcpServers ?? {}) as Record<string, { disabled?: boolean }>;
        const cfg = servers[name];
        if (!cfg) {
          showFlash(
            `'${name}' vive en ~/.claude.json (user scope); edítalo ahí para desactivarlo.`,
          );
          return;
        }
        cfg.disabled = !cfg.disabled;
        next.mcpServers = servers;
        const nowEnabled = !cfg.disabled; // cfg.disabled was just set to the new value
        const res = (await invoke("settings_save", { content: next })) as SettingsSaveResult;
        if (res.success) {
          setEnabledMap((m) => ({ ...m, [name]: nowEnabled }));
        }
      }
    } catch (e) {
      showFlash(`Toggle failed: ${e}`);
    } finally {
      setToggleBusy((s) => { const n = new Set(s); n.delete(name); return n; });
    }
  }

  // audit verify-audit-2 rank8: useCallback con deps [] — referencia estable
  // para el botón "Check now" sin recrear la función en cada render.
  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      const list = (await invoke("run_mcp_health_check")) as McpInfoExt[];
      setMcps(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void fetchList();
    const t = setInterval(() => void fetchList(), 30_000);
    return () => clearInterval(t);
  }, [fetchList]);

  function toggleHidden(name: string) {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setHidden(next);
  }

  function showFlash(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 4500);
  }

  // -------------------------------------------------------------------------
  // Open Edit modal — needs to read settings.json to get the source config
  // (list_mcps strips env, etc.).
  // -------------------------------------------------------------------------
  async function openEdit(name: string) {
    try {
      const snap = (await invoke("settings_read")) as SettingsSnapshot;
      const servers = (snap.content as Record<string, unknown>).mcpServers as
        | Record<string, Record<string, unknown>>
        | undefined;
      const cfg = servers?.[name] ?? {};
      setEditModel(configToEditable(name, cfg));
      setEditTarget(name);
      setEditError(null);
    } catch (e) {
      showFlash(`Failed to load entry: ${e}`);
    }
  }

  // -------------------------------------------------------------------------
  // Add
  // -------------------------------------------------------------------------
  async function submitAdd() {
    const err = validateEditable(addModel);
    if (err) {
      setAddError(err);
      return;
    }
    if (mcps.some((m) => m.name === addModel.name)) {
      setAddError(`'${addModel.name}' already exists.`);
      return;
    }
    setAddSaving(true);
    setAddError(null);
    try {
      const config = editableToConfig(addModel);
      const res = (await invoke("add_mcp", {
        name: addModel.name,
        config,
      })) as McpMutationResult;
      setAddOpen(false);
      setAddModel(blankMcp());
      showFlash(
        `Added '${res.name}'. Backup: ${res.backup_path ?? "n/a"}. Restart Claude Code for the new MCP to spawn.`,
      );
      await fetchList();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAddSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------------
  async function submitEdit() {
    const err = validateEditable(editModel);
    if (err) {
      setEditError(err);
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const config = editableToConfig(editModel);
      const res = (await invoke("update_mcp", {
        name: editModel.name,
        config,
      })) as McpMutationResult;
      setEditTarget(null);
      showFlash(
        `Updated '${res.name}'. Backup: ${res.backup_path ?? "n/a"}. Restart Claude Code to apply.`,
      );
      await fetchList();
    } catch (e) {
      setEditError(String(e));
    } finally {
      setEditSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------
  async function submitDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = (await invoke("delete_mcp", {
        name: deleteTarget,
      })) as McpMutationResult;
      setDeleteTarget(null);
      showFlash(
        `Removed '${res.name}'. Backup: ${res.backup_path ?? "n/a"}.`,
      );
      await fetchList();
    } catch (e) {
      showFlash(`Delete failed: ${e}`);
    } finally {
      setDeleting(false);
    }
  }

  const visible = mcps.filter((m) => !hidden.has(m.name) || showHidden);
  const okCount = mcps.filter((m) => m.status === "ok").length;
  const issueCount = mcps.filter(
    (m) => (m.status === "degraded" || m.status === "missing") && !m.expected_offline,
  ).length;

  return (
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">MCPs</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            {mcps.length} servers · {okCount} connected · {issueCount} need attention
            {(() => {
              // Surface origin breakdown so the user can sanity-check that
              // plugin- and project-scope MCPs are showing up (the user
              // reported that Claudia surfaced many more than CC did).
              const buckets = mcps.reduce<Record<string, number>>((acc, m) => {
                const k = parseOrigin(m.origin).kind;
                acc[k] = (acc[k] || 0) + 1;
                return acc;
              }, {});
              const parts: string[] = [];
              if (buckets.user) parts.push(`${buckets.user} user`);
              if (buckets.project) parts.push(`${buckets.project} project`);
              if (buckets.plugin) parts.push(`${buckets.plugin} plugin`);
              return parts.length > 0 ? <> · {parts.join(" · ")}</> : null;
            })()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setAddModel(blankMcp());
              setAddError(null);
              setAddOpen(true);
            }}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            + Add MCP
          </button>
          {/* "Generate from prompt" retired in favor of "Add with AI" —
              the inline modal kept choking on prompts with special chars
              and the wt.exe-based flow gives Claude full conversation
              control, which matters when the user needs to clarify
              command/args/env shape. */}
          <button
            type="button"
            onClick={async () => {
              try {
                const instr = (await invoke("instruction_path", {
                  kind: "mcps",
                })) as string;
                // v15.3.5: prompt now lives in the central catalog
                // (key `mcps.add_with_ai`) so it can be tuned from
                // Settings → Button prompts without recompiling.
                const { getPrompt } = await import("../lib/button-prompts");
                const prompt = await getPrompt("mcps.add_with_ai");
                await invoke("spawn_session", {
                  provider: "claude",
                  prompt,
                  cwd: instr,
                  flags: { dangerouslySkipPermissions: false },
                });
              } catch (e) {
                notifyError(`create mcp with AI failed: ${String(e)}`, "mcps");
              }
            }}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title={addWithAiTitle}
          >
            Add with AI
          </button>
          <button
            type="button"
            onClick={runProbe}
            disabled={probing}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title="Pings each MCP server (sse via HTTP, stdio via spawn + ListTools) to verify it's reachable. Marks 'degraded' if response > 5s, 'missing' if no response. Updates per-row status icon."
          >
            {probing ? "Probing…" : "Run health check"}
          </button>
        </div>
      </header>

      {flash && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(46, 160, 67, 0.07)",
            border: "1px solid rgba(46, 160, 67, 0.25)",
            color: "var(--color-success)",
          }}
        >
          {flash}
        </div>
      )}

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {hidden.size > 0 && (
        <div className="mb-4 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          {hidden.size} hidden ·{" "}
          <button
            type="button"
            onClick={() => setShowHidden(!showHidden)}
            className="underline-offset-2 hover:underline"
          >
            {showHidden ? "hide them" : "show them"}
          </button>
        </div>
      )}

      {/* v2.5.2 (wave 2): Global Enable/disable section removed — per-card
          toggle (rendered in <Card>) is the only enable/disable surface now.
          EnableDisableSection definition kept below the main component so
          backend wiring isn't dead and the section can be restored quickly.
          See SCOPE WARNING in task brief. */}

      {loading && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </div>
      )}

      {!loading && mcps.length === 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          No MCPs configured in ~/.claude/settings.json mcpServers.
        </div>
      )}

      {/* v2.6 (card-v26-7): grid 3-col. */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((m) => (
          <Card
            key={m.name}
            mcp={m}
            hidden={hidden.has(m.name)}
            ping={pings[m.name]}
            pingBusy={pingBusy.has(m.name)}
            enabled={enabledMap[m.name] !== false}
            toggleBusy={toggleBusy.has(m.name)}
            onToggleEnabled={() => void toggleEnabled(m.name, m.origin)}
            onAction={(a) => {
              if (a === "hide") toggleHidden(m.name);
              else if (a === "edit") openEdit(m.name);
              else if (a === "delete") setDeleteTarget(m.name);
              else if (a === "test") void testMcp(m.name);
            }}
          />
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Add modal                                                        */}
      {/* ---------------------------------------------------------------- */}
      {addOpen && (
        <Modal
          title="Add MCP"
          onClose={() => !addSaving && setAddOpen(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                disabled={addSaving}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAdd}
                disabled={addSaving}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {addSaving ? "Saving…" : "Add to settings.json"}
              </button>
            </>
          }
        >
          <McpForm value={addModel} onChange={setAddModel} lockName={false} />
          {addError && (
            <p
              className="mt-3 text-[12px]"
              style={{ color: "var(--color-danger)" }}
            >
              {addError}
            </p>
          )}
        </Modal>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Edit modal                                                       */}
      {/* ---------------------------------------------------------------- */}
      {editTarget && (
        <Modal
          title={`Edit MCP — ${editTarget}`}
          onClose={() => !editSaving && setEditTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                disabled={editSaving}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitEdit}
                disabled={editSaving}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {editSaving ? "Saving…" : "Save changes"}
              </button>
            </>
          }
        >
          <McpForm value={editModel} onChange={setEditModel} lockName={true} />
          {editError && (
            <p
              className="mt-3 text-[12px]"
              style={{ color: "var(--color-danger)" }}
            >
              {editError}
            </p>
          )}
        </Modal>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Delete confirm                                                   */}
      {/* ---------------------------------------------------------------- */}
      {deleteTarget && (
        <Modal
          title={`Delete ${deleteTarget}?`}
          onClose={() => !deleting && setDeleteTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitDelete}
                disabled={deleting}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "rgba(248, 81, 73, 0.18)",
                  color: "var(--color-danger)",
                  border: "1px solid rgba(248, 81, 73, 0.45)",
                }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </>
          }
        >
          <p
            className="text-[13px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            This removes <strong>{deleteTarget}</strong> from settings.json. A
            timestamped backup is kept in
            <code
              className="ml-1 rounded px-1.5 py-0.5"
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--color-surface-3)",
                color: "var(--color-text-primary)",
              }}
            >
              ~/.ultron/backups/control-center-settings/
            </code>
            .
          </p>
        </Modal>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Generate from prompt                                             */}
      {/* ---------------------------------------------------------------- */}
      {genOpen && (
        <GenerateModal
          onClose={() => setGenOpen(false)}
          onAdded={(msg) => {
            showFlash(msg);
            void fetchList();
          }}
        />
      )}
    </div>
  );
}
