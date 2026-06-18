// Apps panel — Library-style cartillas (one per category) with horizontal,
// large-typography rows. Replaces the old dense grid layout.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { InstalledApp, InstalledAppsReport } from "../../../types";
import {
  type AppCategory,
  type CategoryOverrides,
  CATEGORY_ORDER,
  loadOverrides,
  saveOverrides,
  appId,
} from "./types";
import {
  classifyApp,
  enhancedClassifyApp,
  classifyAppList,
} from "./app-classifiers";
import { CategoryCard } from "./CategoryCard";
import { UninstallModal } from "./UninstallModal";

export function AppsPanel() {
  const [report, setReport] = useState<InstalledAppsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pendingUninstall, setPendingUninstall] = useState<InstalledApp | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<CategoryOverrides>(() => loadOverrides());
  const [categorizing, setCategorizing] = useState(false);

  // Persist overrides on every change.
  useEffect(() => {
    saveOverrides(overrides);
  }, [overrides]);

  function setOverride(app: InstalledApp, next: AppCategory | null) {
    const id = appId(app);
    setOverrides((prev) => {
      const out = { ...prev };
      if (next === null) {
        delete out[id];
      } else {
        out[id] = next;
      }
      return out;
    });
  }

  const autoCategorize = useCallback(async (apps: InstalledApp[]) => {
    if (apps.length === 0) return;
    setCategorizing(true);
    setActionMsg("Auto-categorize: calling AI Router…");

    // Build the items list for the backend.
    const items = apps.map((a) => ({ name: a.name, publisher: a.publisher ?? null }));

    let aiMap: Record<string, string> = {};
    try {
      aiMap = (await invoke("categorize_apps_with_ai", { items })) as Record<string, string>;
    } catch (e) {
      // AI Router unavailable — fall through to heuristic fallback below.
      console.warn("[auto-categorize] AI call failed, using heuristic:", e);
    }

    let changed = 0;
    setOverrides((prev) => {
      const out = { ...prev };
      for (const a of apps) {
        const id = appId(a);
        // AI result takes priority; fall back to the enhanced heuristic.
        const aiCat = aiMap[a.name] as AppCategory | undefined;
        const heuristicCat = enhancedClassifyApp(a);
        const chosen = aiCat ?? heuristicCat;
        const cheapCat = classifyApp(a);
        // Only write an override when the chosen category differs from the
        // cheap baseline (avoids polluting the overrides map with no-ops).
        if (chosen !== cheapCat || out[id]) {
          if (out[id] !== chosen) changed += 1;
          out[id] = chosen;
        }
      }
      return out;
    });

    const src = Object.keys(aiMap).length > 0 ? "AI Router" : "heuristic fallback";
    setActionMsg(
      changed === 0
        ? `Auto-categorize (${src}): no changes — categories already correct.`
        : `Auto-categorize (${src}): updated ${changed} app${changed === 1 ? "" : "s"}.`,
    );
    setCategorizing(false);
  }, []);

  function clearOverrides() {
    setOverrides({});
    setActionMsg("Cleared all manual category overrides.");
  }

  // Hide Windows / OEM noise by default — same heuristic as v2.7 but kept
  // smaller now that the redesign emphasises real apps.
  const [hideSystem, setHideSystem] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("system.apps.hideSystem");
      return v === null ? true : v === "true";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("system.apps.hideSystem", String(hideSystem));
    } catch {
      /* ignore */
    }
  }, [hideSystem]);

  async function load(force: boolean) {
    setLoading(true);
    setError(null);
    try {
      const r = (await invoke("list_installed_apps", { force })) as InstalledAppsReport;
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
  }, []);

  const filtered = useMemo(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.apps.filter((a) => {
      if (hideSystem) {
        const pid = (a.package_id || "").toLowerCase();
        const publisher = (a.publisher || "").toLowerCase();
        const installLoc = (a.install_location || "").toLowerCase();
        const name = a.name || "";
        const nameLower = name.toLowerCase();
        const isStore = a.provider === "store";

        const isMicrosoftStorePkg =
          pid.startsWith("microsoft.") ||
          pid.startsWith("microsoftcorporationii.") ||
          pid.startsWith("microsoftwindows.") ||
          pid.startsWith("windows.") ||
          (isStore && publisher.includes("microsoft corporation"));

        const isWindowsInstallPath =
          installLoc.includes("\\windows\\system") ||
          installLoc.includes("c:\\windows\\") ||
          installLoc.includes("\\windowsapps\\") ||
          installLoc.includes("\\microsoft\\windowsapps\\");

        const isMicrosoftRuntime =
          /^microsoft visual c\+\+ /i.test(name) ||
          /^microsoft \.net /i.test(name) ||
          /^update for microsoft/i.test(name) ||
          /^security update for/i.test(name) ||
          /\(kb\d{6,}\)/i.test(name) ||
          /^kb\d{6,}\b/i.test(name) ||
          nameLower.includes("redistributable") ||
          nameLower.includes(" runtime");

        const isMicrosoftWindowsComponent =
          publisher.includes("microsoft corporation") &&
          (/\bwindows\b/i.test(name) ||
            /\boffice\b/i.test(name) ||
            /\bonedrive\b/i.test(name) ||
            /\bteams\b/i.test(name) ||
            /\bedge\b/i.test(name) ||
            /\bdefender\b/i.test(name) ||
            /\bonenote\b/i.test(name));

        const isHardwareDriverPublisher =
          publisher.includes("intel corporation") ||
          publisher.includes("nvidia corporation") ||
          publisher.includes("realtek semiconductor") ||
          publisher.includes("advanced micro devices") ||
          /\bamd\b/i.test(publisher) ||
          publisher.includes("synaptics") ||
          publisher.includes("conexant");

        if (
          isMicrosoftStorePkg ||
          isWindowsInstallPath ||
          isMicrosoftRuntime ||
          isMicrosoftWindowsComponent ||
          isHardwareDriverPublisher
        ) {
          return false;
        }
      }
      if (!q) return true;
      const hay = `${a.name} ${a.publisher || ""} ${a.package_id || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [report, query, hideSystem]);

  const grouped = useMemo(
    () => classifyAppList(filtered, overrides),
    [filtered, overrides],
  );

  const overrideCount = Object.keys(overrides).length;

  async function handleOpenFolder(app: InstalledApp) {
    if (!app.install_location) return;
    setActionMsg(null);
    try {
      await invoke("open_app_folder", { installLocation: app.install_location });
      setActionMsg(`Opened ${app.install_location}`);
    } catch (e) {
      setActionMsg(`Failed to open folder: ${e}`);
    }
  }

  return (
    <section className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by name, publisher, id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-[260px] flex-1 rounded px-3 py-2 text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        />
        <button
          type="button"
          onClick={() => setHideSystem((v) => !v)}
          className="rounded px-3 py-2 text-[12.5px] font-medium transition-colors"
          style={{
            background: hideSystem ? "var(--color-surface-3)" : "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
            color: hideSystem ? "var(--color-text)" : "var(--color-text-tertiary)",
          }}
          title="Hide Microsoft Store + driver / runtime packages"
        >
          {hideSystem ? "Hiding system" : "Show system"}
        </button>
        <button
          type="button"
          onClick={() => { void autoCategorize(filtered); }}
          disabled={loading || filtered.length === 0 || categorizing}
          className="rounded px-3 py-2 text-[12.5px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Re-classify the currently visible apps using AI (falls back to heuristic if AI Router is unavailable)."
        >
          {categorizing ? "Categorizing…" : "Auto-categorize"}
        </button>
        <button
          type="button"
          onClick={clearOverrides}
          disabled={overrideCount === 0}
          className="rounded px-3 py-2 text-[12.5px] font-medium transition-colors disabled:opacity-30"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border)",
          }}
          title={
            overrideCount === 0
              ? "No overrides to clear"
              : `Clear ${overrideCount} manual override${overrideCount === 1 ? "" : "s"}`
          }
        >
          Reset categories{overrideCount > 0 ? ` (${overrideCount})` : ""}
        </button>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="rounded px-3 py-2 text-[12.5px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {loading ? "Scanning…" : "Refresh"}
        </button>
      </div>

      {report?.cached && (
        <div className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Cached snapshot from {report.generated_at} — hit Refresh to re-scan.
        </div>
      )}

      {error && (
        <div
          className="rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {actionMsg && (
        <div
          className="rounded p-2 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {actionMsg}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {report?.apps.length
            ? "No apps match the current filter."
            : "No installed apps detected."}
        </div>
      )}

      <div className="space-y-3">
        {CATEGORY_ORDER.map((cat) => {
          const apps = grouped.get(cat) ?? [];
          return (
            <CategoryCard
              key={cat}
              category={cat}
              apps={apps}
              defaultOpen={cat !== "System utilities" && cat !== "Other"}
              overrides={overrides}
              onOpenFolder={handleOpenFolder}
              onUninstall={setPendingUninstall}
              onChangeCategory={setOverride}
            />
          );
        })}
      </div>

      {pendingUninstall && (
        <UninstallModal
          appInfo={pendingUninstall}
          onClose={() => setPendingUninstall(null)}
          onDone={(r) => {
            setActionMsg(
              r.success
                ? `Uninstalled ${pendingUninstall.name}.`
                : `Uninstall failed (exit ${r.exit_code ?? "?"}): ${
                    r.stderr || r.stdout || "unknown error"
                  }`,
            );
            load(true);
          }}
        />
      )}
    </section>
  );
}
