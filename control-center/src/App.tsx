import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Sidebar, type Tab } from "./components/Sidebar";
import { Dashboard } from "./components/Dashboard";
import { Changelog } from "./components/Changelog";
import { Notifications } from "./components/Notifications";
import { MCPs } from "./components/MCPs";
import { Skills } from "./components/Skills";
import { Agents } from "./components/Agents";
import { Memory } from "./components/Memory";
import { Sessions } from "./components/Sessions";
import { Usage } from "./components/Usage";
import { Settings } from "./components/Settings";
import { Projects } from "./components/Projects";
import { System } from "./components/System";
import { Gaming } from "./components/Gaming";
import { Logs } from "./components/Logs";
import { News } from "./components/News";
import { Personal } from "./components/Personal";
import { Plans } from "./components/Plans";
import { SelfImprove } from "./components/SelfImprove";
// Hooks is now rendered inside the System tab as an inner sub-tab (v15.2 F7).
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { computeGlobalStatus } from "./lib/status";
import { setupTrayEventListeners } from "./lib/tauri-events";
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

  // Capture frontend errors and pipe them into alerts.jsonl so the
  // Notifications tab surfaces them alongside backend issues. Without
  // this, JS exceptions / unhandled rejections die silently in the
  // webview and the user has no idea something broke.
  useEffect(() => {
    let lastFingerprint = "";
    let lastTs = 0;
    function report(severity: "warn" | "critical", source: string, message: string) {
      const trimmed = message.slice(0, 600);
      const fingerprint = `${source}::${trimmed}`;
      const now = Date.now();
      // Throttle identical errors — Tauri devtools can chain the same
      // exception multiple times.
      if (fingerprint === lastFingerprint && now - lastTs < 5000) return;
      lastFingerprint = fingerprint;
      lastTs = now;
      invoke("record_ui_alert", { severity, source, message: trimmed }).catch(() => {});
    }
    const onError = (e: ErrorEvent) => {
      const msg = e.message || (e.error && String(e.error)) || "unknown error";
      report("critical", "ui.error", `${msg} @ ${e.filename}:${e.lineno}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      report("warn", "ui.promise", msg);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // In-app keyboard shortcuts. The OS-wide Ctrl+Alt+U lives in the Rust
  // setup; the bindings below are window-scoped. Bindings now live in
  // ~/.ultron/.tmp/in-app-shortcuts.json and are editable via Settings →
  // General → In-app shortcuts. The map below is a runtime mirror we
  // refresh on mount + whenever Settings persists a change (via the
  // "in-app-shortcuts-updated" event the Settings panel emits).
  //
  // Action keys recognised here (must match defaults in the Rust module
  // `in_app_shortcuts::default_bindings`):
  //   command.palette · open.settings · refresh.all
  //   tab.<dashboard|usage|notifications|sessions|projects|plans|memory|skills|logs|settings>
  const bindingsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const map = (await invoke("get_in_app_shortcuts")) as Record<
          string,
          string
        >;
        if (!cancelled) bindingsRef.current = map ?? {};
      } catch (err) {
        console.warn("[ultron] get_in_app_shortcuts failed", err);
      }
    }
    void load();
    const handler = () => void load();
    window.addEventListener("in-app-shortcuts-updated", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("in-app-shortcuts-updated", handler);
    };
  }, []);

  useEffect(() => {
    const teardownPromise = setupTrayEventListeners({ setTab });
    return () => {
      teardownPromise.then((teardown) => teardown());
    };
  }, []);

  // Custom per-project hotkeys (defined in Settings → Project hotkeys).
  // Backend emits "project-hotkey-custom" with { slot, project_id, combo }.
  // Behaviour: open Control Center on the Projects tab, then invoke
  // open_project so the user lands on the configured project ready to go.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<{ slot: number; project_id: string; combo: string }>(
      "project-hotkey-custom",
      async (event) => {
        const pid = event.payload?.project_id;
        if (!pid) return;
        setTab("projects");
        try {
          await invoke("open_project", { id: pid });
        } catch (err) {
          console.error("[ultron] custom project hotkey open_project failed", err);
        }
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    // Parse a stored combo string ("Ctrl+Alt+K", "Alt+1", ...) into a
    // predicate against a KeyboardEvent. Returns null when the combo is
    // unparseable so it's silently ignored rather than throwing.
    function matchCombo(combo: string, e: KeyboardEvent): boolean {
      const parts = combo
        .split("+")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
      if (parts.length === 0) return false;
      let needCtrl = false;
      let needAlt = false;
      let needShift = false;
      let needMeta = false;
      let keyPart: string | null = null;
      for (const p of parts) {
        if (p === "ctrl" || p === "control") needCtrl = true;
        else if (p === "alt" || p === "option") needAlt = true;
        else if (p === "shift") needShift = true;
        else if (p === "meta" || p === "super" || p === "win" || p === "cmd")
          needMeta = true;
        else keyPart = p;
      }
      if (!keyPart) return false;
      if (e.ctrlKey !== needCtrl) return false;
      if (e.altKey !== needAlt) return false;
      if (e.shiftKey !== needShift) return false;
      if (e.metaKey !== needMeta) return false;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
      return k === keyPart;
    }

    function isTypingTarget(active: Element | null): boolean {
      const tag = active?.tagName?.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        (active as HTMLElement | null)?.isContentEditable === true
      );
    }

    function onKey(e: KeyboardEvent) {
      const b = bindingsRef.current;
      if (!b || Object.keys(b).length === 0) return;

      // Palette / settings / refresh — always active, even inside inputs
      // because the historical behaviour was Ctrl+K etc. swallows the
      // input chord anyway.
      if (b["command.palette"] && matchCombo(b["command.palette"], e)) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (b["open.settings"] && matchCombo(b["open.settings"], e)) {
        e.preventDefault();
        setTab("settings");
        return;
      }
      if (b["refresh.all"] && matchCombo(b["refresh.all"], e)) {
        e.preventDefault();
        refreshAll();
        return;
      }

      // Tab jumps — suppressed while typing so they don't eat keystrokes.
      if (isTypingTarget(document.activeElement)) return;

      const TAB_ACTIONS: [string, Tab][] = [
        ["tab.dashboard", "dashboard"],
        ["tab.usage", "usage"],
        ["tab.notifications", "notifications"],
        ["tab.sessions", "sessions"],
        ["tab.projects", "projects"],
        ["tab.plans", "plans"],
        ["tab.memory", "memory"],
        ["tab.skills", "skills"],
        ["tab.logs", "logs"],
        ["tab.settings", "settings"],
      ];
      for (const [actionKey, tabKey] of TAB_ACTIONS) {
        const combo = b[actionKey];
        if (combo && matchCombo(combo, e)) {
          e.preventDefault();
          setTab(tabKey);
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        {tab === "notifications" && (
          <Notifications alerts={alerts} onDeleted={refreshAll} />
        )}
        {tab === "changelog" && <Changelog entries={changelog} />}
        {tab === "mcps" && <MCPs />}
        {tab === "skills" && <Skills />}
        {tab === "agents" && <Agents />}
        {tab === "memory" && <Memory />}
        {tab === "sessions" && <Sessions />}
        {tab === "usage" && <Usage />}
        {tab === "settings" && <Settings />}
        {tab === "projects" && <Projects />}
        {tab === "system" && <System />}
        {tab === "gaming" && <Gaming />}
        {tab === "news" && <News />}
        {tab === "plans" && <Plans />}
        {tab === "logs" && <Logs />}
        {tab === "personal" && <Personal />}
        {/* "hooks" tab removed — Hooks now lives inside the System tab as
            an inner sub-tab. The Tab union no longer includes "hooks". */}
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
