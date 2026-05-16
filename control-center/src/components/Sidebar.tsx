import { useEffect, useState } from "react";
import type { GlobalStatus } from "../types";
import { statusColor, statusLabel } from "../lib/status";
import {
  useFeatures,
  saveFeatures,
  type Features,
  FEATURE_KEYS,
} from "../lib/features";

export type Tab =
  | "dashboard"
  | "mcps"
  | "skills"
  | "projects"
  | "memory"
  | "plans"
  | "changelog"
  | "notifications"
  | "sessions"
  | "usage"
  | "logs"
  | "system"
  | "gaming"
  | "news"
  | "personal"
  | "self-improve"
  | "settings";

type Item = {
  id: Tab;
  label: string;
  available: boolean;
  /**
   * If set, this item is hidden when features[featureKey] === false.
   * Items without a featureKey are always shown (dashboard, usage,
   * notifications, changelog, sessions, system, settings).
   */
  featureKey?: keyof Features;
};

const SECTIONS: { heading: string; items: Item[] }[] = [
  {
    heading: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", available: true },
      { id: "usage", label: "Usage", available: true },
      { id: "notifications", label: "Notifications", available: true },
      { id: "changelog", label: "Changelog", available: true },
      { id: "news", label: "News", available: true, featureKey: "news" },
    ],
  },
  {
    heading: "System",
    items: [
      { id: "system", label: "System", available: true },
      { id: "mcps", label: "MCPs", available: true, featureKey: "mcps" },
      { id: "skills", label: "Skills", available: true, featureKey: "skills" },
      { id: "memory", label: "Memory", available: true, featureKey: "memory" },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { id: "sessions", label: "Sessions", available: true },
      { id: "projects", label: "Projects", available: true, featureKey: "projects" },
      { id: "gaming", label: "Gaming", available: true, featureKey: "gaming" },
      { id: "plans", label: "Plans", available: true, featureKey: "plans" },
      { id: "logs", label: "Logs", available: false },
    ],
  },
  {
    heading: "Meta",
    items: [
      { id: "self-improve", label: "Stats", available: true, featureKey: "self_improve" },
      { id: "personal", label: "Personal", available: true, featureKey: "personal" },
    ],
  },
  // v15.2 F7: "Hooks" moved into System as an inner sub-tab — no longer a
  // top-level sidebar item. Hooks feature gating still applies inside System.
  {
    heading: "",
    items: [{ id: "settings", label: "Settings", available: true }],
  },
];

/** Tabs that should redirect to dashboard if disabled while active. */
const FEATURE_TAB_TO_KEY: Partial<Record<Tab, keyof Features>> = {
  news: "news",
  mcps: "mcps",
  skills: "skills",
  memory: "memory",
  projects: "projects",
  gaming: "gaming",
  plans: "plans",
  "self-improve": "self_improve",
  personal: "personal",
  // hooks: gating moved inside System tab — no top-level redirect needed.
};

type Props = {
  active: Tab;
  onSelect: (t: Tab) => void;
  globalStatus: GlobalStatus;
};

export function Sidebar({ active, onSelect, globalStatus }: Props) {
  const { features, refresh } = useFeatures();
  const [showFeaturesModal, setShowFeaturesModal] = useState(false);

  // If the user disables the currently-active tab (via the modal or by
  // editing features.json on disk), bounce them to the dashboard so we
  // never render a component the user just declared off-limits.
  useEffect(() => {
    const key = FEATURE_TAB_TO_KEY[active];
    if (key && features[key] === false) {
      onSelect("dashboard");
    }
  }, [active, features, onSelect]);

  return (
    <aside
      className="flex w-56 shrink-0 flex-col border-r"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
      }}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div
          className="flex h-6 w-6 items-center justify-center rounded text-[11px] font-semibold"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          U
        </div>
        <div className="text-[13px] font-medium leading-none">ULTRON</div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {SECTIONS.map((section, si) => {
          const visibleItems = section.items
            .filter((item) => item.available)
            .filter(
              (item) => !item.featureKey || features[item.featureKey] !== false,
            );
          if (visibleItems.length === 0) return null;
          return (
            <div key={si} className="mb-4">
              {section.heading && (
                <div
                  className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {section.heading}
                </div>
              )}
              <div className="space-y-px">
                {visibleItems.map((item) => {
                  const isActive = active === item.id;
                  const dim = false;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={dim}
                      onClick={() => item.available && onSelect(item.id)}
                      className="flex w-full items-center justify-between rounded px-2 py-1 text-[13px] transition-colors"
                      style={{
                        background: isActive ? "var(--color-surface-3)" : "transparent",
                        color: isActive
                          ? "var(--color-text)"
                          : dim
                            ? "var(--color-text-faint)"
                            : "var(--color-text-secondary)",
                        cursor: dim ? "default" : "pointer",
                      }}
                      onMouseEnter={(e) => {
                        if (!dim && !isActive)
                          (e.currentTarget as HTMLButtonElement).style.background =
                            "var(--color-surface-2)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive)
                          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                      }}
                    >
                      <span>{item.label}</span>
                      {dim && (
                        <span
                          className="text-[10px]"
                          style={{ color: "var(--color-text-faint)" }}
                        >
                          soon
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Features toggle entry — sits below the last section so it's
            visible but unobtrusive. */}
        <div className="mb-2">
          <button
            type="button"
            onClick={() => setShowFeaturesModal(true)}
            className="flex w-full items-center justify-between rounded px-2 py-1 text-[13px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--color-surface-2)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <span>Features</span>
          </button>
        </div>
      </nav>

      {/* Status footer */}
      <div
        className="flex items-center gap-2 border-t px-4 py-3 text-[11px]"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: statusColor(globalStatus) }}
        />
        <span style={{ color: "var(--color-text-secondary)" }}>
          {statusLabel(globalStatus)}
        </span>
      </div>

      {showFeaturesModal && (
        <FeaturesModal
          features={features}
          onClose={() => setShowFeaturesModal(false)}
          onChanged={refresh}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Features modal
// ---------------------------------------------------------------------------

const FEATURE_LABELS: Record<keyof Features, string> = {
  news: "News",
  gaming: "Gaming",
  personal: "Personal",
  schedules: "Schedules",
  self_improve: "Stats / Self-improve",
  memory: "Memory",
  plans: "Plans",
  projects: "Projects",
  mcps: "MCPs",
  skills: "Skills",
  hooks: "Hooks",
};

type FeaturesModalProps = {
  features: Features;
  onClose: () => void;
  onChanged: () => void;
};

function FeaturesModal({ features, onClose, onChanged }: FeaturesModalProps) {
  const [local, setLocal] = useState<Features>(features);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(key: keyof Features) {
    const next: Features = { ...local, [key]: !local[key] };
    setLocal(next);
    setSaving(true);
    setErr(null);
    try {
      await saveFeatures(next);
      onChanged();
    } catch (e) {
      setErr(String(e));
      // Roll back the optimistic flip on failure.
      setLocal(local);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="w-[360px] rounded-md border p-4 shadow-lg"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[14px] font-semibold">Features</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Close
          </button>
        </div>
        <div className="mb-3 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          Disabled features are hidden from the sidebar. Stored at
          <br />
          <code>~/.ultron/cockpit/features.json</code>
        </div>
        <div className="space-y-1">
          {FEATURE_KEYS.map((key) => (
            <label
              key={key}
              className="flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-[13px]"
              style={{ background: "var(--color-surface-2)" }}
            >
              <span>{FEATURE_LABELS[key]}</span>
              <input
                type="checkbox"
                checked={local[key]}
                disabled={saving}
                onChange={() => toggle(key)}
              />
            </label>
          ))}
        </div>
        {err && (
          <div
            className="mt-3 rounded border px-2 py-1 text-[11px]"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-danger, #f88)",
            }}
          >
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
