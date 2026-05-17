import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModeSwitcher, useUltronMode } from "../ModeSwitcher";

export function ModeSection() {
  const { mode, autodetectDefault, isAuto, refresh } = useUltronMode();
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function resetToAuto() {
    setResetting(true);
    setResetError(null);
    try {
      await invoke("reset_mode_to_autodetect");
      refresh();
    } catch (e) {
      setResetError(String(e));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h3 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Orchestration mode
        </h3>
        <p
          className="mt-1 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          The mode the hook system primes for the next ULTRON session. Source of truth:
          {" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>~/.ultron/.tmp/current-session.json</span>.
        </p>
      </header>

      {/* v15.2 F7: prominent current + default + reset row.
          - Currently active (big): the resolved mode now (or AUTO if user
            hit the reset button — the hooks will pick a concrete mode on
            the next SessionStart).
          - Default (small): what autodetect would pick — currently MEDIUM
            per mode-trigger.py heuristics. */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div
              className="text-[10.5px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Currently active
            </div>
            <div
              className="mt-1 text-[24px] font-semibold leading-none tabular-nums"
              style={{ color: "var(--color-text)" }}
            >
              {isAuto ? "AUTO" : (mode ?? "—")}
            </div>
            <div
              className="mt-2 text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Default (autodetect would pick):{" "}
              <strong style={{ color: "var(--color-text-secondary)" }}>
                {autodetectDefault}
              </strong>
            </div>
          </div>
          <button
            type="button"
            onClick={resetToAuto}
            disabled={resetting}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Writes mode=auto to current-session.json — the next SessionStart hook will pick the mode from the prompt instead of using a stored override."
          >
            {resetting ? "Resetting…" : "Reset to autodetect"}
          </button>
        </div>
        {resetError && (
          <div
            className="mt-3 rounded p-2 text-[11.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {resetError}
          </div>
        )}
      </div>

      <ModeSwitcher current={mode} onChange={() => refresh()} />
    </div>
  );
}
