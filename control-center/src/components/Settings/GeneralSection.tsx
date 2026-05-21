import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { OPEN_ONBOARDING_EVENT } from "../Onboarding";

// ---------------------------------------------------------------------------
// HotkeyEditor — single global hotkey (shows/hides the Control Center).
// ---------------------------------------------------------------------------

function HotkeyEditor() {
  const [spec, setSpec] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  // F1.6: clicking the "Capturar tecla" button steals focus from the
  // <input>, so onKeyDown never fires. Refocus the input as soon as
  // capturing flips to true.
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<string>("get_global_hotkey")
      .then((s) => {
        setSpec(s);
        setDraft(s);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (capturing) {
      inputRef.current?.focus();
    }
  }, [capturing]);

  async function apply() {
    if (!draft.trim() || draft === spec) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await invoke<string>("set_global_hotkey", { spec: draft.trim() });
      setSpec(r);
      setDraft(r);
      setSuccess(`Registered: ${r}`);
      window.setTimeout(() => setSuccess(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onCapture(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    // Only commit on a non-modifier key press.
    if (["Control", "Alt", "Shift", "Meta", "OS"].includes(e.key)) return;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    let k = e.key;
    if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    setDraft(parts.join("+"));
    setCapturing(false);
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Global hotkey
        </div>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
        >
          stored in ~/.ultron/.tmp/hotkey.txt
        </span>
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Press this combination in any Windows app to show/hide the Control
        Center. Format: <span style={{ fontFamily: "var(--font-mono)" }}>
        Ctrl+Alt+U</span>, <span style={{ fontFamily: "var(--font-mono)" }}>Ctrl+Shift+F12</span>,
        etc. Needs at least one modifier (Ctrl/Alt/Shift/Meta).
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onCapture}
          placeholder="Ctrl+Alt+U"
          className="rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: `1px solid ${capturing ? "var(--color-accent)" : "var(--color-border-strong)"}`,
            outline: "none",
            fontFamily: "var(--font-mono)",
            minWidth: 220,
          }}
        />
        <button
          type="button"
          onClick={() => setCapturing(!capturing)}
          className="rounded px-2.5 py-1 text-[11px]"
          style={{
            background: capturing ? "var(--color-surface-3)" : "transparent",
            color: capturing ? "var(--color-text)" : "var(--color-text-tertiary)",
            border: `1px solid ${capturing ? "var(--color-border-strong)" : "var(--color-border)"}`,
          }}
          title="Enable key capture to record the combination"
        >
          {capturing ? "Cancel capture" : "Capture key"}
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={busy || !draft.trim() || draft === spec}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {busy ? "Applying…" : "Apply"}
        </button>
        <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
          active: <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>{spec || "—"}</span>
        </span>
      </div>

      {error && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InAppShortcutsEditor — replaces the old read-only grid. Each row is a
// fixed label + an editable input with the same "Capturar tecla" affordance
// as HotkeyEditor. Persisted via the in_app_shortcuts Tauri commands. We
// dispatch an in-window event after every save so App.tsx can refresh its
// binding cache without polling.
// ---------------------------------------------------------------------------

/** Display rows for the editor — order = display order. Keys MUST match
 *  the action ids in `in_app_shortcuts::default_bindings` (Rust) AND the
 *  switch in App.tsx, otherwise the binding silently won't fire. */
const IN_APP_ROWS: { key: string; label: string }[] = [
  { key: "command.palette", label: "Command palette" },
  { key: "open.settings", label: "Settings (via Ctrl+,)" },
  { key: "refresh.all", label: "Refresh dashboard data" },
  { key: "tab.dashboard", label: "Dashboard" },
  { key: "tab.usage", label: "Usage" },
  { key: "tab.notifications", label: "Notifications" },
  { key: "tab.sessions", label: "Sessions" },
  { key: "tab.projects", label: "Projects" },
  { key: "tab.plans", label: "Plans" },
  { key: "tab.memory", label: "Memory" },
  { key: "tab.skills", label: "Skills" },
  { key: "tab.settings", label: "Settings (tab)" },
];

function comboFromEvent(e: React.KeyboardEvent<HTMLInputElement>): string | null {
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  let k = e.key;
  if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join("+");
}

function InAppShortcutsEditor() {
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    (async () => {
      try {
        const m = (await invoke("get_in_app_shortcuts")) as Record<string, string>;
        setBindings(m || {});
        setDirty(m || {});
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (capturing) inputRefs.current[capturing]?.focus();
  }, [capturing]);

  const isDirty = useMemo(() => {
    const keys = new Set([...Object.keys(bindings), ...Object.keys(dirty)]);
    for (const k of keys) {
      if ((bindings[k] ?? "") !== (dirty[k] ?? "")) return true;
    }
    return false;
  }, [bindings, dirty]);

  async function save() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      // Send only non-empty values; backend persists what we send and
      // falls back to defaults for everything missing.
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(dirty)) {
        const t = (v || "").trim();
        if (t) filtered[k] = t;
      }
      await invoke("set_in_app_shortcuts", { map: filtered });
      setBindings(filtered);
      // App.tsx listens for this and refetches its binding cache.
      window.dispatchEvent(new Event("in-app-shortcuts-updated"));
      setSuccess("Saved");
      window.setTimeout(() => setSuccess(null), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onCapture(actionKey: string, e: React.KeyboardEvent<HTMLInputElement>) {
    if (capturing !== actionKey) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e);
    if (!combo) return;
    setDirty((prev) => ({ ...prev, [actionKey]: combo }));
    setCapturing(null);
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          In-app shortcuts
        </div>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
        >
          ~/.ultron/.tmp/in-app-shortcuts.json
        </span>
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Shortcuts inside the Control Center. Edit the combo or click "Capture"
        and press the combination. Tab-jumps don't steal keys while you're in an input.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        {IN_APP_ROWS.map(({ key, label }) => {
          const current = dirty[key] ?? "";
          const isCap = capturing === key;
          return (
            <div key={key} className="flex items-center gap-2">
              <span
                className="w-40 shrink-0 text-[11.5px]"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {label}
              </span>
              <input
                ref={(el) => {
                  inputRefs.current[key] = el;
                }}
                type="text"
                value={current}
                onChange={(e) =>
                  setDirty((prev) => ({ ...prev, [key]: e.target.value }))
                }
                onKeyDown={(e) => onCapture(key, e)}
                placeholder="Alt+1"
                className="flex-1 rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: `1px solid ${isCap ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  minWidth: 0,
                }}
              />
              <button
                type="button"
                onClick={() => setCapturing(isCap ? null : key)}
                className="rounded px-2 py-1 text-[10.5px]"
                style={{
                  background: isCap ? "var(--color-surface-3)" : "transparent",
                  color: isCap ? "var(--color-text)" : "var(--color-text-tertiary)",
                  border: `1px solid ${isCap ? "var(--color-border-strong)" : "var(--color-border)"}`,
                }}
                title="Click to capture the next combination"
              >
                {isCap ? "…" : "Capture"}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !isDirty}
          className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {busy ? "Saving…" : "Save shortcuts"}
        </button>
        {success && (
          <span className="text-[11px]" style={{ color: "var(--color-success)" }}>
            {success}
          </span>
        )}
      </div>

      {error && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectHotkeysEditor — 10 slots, each with a combo + project dropdown.
// Slot N may be empty. Saving registers the global hotkey via Tauri
// (Rust side: project_hotkeys::set_project_at_slot). Pressing the hotkey
// emits "project-hotkey-custom" which App.tsx wires to open_project.
// ---------------------------------------------------------------------------

interface ProjectHotkeySlotRow {
  slot: number;
  combo: string;
  project_id: string;
}

interface MiniProject {
  id: string;
  name: string | null;
}

function ProjectHotkeysEditor() {
  const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
  const [projects, setProjects] = useState<MiniProject[]>([]);
  const [slots, setSlots] = useState<Record<number, { combo: string; projectId: string }>>({});
  const [capturing, setCapturing] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  async function loadAll() {
    try {
      const ps = (await invoke("list_projects")) as Array<{
        id: string;
        name: string | null;
      }>;
      setProjects(ps.map((p) => ({ id: p.id, name: p.name })));
    } catch (e) {
      setError(String(e));
    }
    try {
      const rows = (await invoke("get_project_hotkeys")) as ProjectHotkeySlotRow[];
      const next: Record<number, { combo: string; projectId: string }> = {};
      for (const r of rows) {
        next[r.slot] = { combo: r.combo, projectId: r.project_id };
      }
      setSlots(next);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (capturing != null) inputRefs.current[capturing]?.focus();
  }, [capturing]);

  function onCapture(slot: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (capturing !== slot) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e);
    if (!combo) return;
    setSlots((prev) => ({
      ...prev,
      [slot]: { combo, projectId: prev[slot]?.projectId ?? "" },
    }));
    setCapturing(null);
  }

  async function saveSlot(slot: number) {
    const entry = slots[slot];
    if (!entry || !entry.combo.trim() || !entry.projectId) {
      setError(`Slot ${slot}: pick a combo AND a project before saving`);
      return;
    }
    setBusy(slot);
    setError(null);
    setSuccess(null);
    try {
      await invoke("set_project_at_slot", {
        slot,
        projectId: entry.projectId,
        combo: entry.combo.trim(),
      });
      setSuccess(`Slot ${slot} saved (${entry.combo.trim()})`);
      window.setTimeout(() => setSuccess(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function clearSlot(slot: number) {
    setBusy(slot);
    setError(null);
    try {
      await invoke("clear_project_at_slot", { slot });
      setSlots((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Project hotkeys
        </div>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
        >
          ~/.ultron/cockpit/project-hotkeys.json
        </span>
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Assign a global hotkey (Ctrl+Alt+P style) to open a specific project
        from any Windows app. Distinct from the legacy Ctrl+Alt+1..9 set
        (which follows the pinned projects). Needs ≥1 modifier.
      </p>

      <div className="mt-3 space-y-2">
        {SLOTS.map((slot) => {
          const entry = slots[slot] ?? { combo: "", projectId: "" };
          const isCap = capturing === slot;
          const isBusy = busy === slot;
          return (
            <div
              key={slot}
              className="flex flex-wrap items-center gap-2"
              style={{ minHeight: 32 }}
            >
              <span
                className="w-12 shrink-0 text-[11px]"
                style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
              >
                #{slot}
              </span>
              <input
                ref={(el) => {
                  inputRefs.current[slot] = el;
                }}
                type="text"
                value={entry.combo}
                onChange={(e) =>
                  setSlots((prev) => ({
                    ...prev,
                    [slot]: { combo: e.target.value, projectId: prev[slot]?.projectId ?? "" },
                  }))
                }
                onKeyDown={(e) => onCapture(slot, e)}
                placeholder="Ctrl+Alt+P"
                className="rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: `1px solid ${isCap ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                  outline: "none",
                  fontFamily: "var(--font-mono)",
                  width: 160,
                }}
              />
              <button
                type="button"
                onClick={() => setCapturing(isCap ? null : slot)}
                className="rounded px-2 py-1 text-[10.5px]"
                style={{
                  background: isCap ? "var(--color-surface-3)" : "transparent",
                  color: isCap ? "var(--color-text)" : "var(--color-text-tertiary)",
                  border: `1px solid ${isCap ? "var(--color-border-strong)" : "var(--color-border)"}`,
                }}
              >
                {isCap ? "…" : "Capture"}
              </button>
              <select
                value={entry.projectId}
                onChange={(e) =>
                  setSlots((prev) => ({
                    ...prev,
                    [slot]: { combo: prev[slot]?.combo ?? "", projectId: e.target.value },
                  }))
                }
                className="rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  outline: "none",
                  minWidth: 180,
                  flex: "1 1 200px",
                }}
              >
                <option value="">— project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void saveSlot(slot)}
                disabled={isBusy || !entry.combo.trim() || !entry.projectId}
                className="rounded px-2 py-1 text-[10.5px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {isBusy ? "…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => void clearSlot(slot)}
                disabled={isBusy || (!entry.combo && !entry.projectId)}
                className="rounded px-2 py-1 text-[10.5px] disabled:opacity-40"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border)",
                }}
                title="Clear the slot and unregister the hotkey"
              >
                Clear
              </button>
            </div>
          );
        })}
      </div>

      {success && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}
      {error && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GeneralSection — the General tab: autostart toggle + global hotkey +
// in-app shortcuts + project hotkeys.
// ---------------------------------------------------------------------------

export function GeneralSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wipe legacy autostart artifacts (Startup-folder .lnk, dangling
  // StartupApproved record) before/after every interaction so the plugin's
  // registry value is the single source of truth. Best-effort: a failure
  // here must not block the user from reading the toggle state.
  async function purgeLegacy(): Promise<string[]> {
    try {
      const res = await invoke<{ removed: string[]; warnings: string[] }>(
        "purge_legacy_autostart",
      );
      return res.removed ?? [];
    } catch {
      return [];
    }
  }

  useEffect(() => {
    (async () => {
      await purgeLegacy();
      try {
        setEnabled(await isAutostartEnabled());
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  async function toggle() {
    if (enabled === null) return;
    setBusy(true);
    setError(null);
    try {
      if (enabled) {
        await disableAutostart();
        setEnabled(false);
      } else {
        await enableAutostart();
        setEnabled(true);
      }
      // After every toggle clean any rogue artifact so the registry stays
      // the only source of truth on subsequent isAutostartEnabled() reads.
      await purgeLegacy();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Autostart with Windows */}
      <div
        className="flex items-start gap-3 rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <button
          type="button"
          onClick={toggle}
          disabled={busy || enabled === null}
          className="mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
          style={{
            background: enabled
              ? "var(--color-success)"
              : "var(--color-surface-3)",
            border: "1px solid var(--color-border-strong)",
            padding: "1px",
          }}
          title={
            enabled
              ? "Click to stop launching ULTRON at Windows logon"
              : "Click to launch ULTRON at Windows logon"
          }
        >
          <span
            className="block h-3.5 w-3.5 rounded-full transition-transform"
            style={{
              background: "var(--color-text)",
              transform: enabled ? "translateX(16px)" : "translateX(0)",
            }}
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
            Start with Windows
          </div>
          <p
            className="mt-1 text-[12px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Adds <span style={{ fontFamily: "var(--font-mono)" }}>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</span>{" "}
            entry so the Control Center launches on logon with{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>--from-autostart</span>.
            The main window opens automatically and appears in the taskbar.
          </p>
        </div>
      </div>

      {/* Global hotkey */}
      <HotkeyEditor />

      {/* In-app shortcuts — now editable. Persisted at
          ~/.ultron/.tmp/in-app-shortcuts.json via get/set_in_app_shortcuts.
          App.tsx mirrors the map and dispatches keys against it. */}
      <InAppShortcutsEditor />

      {/* Custom per-project global hotkeys (Settings → Project hotkeys).
          Distinct from the legacy Ctrl+Alt+1..9 pin-derived slots —
          these let the user pick (slot, combo, project_id) tuples. */}
      <ProjectHotkeysEditor />

      {/* Re-open the first-run welcome overlay. The Onboarding component
          listens for OPEN_ONBOARDING_EVENT on the window. */}
      <div
        className="flex items-start gap-3 rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
            Welcome screen
          </div>
          <p
            className="mt-1 text-[12px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Re-open the first-run overlay that explains what ULTRON is and
            defines the core terms (Skill, Agent, MCP, Vault, Plan, Session,
            Hook).
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT))
          }
          className="mt-0.5 shrink-0 rounded px-3 py-1.5 text-[12px] font-medium"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          Show welcome screen
        </button>
      </div>

      {error && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
