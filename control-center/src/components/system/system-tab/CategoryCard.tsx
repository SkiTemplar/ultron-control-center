// Category cartilla — collapsible card that holds every app in the bucket.

import { useState } from "react";
import type { InstalledApp } from "../../../types";
import { type AppCategory, type CategoryOverrides, CATEGORY_DESCRIPTIONS } from "./types";
import { appId } from "./types";
import { AppCard } from "./AppCard";

export function CategoryCard({
  category,
  apps,
  defaultOpen,
  overrides,
  onOpenFolder,
  onUninstall,
  onChangeCategory,
}: {
  category: AppCategory;
  apps: InstalledApp[];
  defaultOpen: boolean;
  overrides: CategoryOverrides;
  onOpenFolder: (a: InstalledApp) => void;
  onUninstall: (a: InstalledApp) => void;
  onChangeCategory: (a: InstalledApp, next: AppCategory | null) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (apps.length === 0) return null;
  return (
    <section
      className="overflow-hidden rounded-lg"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors"
        style={{
          background: "var(--color-surface-2)",
          borderBottom: open ? "1px solid var(--color-border)" : "none",
        }}
      >
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
              {category}
            </span>
            <span
              className="tabular-nums text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {apps.length}
            </span>
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            {CATEGORY_DESCRIPTIONS[category]}
          </div>
        </div>
        <span className="shrink-0 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="grid gap-2 p-3 lg:grid-cols-2 2xl:grid-cols-3">
          {apps.map((a) => {
            const id = appId(a);
            return (
              <AppCard
                key={id}
                app={a}
                currentCategory={category}
                isManual={!!overrides[id]}
                onOpenFolder={onOpenFolder}
                onUninstall={onUninstall}
                onChangeCategory={onChangeCategory}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
