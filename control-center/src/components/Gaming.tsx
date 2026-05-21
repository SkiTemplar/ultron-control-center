import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GameProcessInfo, KillResult } from "../types";

type WindowsTweak = {
  key: string;
  label: string;
  enabled: boolean;
  description: string;
  active_guid?: string;
  active_name?: string;
};

function WindowsTweaksSection() {
  const [tweaks, setTweaks] = useState<WindowsTweak[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("windows_tweaks_status")) as WindowsTweak[];
      setTweaks(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function toggle(t: WindowsTweak) {
    setBusy(t.key);
    setError(null);
    try {
      const r = (await invoke("windows_tweak_set", {
        key: t.key,
        enabled: !t.enabled,
      })) as WindowsTweak[];
      setTweaks(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-8">
      <h2
        className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em]"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Windows tweaks
      </h2>
      <p
        className="mb-3 text-[11px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Reversible user-level changes (HKCU registry + powercfg). No admin
        required. Each toggle applies the change instantly and saves the state.
      </p>
      {error && (
        <div
          className="mb-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {loading && tweaks.length === 0 && (
        <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading tweaks...
        </div>
      )}
      <div className="space-y-2">
        {tweaks.map((t) => (
          <div
            key={t.key}
            className="flex items-start gap-3 rounded p-3 transition-colors"
            style={{
              background: t.enabled
                ? "rgba(63, 185, 80, 0.05)"
                : "var(--color-surface-2)",
              border: `1px solid ${
                t.enabled ? "rgba(63, 185, 80, 0.22)" : "var(--color-border)"
              }`,
            }}
          >
            <button
              type="button"
              onClick={() => toggle(t)}
              disabled={busy === t.key}
              className="mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
              style={{
                background: t.enabled
                  ? "var(--color-success)"
                  : "var(--color-surface-3)",
                border: "1px solid var(--color-border-strong)",
                padding: "1px",
              }}
              title={t.enabled ? "Click to revert" : "Click to apply"}
            >
              <span
                className="block h-3.5 w-3.5 rounded-full transition-transform"
                style={{
                  background: "var(--color-text)",
                  transform: t.enabled ? "translateX(16px)" : "translateX(0)",
                }}
              />
            </button>
            <div className="min-w-0 flex-1">
              <div
                className="text-[12.5px] font-medium"
                style={{ color: "var(--color-text)" }}
              >
                {t.label}
              </div>
              <div
                className="mt-0.5 text-[11px] leading-relaxed"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {t.description}
              </div>
              {t.active_name && (
                <div
                  className="mt-0.5 text-[10.5px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  active: {t.active_name}
                </div>
              )}
            </div>
            <span
              className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
              style={{
                background: t.enabled
                  ? "rgba(63, 185, 80, 0.1)"
                  : "var(--color-surface-3)",
                color: t.enabled
                  ? "var(--color-success)"
                  : "var(--color-text-tertiary)",
              }}
            >
              {t.enabled ? "on" : "off"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function categoryColor(cat: string): string {
  if (!cat) return "var(--color-text-tertiary)";
  return "var(--color-warn)";
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function Row({
  p,
  checked,
  onToggle,
}: {
  p: GameProcessInfo;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className="flex items-center gap-3 rounded p-3 transition-colors"
      style={{
        background: checked ? "rgba(63, 185, 80, 0.05)" : "var(--color-surface-2)",
        border: `1px solid ${
          checked ? "rgba(63, 185, 80, 0.22)" : "var(--color-border)"
        }`,
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 shrink-0 accent-emerald-500"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
            {p.name}
          </span>
          {p.category && (
            <span
              className="text-[10px] uppercase tracking-wide"
              style={{ color: categoryColor(p.category) }}
            >
              {p.category}
            </span>
          )}
          {p.suggested && (
            <span
              className="rounded px-1 py-px text-[9.5px] font-medium uppercase tracking-wide"
              style={{
                background: "rgba(63, 185, 80, 0.10)",
                color: "var(--color-success)",
              }}
            >
              suggested
            </span>
          )}
        </div>
        <div
          className="mt-0.5 text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          pid <span className="tabular-nums">{p.pid}</span>
        </div>
      </div>
      <span
        className="shrink-0 tabular-nums text-[12.5px] font-medium"
        style={{ color: "var(--color-text)" }}
      >
        {formatMb(p.ram_mb)}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Gaming() {
  const [procs, setProcs] = useState<GameProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [killing, setKilling] = useState(false);
  const [result, setResult] = useState<KillResult | null>(null);

  async function load() {
    setLoading(true);
    setResult(null);
    try {
      const r = (await invoke("list_killable_processes")) as GameProcessInfo[];
      setProcs(r);
      // Auto-select suggested rows on every load.
      setSelected(new Set(r.filter((p) => p.suggested).map((p) => p.pid)));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function activate() {
    if (selected.size === 0) return;
    setKilling(true);
    try {
      const r = (await invoke("kill_processes", {
        pids: Array.from(selected),
      })) as KillResult;
      setResult(r);
      // Refresh list to reflect killed pids.
      setTimeout(load, 800);
    } catch (e) {
      setError(String(e));
    } finally {
      setKilling(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function toggle(pid: number) {
    const next = new Set(selected);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    setSelected(next);
  }

  function selectAllSuggested() {
    setSelected(new Set(procs.filter((p) => p.suggested).map((p) => p.pid)));
  }
  function selectNone() {
    setSelected(new Set());
  }

  const suggestedProcs = procs.filter((p) => p.suggested);
  const keepProcs = procs.filter((p) => p.keep_default);
  const otherProcs = procs.filter((p) => !p.suggested && !p.keep_default);
  const suggestedCount = suggestedProcs.length;
  const keepCount = keepProcs.length;
  const otherCount = otherProcs.length;
  const ramSelected = useMemo(
    () =>
      procs
        .filter((p) => selected.has(p.pid))
        .reduce((acc, p) => acc + p.ram_mb, 0),
    [procs, selected],
  );

  return (
    <div className="px-10 py-8">
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Gaming mode</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Kill background apps before launching a game. System processes and
            ULTRON/Claude/IDE are never touched.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {loading ? "Scanning…" : "Rescan"}
          </button>
          <button
            type="button"
            onClick={activate}
            disabled={killing || selected.size === 0}
            className="rounded px-4 py-1.5 text-[12.5px] font-semibold transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title={
              selected.size === 0
                ? "Select at least one process"
                : `Kill ${selected.size} process(es), free ~${formatMb(ramSelected)}`
            }
          >
            {killing
              ? "Activating…"
              : `Activate · free ~${formatMb(ramSelected)}`}
          </button>
        </div>
      </header>

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

      {result && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background:
              result.failed.length === 0
                ? "rgba(63, 185, 80, 0.06)"
                : "rgba(210, 153, 34, 0.06)",
            border: `1px solid ${
              result.failed.length === 0
                ? "rgba(63, 185, 80, 0.22)"
                : "rgba(210, 153, 34, 0.22)"
            }`,
            color:
              result.failed.length === 0
                ? "var(--color-success)"
                : "var(--color-warn)",
          }}
        >
          Killed {result.killed.length} process(es), freed ~
          {formatMb(result.freed_mb_estimate)}.
          {result.failed.length > 0 && (
            <span> {result.failed.length} failed.</span>
          )}
          {result.failed.length > 0 && (
            <ul
              className="mt-2 space-y-0.5 text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {result.failed.slice(0, 5).map((f) => (
                <li key={f.pid}>
                  pid {f.pid}: {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3 text-[12px]">
        <button
          type="button"
          onClick={selectAllSuggested}
          className="rounded px-2 py-1 text-[11.5px] transition-colors"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          Select suggested ({suggestedCount})
        </button>
        <button
          type="button"
          onClick={selectNone}
          className="rounded px-2 py-1 text-[11.5px] transition-colors"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border)",
          }}
        >
          Clear selection
        </button>
        <span
          className="ml-auto text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {selected.size} selected · ~{formatMb(ramSelected)} estimated to free
        </span>
      </div>

      {loading && procs.length === 0 && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Enumerating processes…
        </div>
      )}

      {/* Dispensable / bloat — pre-checked */}
      {suggestedProcs.length > 0 && (
        <section className="mb-6">
          <h2
            className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Dispensable background apps ({suggestedCount})
          </h2>
          <p
            className="mb-2 text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Updaters, cloud sync, OEM suites and orphan webviews — safe to
            evict before launching a game.
          </p>
          <div className="space-y-1.5">
            {suggestedProcs.map((p) => (
              <Row
                key={p.pid}
                p={p}
                checked={selected.has(p.pid)}
                onToggle={() => toggle(p.pid)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Communication / music — kept by default */}
      {keepProcs.length > 0 && (
        <section className="mb-6">
          <h2
            className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Keep open by default ({keepCount})
          </h2>
          <p
            className="mb-2 text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Discord, Spotify, voice/video — left running so you can keep
            talking to friends. Tick to kill only if you really want silence.
          </p>
          <div className="space-y-1.5">
            {keepProcs.map((p) => (
              <Row
                key={p.pid}
                p={p}
                checked={selected.has(p.pid)}
                onToggle={() => toggle(p.pid)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Everything else */}
      {otherProcs.length > 0 && (
        <section>
          <h2
            className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Other processes ({otherCount}) — pick carefully
          </h2>
          <div className="space-y-1.5">
            {otherProcs.map((p) => (
              <Row
                key={p.pid}
                p={p}
                checked={selected.has(p.pid)}
                onToggle={() => toggle(p.pid)}
              />
            ))}
          </div>
        </section>
      )}

      <WindowsTweaksSection />
    </div>
  );
}
