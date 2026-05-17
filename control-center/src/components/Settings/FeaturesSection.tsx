import { useEffect, useState } from "react";
import {
  FEATURE_KEYS,
  saveFeatures,
  useFeatures,
  type Features,
} from "../../lib/features";

// v15.4: post-install feature toggles. Lets the user enable/disable
// optional modules from Settings — same set of flags the installer
// wizard writes to ~/.ultron/cockpit/features.json. Persists through
// `saveFeatures()`, which updates the in-memory cache so the sidebar
// reacts immediately without a page reload.
//
// Re-running install.ps1 is still the canonical way to add/remove the
// *files* on disk. This panel only flips the runtime flag — useful for
// keeping the scripts installed but hiding the tab.

const META: Record<
  keyof Features,
  { label: string; description: string }
> = {
  news: {
    label: "News digest",
    description: "Gemini-generated daily newsletter (costs tokens).",
  },
  gaming: {
    label: "Gaming utilities",
    description: "Game detector + Windows tweaks panel.",
  },
  personal: {
    label: "Personal tab",
    description: "Private profile / known.json / writing style.",
  },
  schedules: {
    label: "Schedules tab",
    description: "Windows scheduled-task management UI.",
  },
  self_improve: {
    label: "Self-Improve tab",
    description: "Route telemetry + repo-evaluator card.",
  },
  memory: {
    label: "Memory tab",
    description: "Vault + brain_index browser. Keep ON unless using ULTRON as hooks-only.",
  },
  plans: {
    label: "Plans tab",
    description: "Lifecycle open → in-progress → resolved tracker.",
  },
  projects: {
    label: "Projects tab",
    description: "Project launcher with IDE-aware open. Keep ON for the cockpit experience.",
  },
  mcps: {
    label: "MCPs tab",
    description: "MCP server registry + health checks.",
  },
  skills: {
    label: "Skills tab",
    description: "Skills browser. Keep ON if you use Claude Code skills.",
  },
  hooks: {
    label: "Hooks tab",
    description: "Hooks inspector + audit log inside System.",
  },
  notifications: {
    label: "Notifications",
    description: "Toast/tray alerts + on-screen pending-actions panel.",
  },
  usage: {
    label: "Usage tracking",
    description: "Token budget + /usage cache + weekly reset reports.",
  },
  sessions: {
    label: "Sessions archive",
    description: "Session replay + highlights + compactor.",
  },
};

export function FeaturesSection() {
  const { features, loading, refresh } = useFeatures();
  const [draft, setDraft] = useState<Features>(features);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(features);
  }, [features]);

  const dirty = FEATURE_KEYS.some((k) => draft[k] !== features[k]);

  function toggle(k: keyof Features) {
    setDraft((d) => ({ ...d, [k]: !d[k] }));
  }

  async function commit() {
    setSaving(true);
    setErr(null);
    try {
      await saveFeatures(draft);
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(features);
    setErr(null);
  }

  return (
    <section className="mt-2 max-w-3xl">
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold">Optional features</h2>
          <p
            className="mt-1 text-[12px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Same toggles the installer wizard exposes. Persists to{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>
              ~/.ultron/cockpit/features.json
            </code>
            . Disabling a tab here hides it from the sidebar but does NOT
            remove files on disk — re-run <code style={{ fontFamily: "var(--font-mono)" }}>install.ps1</code>{" "}
            to physically purge an opt-out module.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty && (
            <button
              type="button"
              onClick={discard}
              disabled={saving}
              className="rounded px-3 py-1.5 text-[12px] transition-colors"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              Discard
            </button>
          )}
          <button
            type="button"
            onClick={commit}
            disabled={!dirty || saving}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: dirty ? "var(--color-accent)" : "var(--color-surface-3)",
              color: dirty ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
            }}
          >
            {saving ? "Saving…" : "Apply"}
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading || saving}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Reload
          </button>
        </div>
      </header>

      {err && (
        <div
          className="mb-3 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {err}
        </div>
      )}

      {savedAt && !dirty && (
        <div
          className="mb-3 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          Saved. Sidebar refreshes automatically.
        </div>
      )}

      <ul
        className="divide-y rounded"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
          // Tailwind divide-y honours the surrounding border colour token
          // via the CSS variable — explicit borderColor on the LI keeps
          // it consistent with the surrounding card.
        }}
      >
        {FEATURE_KEYS.map((k) => {
          const m = META[k];
          const on = draft[k];
          return (
            <li
              key={k}
              className="flex items-start justify-between gap-4 px-4 py-3"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{m.label}</div>
                <div
                  className="mt-0.5 text-[11.5px] leading-snug"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {m.description}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                onClick={() => toggle(k)}
                disabled={saving}
                title={on ? "Click to disable" : "Click to enable"}
                className="relative shrink-0 rounded-full transition-colors"
                style={{
                  width: 34,
                  height: 18,
                  background: on
                    ? "var(--color-accent)"
                    : "var(--color-surface-3)",
                  border: "1px solid var(--color-border-strong)",
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                <span
                  className="absolute top-[1px] rounded-full transition-all"
                  style={{
                    width: 14,
                    height: 14,
                    background: "white",
                    left: on ? 17 : 2,
                  }}
                />
              </button>
            </li>
          );
        })}
      </ul>

      <p
        className="mt-3 text-[11px]"
        style={{ color: "var(--color-text-faint)" }}
      >
        Tip: disabling a tab here is reversible at any time. The wizard
        (<code style={{ fontFamily: "var(--font-mono)" }}>install.ps1</code>)
        is the destructive path — unticking there deletes the implementing
        scripts under <code style={{ fontFamily: "var(--font-mono)" }}>~/.ultron/scripts/cockpit/</code>.
      </p>
    </section>
  );
}
