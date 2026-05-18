import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types (mirror src-tauri/src/hooks_admin.rs)
// ---------------------------------------------------------------------------

type HookRecord = {
  id: string;
  event: string;
  matcher: string | null;
  command: string;
  enabled: boolean;
  source: string;
  extra: Record<string, unknown>;
};

type HooksList = {
  hooks: HookRecord[];
  settings_path: string;
  settings_exists: boolean;
};

type HookMutationResult = {
  success: boolean;
  hook: HookRecord | null;
  backup_path: string | null;
};

type HookTestResult = {
  success: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  elapsed_ms: number;
  timed_out: boolean;
};

type HookFire = {
  timestamp: string | null;
  event: string | null;
  hook_id: string | null;
  matcher: string | null;
  exit_code: number | null;
  raw: Record<string, unknown>;
};

type HookFiresReport = {
  fires: HookFire[];
  log_path: string;
  instrumented: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_OPTIONS: readonly string[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "Notification",
] as const;

const DEFAULT_PAYLOAD = `{
  "tool_name": "Bash",
  "tool_input": { "command": "echo hello" }
}`;

function eventBadgeColor(event: string): { bg: string; fg: string } {
  switch (event) {
    case "PreToolUse":
      return { bg: "rgba(96, 165, 250, 0.18)", fg: "#93c5fd" };
    case "PostToolUse":
      return { bg: "rgba(52, 211, 153, 0.18)", fg: "#6ee7b7" };
    case "UserPromptSubmit":
      return { bg: "rgba(251, 191, 36, 0.18)", fg: "#fcd34d" };
    case "SessionStart":
    case "SessionEnd":
      return { bg: "rgba(167, 139, 250, 0.18)", fg: "#c4b5fd" };
    case "Stop":
    case "SubagentStop":
      return { bg: "rgba(248, 113, 113, 0.18)", fg: "#fca5a5" };
    case "PreCompact":
      return { bg: "rgba(244, 114, 182, 0.18)", fg: "#f9a8d4" };
    case "Notification":
      return { bg: "rgba(45, 212, 191, 0.18)", fg: "#5eead4" };
    default:
      return { bg: "var(--color-surface-3)", fg: "var(--color-text-secondary)" };
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "...";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Hooks() {
  const [list, setList] = useState<HooksList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [filterEvent, setFilterEvent] = useState<string>("All");
  const [filterText, setFilterText] = useState<string>("");

  const [addOpen, setAddOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiDescription, setAiDescription] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const [editTarget, setEditTarget] = useState<HookRecord | null>(null);
  const [testTarget, setTestTarget] = useState<HookRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HookRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [fires, setFires] = useState<HookFiresReport | null>(null);

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  async function fetchList() {
    try {
      const res = (await invoke("list_hooks")) as HooksList;
      setList(res);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function fetchFires() {
    try {
      const res = (await invoke("recent_hook_fires", { limit: 50 })) as HookFiresReport;
      setFires(res);
    } catch (e) {
      // Non-fatal — instrumentation is optional.
      console.warn("recent_hook_fires failed", e);
    }
  }

  useEffect(() => {
    fetchList();
    fetchFires();
  }, []);

  function showFlash(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 4000);
  }

  // -------------------------------------------------------------------------
  // CRUD handlers
  // -------------------------------------------------------------------------

  async function handleToggle(hook: HookRecord) {
    try {
      const res = (await invoke("toggle_hook", { id: hook.id })) as HookMutationResult;
      showFlash(
        `${res.hook?.enabled ? "Enabled" : "Disabled"} hook. Backup: ${res.backup_path ?? "n/a"}`,
      );
      await fetchList();
    } catch (e) {
      showFlash(`Toggle failed: ${e}`);
    }
  }

  async function handleDelete(hook: HookRecord) {
    try {
      const res = (await invoke("delete_hook", { id: hook.id })) as HookMutationResult;
      showFlash(`Deleted hook. Backup: ${res.backup_path ?? "n/a"}`);
      setDeleteTarget(null);
      if (selectedId === hook.id) setSelectedId(null);
      await fetchList();
    } catch (e) {
      showFlash(`Delete failed: ${e}`);
    }
  }

  async function submitAi() {
    const desc = aiDescription.trim();
    if (!desc) return;
    setAiBusy(true);
    try {
      const res = (await invoke("request_hook_via_ai", { description: desc })) as string;
      showFlash(res);
      setAiOpen(false);
      setAiDescription("");
    } catch (e) {
      showFlash(`AI request failed: ${e}`);
    } finally {
      setAiBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const filtered = useMemo(() => {
    if (!list) return [];
    const base = filterEvent === "All"
      ? list.hooks
      : list.hooks.filter((h) => h.event === filterEvent);
    const q = filterText.trim().toLowerCase();
    if (!q) return base;
    return base.filter((h) => {
      const hay = `${h.matcher ?? ""} ${h.command ?? ""} ${h.event ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [list, filterEvent, filterText]);

  const grouped = useMemo(() => {
    const map = new Map<string, HookRecord[]>();
    for (const h of filtered) {
      const k = h.event;
      const arr = map.get(k) ?? [];
      arr.push(h);
      map.set(k, arr);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const selectedHook = useMemo(
    () => list?.hooks.find((h) => h.id === selectedId) ?? null,
    [list, selectedId],
  );

  const selectedFires = useMemo(() => {
    if (!fires || !selectedHook) return [];
    return fires.fires.filter((f) => f.hook_id === selectedHook.id);
  }, [fires, selectedHook]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-auto px-10 py-8">
        <header className="mb-6 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-semibold leading-tight">Hooks</h1>
            <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
              {list?.hooks.length ?? 0} hooks configured
              {list?.settings_path && (
                <>
                  {" "}
                  ·{" "}
                  <code
                    className="text-[11px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {list.settings_path}
                  </code>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fetchList()}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              title="Re-read settings.json"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              + Add hook
            </button>
            <button
              type="button"
              onClick={() => setAiOpen(true)}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
              title="Open a Claude session that drafts the hook JSON for you"
            >
              Add with AI
            </button>
          </div>
        </header>

        {flash && (
          <div
            className="mb-4 rounded border px-3 py-2 text-[12px]"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
            }}
          >
            {flash}
          </div>
        )}

        {error && (
          <div
            className="mb-4 rounded border px-3 py-2 text-[12px]"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-2)",
              color: "var(--color-danger, #f88)",
            }}
          >
            {error}
          </div>
        )}

        {list && !list.settings_exists && (
          <div
            className="mb-4 rounded border px-3 py-2 text-[12px]"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
            }}
          >
            settings.json does not exist yet. Adding the first hook will create
            it.
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px]">
          <span style={{ color: "var(--color-text-tertiary)" }}>Filter:</span>
          <select
            value={filterEvent}
            onChange={(e) => setFilterEvent(e.target.value)}
            className="rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            <option value="All">All events</option>
            {EVENT_OPTIONS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search by matcher / command…"
            className="min-w-[220px] flex-1 rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
              outline: "none",
            }}
          />
          <span style={{ color: "var(--color-text-tertiary)" }}>
            {filtered.length} / {list?.hooks.length ?? 0}
          </span>
        </div>

        {loading && (
          <div className="text-[13px]" style={{ color: "var(--color-text-tertiary)" }}>
            Loading...
          </div>
        )}

        {!loading && grouped.length === 0 && (
          <div className="text-[13px]" style={{ color: "var(--color-text-tertiary)" }}>
            No hooks configured.
          </div>
        )}

        <div className="space-y-6">
          {grouped.map(([event, items]) => {
            const colors = eventBadgeColor(event);
            return (
              <section key={event}>
                <h2
                  className="mb-2 inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                  style={{ background: colors.bg, color: colors.fg }}
                >
                  {event}
                </h2>
                <ul className="space-y-1">
                  {items.map((h) => {
                    const isSelected = selectedId === h.id;
                    return (
                      <li
                        key={h.id}
                        onClick={() => setSelectedId(isSelected ? null : h.id)}
                        className="flex cursor-pointer items-center gap-3 rounded border px-3 py-2 text-[12px] transition-colors"
                        style={{
                          borderColor: isSelected
                            ? "var(--color-accent)"
                            : "var(--color-border)",
                          background: isSelected
                            ? "var(--color-surface-2)"
                            : "var(--color-surface-1)",
                          opacity: h.enabled ? 1 : 0.55,
                        }}
                      >
                        <label
                          className="flex items-center"
                          onClick={(e) => e.stopPropagation()}
                          title={h.enabled ? "Click to disable" : "Click to enable"}
                        >
                          <input
                            type="checkbox"
                            checked={h.enabled}
                            onChange={() => handleToggle(h)}
                          />
                        </label>
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: "var(--color-surface-3)",
                            color: "var(--color-text-secondary)",
                          }}
                        >
                          {h.matcher ?? "any"}
                        </span>
                        <code
                          className="flex-1 text-[11px]"
                          style={{ color: "var(--color-text)" }}
                          title={h.command}
                        >
                          {truncate(h.command, 110)}
                        </code>
                        <div
                          className="flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => setTestTarget(h)}
                            className="rounded px-2 py-0.5 text-[11px]"
                            style={{
                              background: "var(--color-surface-3)",
                              color: "var(--color-text-secondary)",
                              border: "1px solid var(--color-border)",
                            }}
                          >
                            Test
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditTarget(h)}
                            className="rounded px-2 py-0.5 text-[11px]"
                            style={{
                              background: "var(--color-surface-3)",
                              color: "var(--color-text-secondary)",
                              border: "1px solid var(--color-border)",
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(h)}
                            className="rounded px-2 py-0.5 text-[11px]"
                            style={{
                              background: "var(--color-surface-3)",
                              color: "var(--color-danger, #f88)",
                              border: "1px solid var(--color-border)",
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>

      {selectedHook && (
        <SidePanel
          hook={selectedHook}
          fires={selectedFires}
          firesInstrumented={fires?.instrumented ?? false}
          firesLogPath={fires?.log_path ?? null}
          onTest={() => setTestTarget(selectedHook)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {addOpen && (
        <HookFormModal
          mode="add"
          onClose={() => setAddOpen(false)}
          onSaved={async (msg) => {
            setAddOpen(false);
            showFlash(msg);
            await fetchList();
          }}
        />
      )}

      {editTarget && (
        <HookFormModal
          mode="edit"
          initial={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={async (msg) => {
            setEditTarget(null);
            showFlash(msg);
            await fetchList();
          }}
        />
      )}

      {testTarget && (
        <TestModal hook={testTarget} onClose={() => setTestTarget(null)} />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete hook?"
          body={`Event: ${deleteTarget.event}\nMatcher: ${deleteTarget.matcher ?? "(none)"}\nCommand: ${truncate(deleteTarget.command, 200)}`}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {aiOpen && (
        <AiModal
          description={aiDescription}
          busy={aiBusy}
          onChange={setAiDescription}
          onClose={() => setAiOpen(false)}
          onSubmit={submitAi}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side panel — shows full command + recent fires for the selected hook.
// ---------------------------------------------------------------------------

function SidePanel({
  hook,
  fires,
  firesInstrumented,
  firesLogPath,
  onTest,
  onClose,
}: {
  hook: HookRecord;
  fires: HookFire[];
  firesInstrumented: boolean;
  firesLogPath: string | null;
  onTest: () => void;
  onClose: () => void;
}) {
  return (
    <aside
      className="w-[360px] shrink-0 overflow-auto border-l px-4 py-4"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[13px] font-semibold">Hook detail</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-0.5 text-[11px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Close
        </button>
      </div>

      <div className="mb-3 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
        <div>
          <strong>Event:</strong> {hook.event}
        </div>
        <div>
          <strong>Matcher:</strong> {hook.matcher ?? "(none)"}
        </div>
        <div>
          <strong>Enabled:</strong> {hook.enabled ? "yes" : "no"}
        </div>
        <div>
          <strong>ID:</strong> <code>{hook.id}</code>
        </div>
      </div>

      <div className="mb-3">
        <div
          className="mb-1 text-[10px] font-medium uppercase tracking-wide"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Command
        </div>
        <pre
          className="overflow-auto rounded border p-2 text-[11px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {hook.command}
        </pre>
      </div>

      {Object.keys(hook.extra).length > 0 && (
        <div className="mb-3">
          <div
            className="mb-1 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Extra flags
          </div>
          <pre
            className="overflow-auto rounded border p-2 text-[11px]"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          >
            {JSON.stringify(hook.extra, null, 2)}
          </pre>
        </div>
      )}

      <button
        type="button"
        onClick={onTest}
        className="mb-4 w-full rounded px-3 py-1.5 text-[12px] font-medium"
        style={{
          background: "var(--color-accent)",
          color: "var(--color-accent-text)",
        }}
      >
        Test now
      </button>

      <div>
        <div
          className="mb-1 text-[10px] font-medium uppercase tracking-wide"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Recent fires
        </div>
        {!firesInstrumented && (
          <div
            className="rounded border px-2 py-1.5 text-[11px]"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-2)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No instrumentation set up yet. To track fires, have your hook
            append a JSON line to <code>~/.ultron/.tmp/hook-fires.jsonl</code>
            (keys: timestamp, event, hook_id, matcher, exit_code).
          </div>
        )}
        {firesInstrumented && fires.length === 0 && (
          <div
            className="text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No fires logged for this hook yet.
          </div>
        )}
        {firesInstrumented && fires.length > 0 && (
          <ul className="space-y-1">
            {fires.map((f, i) => (
              <li
                key={i}
                className="rounded border px-2 py-1 text-[11px]"
                style={{
                  borderColor: "var(--color-border)",
                  background: "var(--color-surface-2)",
                }}
              >
                <div style={{ color: "var(--color-text)" }}>
                  {f.timestamp ?? "(no ts)"} · exit{" "}
                  <span
                    style={{
                      color:
                        f.exit_code === 0
                          ? "var(--color-success)"
                          : "var(--color-warn)",
                    }}
                  >
                    {f.exit_code ?? "?"}
                  </span>
                </div>
                <div style={{ color: "var(--color-text-tertiary)" }}>
                  {f.event ?? "?"} / {f.matcher ?? "any"}
                </div>
              </li>
            ))}
          </ul>
        )}
        {firesLogPath && (
          <div
            className="mt-2 text-[10px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Log: <code>{firesLogPath}</code>
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit modal
// ---------------------------------------------------------------------------

function HookFormModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  initial?: HookRecord;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [event, setEvent] = useState<string>(initial?.event ?? "PreToolUse");
  const [matcher, setMatcher] = useState<string>(initial?.matcher ?? "");
  const [command, setCommand] = useState<string>(initial?.command ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!command.trim()) {
      setErr("Command cannot be empty.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (mode === "add") {
        const res = (await invoke("add_hook", {
          event,
          matcher: matcher.trim() || null,
          command,
        })) as HookMutationResult;
        onSaved(`Added hook. Backup: ${res.backup_path ?? "n/a"}`);
      } else if (initial) {
        const res = (await invoke("update_hook", {
          id: initial.id,
          command,
          enabled: null,
          // review audit v15.5.4: match add_hook semantics — empty string
          // matchers (user cleared the input) should be persisted as null
          // so settings.json doesn't end up with an empty "matcher": "" key.
          matcher: matcher.trim() || null,
        })) as HookMutationResult;
        onSaved(`Updated hook. Backup: ${res.backup_path ?? "n/a"}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-md border p-5 shadow-xl"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">
          {mode === "add" ? "Add hook" : "Edit hook"}
        </div>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Event
          </div>
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            disabled={mode === "edit"}
            className="w-full rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {EVENT_OPTIONS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          {mode === "edit" && (
            <div
              className="mt-1 text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Event is immutable. Delete and re-add to change it.
            </div>
          )}
        </label>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Matcher (optional regex — e.g. "Bash", "Read|Glob|Grep", "mcp__.*")
          </div>
          <input
            type="text"
            value={matcher}
            onChange={(e) => setMatcher(e.target.value)}
            className="w-full rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Command
          </div>
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={6}
            className="w-full rounded px-2 py-1 font-mono text-[11px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        {err && (
          <div
            className="mb-3 rounded border px-2 py-1 text-[11px]"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-danger, #f88)",
            }}
          >
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {saving ? "Saving..." : mode === "add" ? "Add hook" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test modal
// ---------------------------------------------------------------------------

function TestModal({
  hook,
  onClose,
}: {
  hook: HookRecord;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<string>(DEFAULT_PAYLOAD);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HookTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const res = (await invoke("test_hook", {
        id: hook.id,
        mockPayload: payload,
      })) as HookTestResult;
      setResult(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[700px] rounded-md border p-5 shadow-xl"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[15px] font-semibold">Test hook</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[11px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Close
          </button>
        </div>

        <div
          className="mb-3 rounded border px-3 py-2 text-[11px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Runs the command in a sandboxed PowerShell with a 5s timeout. The
          payload is exposed via the <code>CLAUDE_HOOK_PAYLOAD</code> env var.
          Hooks that block on stdin will hit the timeout.
        </div>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Mock payload (JSON)
          </div>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={5}
            className="w-full rounded px-2 py-1 font-mono text-[11px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {running ? "Running..." : "Run"}
          </button>
        </div>

        {err && (
          <div
            className="mb-3 rounded border px-2 py-1 text-[11px]"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-danger, #f88)",
            }}
          >
            {err}
          </div>
        )}

        {result && (
          <div>
            {result.timed_out && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11px] font-semibold"
                style={{
                  borderColor: "var(--color-warn, #f80)",
                  background: "rgba(248,136,0,0.10)",
                  color: "var(--color-warn, #f80)",
                }}
              >
                TIMED OUT after 5s — the command likely blocked on stdin or
                an interactive prompt.
              </div>
            )}
            {!result.timed_out && !result.success && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11px] font-semibold"
                style={{
                  borderColor: "var(--color-danger, #f88)",
                  background: "rgba(248,113,113,0.10)",
                  color: "var(--color-danger, #f88)",
                }}
              >
                FAILED (exit code {result.exit_code ?? "?"})
              </div>
            )}
            {result.success && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11px] font-semibold"
                style={{
                  borderColor: "var(--color-success, #2da)",
                  background: "rgba(45,212,191,0.10)",
                  color: "var(--color-success, #2da)",
                }}
              >
                OK (exit 0) · {result.elapsed_ms}ms
              </div>
            )}
            <div className="mb-2">
              <div
                className="mb-1 text-[10px] uppercase"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                stdout
              </div>
              <pre
                className="max-h-48 overflow-auto rounded border p-2 text-[11px]"
                style={{
                  borderColor: "var(--color-border)",
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {result.stdout || "(empty)"}
              </pre>
            </div>
            <div>
              <div
                className="mb-1 text-[10px] uppercase"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                stderr
              </div>
              <pre
                className="max-h-48 overflow-auto rounded border p-2 text-[11px]"
                style={{
                  borderColor: "var(--color-border)",
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {result.stderr || "(empty)"}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI modal
// ---------------------------------------------------------------------------

function AiModal({
  description,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  description: string;
  busy: boolean;
  onChange: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-md border p-5 shadow-xl"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">Add hook with AI</div>

        <div
          className="mb-3 text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Describe in plain language what the hook should do. Claude opens a
          new session, drafts the JSON, and you paste the result back into
          "Add hook" to confirm and write to settings.json.
        </div>

        <textarea
          value={description}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          placeholder="e.g. Before every Bash tool call, log the command being run to ~/.ultron/.tmp/bash-audit.jsonl"
          className="mb-3 w-full rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
          }}
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !description.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy ? "Opening..." : "Open Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm modal (delete)
// ---------------------------------------------------------------------------

function ConfirmModal({
  title,
  body,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onCancel}
    >
      <div
        className="w-[440px] rounded-md border p-5 shadow-xl"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">{title}</div>
        <pre
          className="mb-4 overflow-auto rounded border p-2 text-[11px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {body}
        </pre>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: "var(--color-danger, #f88)",
              color: "var(--color-surface-1)",
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export default Hooks;
