// Single horizontal app card. Bigger font, more breathing room than the
// previous dense grid row.

import type { InstalledApp } from "../../../types";
import { type AppCategory, CATEGORY_ORDER } from "./types";
import { classifyApp } from "./app-classifiers";

export function AppCard({
  app,
  currentCategory,
  isManual,
  onOpenFolder,
  onUninstall,
  onChangeCategory,
}: {
  app: InstalledApp;
  currentCategory: AppCategory;
  isManual: boolean;
  onOpenFolder: (a: InstalledApp) => void;
  onUninstall: (a: InstalledApp) => void;
  onChangeCategory: (a: InstalledApp, next: AppCategory | null) => void;
}) {
  const hasFolder = !!app.install_location;
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2.5"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="min-w-0 flex-1">
        <div
          className="flex items-center gap-1.5 truncate text-[13.5px] font-medium"
          style={{ color: "var(--color-text)" }}
          title={app.name}
        >
          <span className="truncate">{app.name}</span>
          {isManual && (
            <span
              className="shrink-0 rounded px-1 py-px text-[10px] font-medium uppercase tracking-wide"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
              title="Category overridden manually (or by Auto-categorize)"
            >
              manual
            </span>
          )}
        </div>
        <div
          className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {app.publisher && <span className="truncate" title={app.publisher}>{app.publisher}</span>}
          {app.version && <span className="tabular-nums">v{app.version}</span>}
          <span className="uppercase tracking-wide" style={{ color: "var(--color-text-faint)" }}>
            {app.provider}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <select
          value={currentCategory}
          onChange={(e) => {
            const next = e.target.value as AppCategory;
            // When the user picks the same bucket the auto-classifier would
            // pick, treat it as a "reset" so we don't pollute the overrides
            // map with redundant entries.
            const auto = classifyApp(app);
            onChangeCategory(app, next === auto && !isManual ? null : next);
          }}
          className="rounded px-1.5 py-1 text-[11.5px] font-medium"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            maxWidth: 140,
          }}
          title="Change category for this app"
        >
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {isManual && (
          <button
            type="button"
            onClick={() => onChangeCategory(app, null)}
            className="rounded px-1.5 py-1 text-[11.5px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-1)",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
            title="Reset to auto-classified category"
          >
            Reset
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpenFolder(app)}
          disabled={!hasFolder}
          className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-30"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title={hasFolder ? app.install_location! : "No install location reported"}
        >
          Folder
        </button>
        <button
          type="button"
          onClick={() => onUninstall(app)}
          className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
          style={{
            background: "rgba(248, 81, 73, 0.10)",
            color: "var(--color-danger)",
            border: "1px solid rgba(248, 81, 73, 0.32)",
          }}
        >
          Uninstall
        </button>
      </div>
    </div>
  );
}
