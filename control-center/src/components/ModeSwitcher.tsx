import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ULTRON has four orchestration modes (LOW · MEDIUM · HIGH · ULTRA). The
// source-of-truth is `~/.ultron/.tmp/current-session.json`, which the
// hook system writes at session start. This component reads it and lets
// the user pick a different mode for the *next* session. It doesn't
// hot-swap a running Claude — it stages the mode for the next time a
// session is primed.

const MODES: { id: ModeKey; label: string; tag: string; desc: string; color: string }[] = [
  {
    id: "LOW",
    label: "LOW",
    tag: "minimal",
    desc: "Single-turn, no Dual, no plans. Use when token budget matters most.",
    color: "var(--color-text-tertiary)",
  },
  {
    id: "MEDIUM",
    label: "MEDIUM",
    tag: "default",
    desc: "Balanced: persona routing, recall, basic plans. The default for daily work.",
    color: "var(--color-success)",
  },
  {
    id: "HIGH",
    label: "HIGH",
    tag: "deep",
    desc: "Full recall, plan-driven, Codex/Gemini delegation allowed. Multi-step tasks.",
    color: "var(--color-warn)",
  },
  {
    id: "ULTRA",
    label: "ULTRA",
    tag: "maximum",
    desc: "Hiper-plans, Dual rounds, autonomous orchestration. Token cost ignored.",
    color: "var(--color-danger)",
  },
];

export type ModeKey = "LOW" | "MEDIUM" | "HIGH" | "ULTRA";

type Props = {
  current: ModeKey | null;
  onChange?: (m: ModeKey) => void;
};

export function ModeSwitcher({ current, onChange }: Props) {
  const [saving, setSaving] = useState<ModeKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSet, setLastSet] = useState<ModeKey | null>(null);

  async function pick(m: ModeKey) {
    if (m === current || saving) return;
    setSaving(m);
    setError(null);
    try {
      await invoke("set_ultron_mode", { mode: m });
      setLastSet(m);
      onChange?.(m);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="grid grid-cols-4 gap-2">
      {MODES.map((m) => {
        const active = current === m.id;
        const pending = saving === m.id;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => pick(m.id)}
            disabled={saving !== null}
            className="rounded p-3 text-left transition-colors disabled:opacity-50"
            style={{
              background: active ? "var(--color-surface-3)" : "var(--color-surface-2)",
              border: `1px solid ${active ? m.color : "var(--color-border)"}`,
            }}
          >
            <div className="flex items-baseline gap-2">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: m.color }}
              />
              <div
                className="text-[12.5px] font-semibold tabular-nums"
                style={{ color: "var(--color-text)" }}
              >
                {m.label}
              </div>
              <span
                className="ml-auto text-[10px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {pending ? "saving…" : m.tag}
              </span>
            </div>
            <p
              className="mt-2 text-[10.5px] leading-snug"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {m.desc}
            </p>
          </button>
        );
      })}
      {error && (
        <div
          className="col-span-4 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {lastSet && !error && (
        <div
          className="col-span-4 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          Next session will start in {lastSet} mode.
        </div>
      )}
    </div>
  );
}

export function useUltronMode() {
  const [mode, setMode] = useState<ModeKey | null>(null);
  // v15.2 F7: surface what autodetect would pick + whether the on-disk
  // mode is literally "auto" (i.e. the user has reset to autodetect).
  const [autodetectDefault, setAutodetectDefault] = useState<ModeKey>("MEDIUM");
  const [isAuto, setIsAuto] = useState<boolean>(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    invoke<{ mode: string | null; autodetect_default?: string; is_auto?: boolean }>(
      "get_ultron_mode",
    )
      .then((r) => {
        if (cancelled) return;
        const m = (r?.mode ?? "").toUpperCase();
        if (m === "LOW" || m === "MEDIUM" || m === "HIGH" || m === "ULTRA") {
          setMode(m);
        } else {
          setMode(null);
        }
        const def = (r?.autodetect_default ?? "MEDIUM").toUpperCase();
        if (def === "LOW" || def === "MEDIUM" || def === "HIGH" || def === "ULTRA") {
          setAutodetectDefault(def);
        }
        setIsAuto(Boolean(r?.is_auto));
      })
      .catch(() => {
        if (!cancelled) {
          setMode(null);
          setIsAuto(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return {
    mode,
    autodetectDefault,
    isAuto,
    refresh: () => setReloadKey((k) => k + 1),
  };
}
