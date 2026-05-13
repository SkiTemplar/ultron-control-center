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
import { computeGlobalStatus } from "./lib/status";
import type { QdrantHealth, AlertEntry, ChangelogEntry } from "./types";

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [qdrant, setQdrant] = useState<QdrantHealth | null>(null);
  const [qdrantErr, setQdrantErr] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);

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

  const globalStatus = computeGlobalStatus(qdrant, qdrantErr, alerts);

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
      </main>
    </div>
  );
}
