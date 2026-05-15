import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar, type Tab } from "./components/Sidebar";
import { Dashboard } from "./components/Dashboard";
import { Changelog } from "./components/Changelog";
import { Notifications } from "./components/Notifications";
import { MCPs } from "./components/MCPs";
import { Skills } from "./components/Skills";
import { Memory } from "./components/Memory";
import { Sessions } from "./components/Sessions";
import { Usage } from "./components/Usage";
import { Settings } from "./components/Settings";
import { Projects } from "./components/Projects";
import { System } from "./components/System";
import { Gaming } from "./components/Gaming";
import { News } from "./components/News";
import { Plans } from "./components/Plans";
import { SelfImprove } from "./components/SelfImprove";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { computeGlobalStatus } from "./lib/status";
import type { QdrantHealth, AlertEntry, ChangelogEntry } from "./types";

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [qdrant, setQdrant] = useState<QdrantHealth | null>(null);
  const [qdrantErr, setQdrantErr] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);

  async function refreshAll() {
    try {
      const h = (await invoke("qdrant_health")) as QdrantHealth;
      setQdrant(h);
      setQdrantErr(null);
    } catch (e) {
      setQdrantErr(String(e));
      setQdrant(null);
    }
    try {
      const al = (await invoke("read_alerts", { limit: 200 })) as AlertEntry[];
      setAlerts(al);
    } catch {
      setAlerts([]);
    }
    try {
      const cl = (await invoke("read_changelog", { limit: 100 })) as ChangelogEntry[];
      setChangelog(cl);
    } catch {
      setChangelog([]);
    }
  }

  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 15_000);
    return () => clearInterval(t);
  }, []);

  // In-app keyboard shortcuts. The OS-wide Ctrl+Alt+U lives in the Rust
  // setup; the bindings below are window-scoped.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (meta && e.key === "," ) {
        e.preventDefault();
        setTab("settings");
        return;
      }
      if (meta && e.key === "r" && !e.shiftKey) {
        // Refresh top-level state; don't reload the whole webview.
        e.preventDefault();
        refreshAll();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const globalStatus = computeGlobalStatus(qdrant, qdrantErr, alerts);

  const extraPaletteActions: PaletteAction[] = [
    {
      id: "refresh",
      label: "Refresh dashboard data",
      group: "Actions",
      shortcut: "Ctrl+R",
      run: () => refreshAll(),
    },
    {
      id: "settings",
      label: "Open Settings",
      group: "Actions",
      shortcut: "Ctrl+,",
      run: () => setTab("settings"),
    },
  ];

  return (
    <div className="flex h-full">
      <Sidebar active={tab} onSelect={setTab} globalStatus={globalStatus} />
      <main className="flex-1 overflow-auto">
        {tab === "dashboard" && (
          <Dashboard
            qdrant={qdrant}
            qdrantErr={qdrantErr}
            alerts={alerts}
            changelog={changelog}
            globalStatus={globalStatus}
          />
        )}
        {tab === "notifications" && <Notifications alerts={alerts} />}
        {tab === "changelog" && <Changelog entries={changelog} />}
        {tab === "mcps" && <MCPs />}
        {tab === "skills" && <Skills />}
        {tab === "memory" && <Memory />}
        {tab === "sessions" && <Sessions />}
        {tab === "usage" && <Usage />}
        {tab === "settings" && <Settings />}
        {tab === "projects" && <Projects />}
        {tab === "system" && <System />}
        {tab === "gaming" && <Gaming />}
        {tab === "news" && <News />}
        {tab === "plans" && <Plans />}
        {tab === "self-improve" && (
          <div className="px-10 py-8">
            <header className="mb-6">
              <h1 className="text-[20px] font-semibold leading-tight">Stats</h1>
              <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
                Routing telemetry, skill usage, recent errors, adversarial review,
                repo evaluation.
              </p>
            </header>
            <SelfImprove />
          </div>
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(t) => setTab(t)}
        extraActions={extraPaletteActions}
      />
    </div>
  );
}
