import type { GlobalStatus } from "../types";
import { statusColor, statusLabel } from "../lib/status";

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
  | "self-improve"
  | "settings";

type Item = {
  id: Tab;
  label: string;
  available: boolean;
};

const SECTIONS: { heading: string; items: Item[] }[] = [
  {
    heading: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", available: true },
      { id: "usage", label: "Usage", available: true },
      { id: "notifications", label: "Notifications", available: true },
      { id: "changelog", label: "Changelog", available: true },
      { id: "news", label: "News", available: true },
    ],
  },
  {
    heading: "System",
    items: [
      { id: "system", label: "System", available: true },
      { id: "mcps", label: "MCPs", available: true },
      { id: "skills", label: "Skills", available: true },
      { id: "memory", label: "Memory", available: true },
    ],
  },
  {
    heading: "Workspace",
    items: [
      { id: "sessions", label: "Sessions", available: true },
      { id: "projects", label: "Projects", available: true },
      { id: "gaming", label: "Gaming", available: true },
      { id: "plans", label: "Plans", available: true },
      { id: "logs", label: "Logs", available: true },
    ],
  },
  {
    heading: "Meta",
    items: [
      { id: "self-improve", label: "Stats", available: true },
    ],
  },
  {
    heading: "",
    items: [{ id: "settings", label: "Settings", available: true }],
  },
];

type Props = {
  active: Tab;
  onSelect: (t: Tab) => void;
  globalStatus: GlobalStatus;
};

export function Sidebar({ active, onSelect, globalStatus }: Props) {
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
        {SECTIONS.map((section, si) => (
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
              {section.items.map((item) => {
                const isActive = active === item.id;
                const dim = !item.available;
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
        ))}
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
    </aside>
  );
}
