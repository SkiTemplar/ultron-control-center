import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirmDialog } from "./lib/dialog";
import { notify } from "./lib/notify";
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
import { News } from "./components/News";
import { Personal } from "./components/Personal";
import { Plans } from "./components/Plans";
import { PopupHost } from "./components/PopupHost";
import { SelfImprove } from "./components/SelfImprove";
// Hooks is now rendered inside the System tab as an inner sub-tab (v15.2 F7).
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { UpdateBanner } from "./components/UpdateBanner";
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

  // Capture frontend errors and surface them app-wide. Without this, JS
  // exceptions / unhandled rejections die silently in the webview and the
  // user has no idea something broke. `notify()` both pops an immediate
  // in-app toast and records the error to alerts.jsonl so the
  // Notifications tab keeps a durable copy.
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
      notify({ severity, source, message: trimmed });
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
    // review audit v15.5.4: a cancelled flag closes the race between
    // unmount and the listen() promise resolving. Without it, React
    // StrictMode (or any quick remount) leaves a listener attached to
    // the Tauri event bus forever.
    let cancelled = false;
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
      if (cancelled) {
        // Listener registered after the component already unmounted —
        // detach immediately so it doesn't outlive the host.
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
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

  // v15.3.7 — Command palette gets the full ULTRON system surface.
  // Maintenance commands are pulled dynamically from the backend so the
  // palette stays in sync with whatever `list_maintenance_commands_inner`
  // returns (no hardcoded duplicate list). Everything else is static.
  type MaintenanceCommand = {
    kind: string;
    label: string;
    description: string;
    group: string;
  };
  const [maintenanceCommands, setMaintenanceCommands] = useState<
    MaintenanceCommand[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = (await invoke(
          "list_maintenance_commands",
        )) as MaintenanceCommand[];
        if (!cancelled) setMaintenanceCommands(list ?? []);
      } catch (err) {
        console.warn("[ultron] list_maintenance_commands failed", err);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Helper: fire-and-forget invoke that surfaces failures via notify() —
  // an immediate in-app toast (so the user knows the command broke right
  // away, on any tab) plus a durable row in the Notifications tab. Before
  // notify(), a failed palette command only landed in alerts.jsonl and
  // the user just saw "nothing happened".
  async function runQuiet(label: string, cmd: string, args?: Record<string, unknown>) {
    try {
      await invoke(cmd, args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify({
        severity: "warn",
        source: "palette",
        message: `${label} failed: ${msg}`.slice(0, 600),
      });
    }
  }

  const extraPaletteActions: PaletteAction[] = useMemo(() => {
    const list: PaletteAction[] = [];

    // -- Actions (refresh / settings / close) -------------------------
    list.push({
      id: "refresh",
      label: "Refresh dashboard data",
      description: "Re-pull Qdrant health, alerts, and changelog.",
      group: "Actions",
      shortcut: "Ctrl+R",
      run: () => void refreshAll(),
    });
    list.push({
      id: "settings",
      label: "Open Settings",
      group: "Actions",
      shortcut: "Ctrl+,",
      run: () => setTab("settings"),
    });
    list.push({
      id: "close-control-center",
      label: "Close Control Center",
      description: "Fully exit the app (not minimize to tray). Frees file locks.",
      group: "Actions",
      run: async () => {
        const ok = await confirmDialog(
          "Close ULTRON Control Center? Global hotkeys stop until you relaunch.",
          { title: "Close Control Center", kind: "warning" },
        );
        if (ok) void runQuiet("Close Control Center", "close_control_center");
      },
    });

    // -- Diagnostics --------------------------------------------------
    list.push({
      id: "diag.full",
      label: "Run Full Diagnostic",
      description: "All-systems sweep — Qdrant, MCPs, skills, agents, backups.",
      group: "Diagnostics",
      run: () => void runQuiet("Full Diagnostic", "run_full_diagnostic"),
    });
    list.push({
      id: "diag.pending",
      label: "Detect Pending Items",
      description: "Run detect_gaps.py — surfaces stale TODOs, missing files, drift.",
      group: "Diagnostics",
      run: () => void runQuiet("Detect Pending", "run_detect_gaps"),
    });
    list.push({
      id: "diag.doctor",
      label: "Run Doctor",
      description: "Enhanced doctor script — read-only system health report.",
      group: "Diagnostics",
      run: () => void runQuiet("Doctor", "run_doctor"),
    });
    list.push({
      id: "diag.diagnose",
      label: "Run PC Diagnose (last 24h)",
      description: "system_diagnose — Windows event log + process snapshot.",
      group: "Diagnostics",
      run: () => void runQuiet("Diagnose", "run_diagnose", { hours: 24 }),
    });
    list.push({
      id: "diag.adversarial",
      label: "Codex Adversarial Review",
      description: "Run /codex:adversarial-review against the current session.",
      group: "Diagnostics",
      run: () =>
        void runQuiet("Codex Adversarial Review", "run_codex_adversarial_review"),
    });
    list.push({
      id: "diag.self-improve",
      label: "Self-Improve Report",
      description: "Routing telemetry · skill usage · recent errors snapshot.",
      group: "Diagnostics",
      run: () => void runQuiet("Self-Improve Report", "self_improve_report"),
    });

    // -- AI sessions --------------------------------------------------
    list.push({
      id: "ai.spawn.claude",
      label: "Spawn Claude session",
      description: "Open a new Claude Code terminal (clipboard prompt mode).",
      group: "AI",
      run: () =>
        void runQuiet("Spawn Claude", "spawn_session", {
          provider: "claude",
          prompt: null,
        }),
    });
    list.push({
      id: "ai.spawn.codex",
      label: "Spawn Codex session",
      description: "Launch the Codex CLI (ChatGPT subscription auth).",
      group: "AI",
      run: () =>
        void runQuiet("Spawn Codex", "spawn_session", {
          provider: "codex",
          prompt: null,
        }),
    });
    list.push({
      id: "ai.spawn.gemini",
      label: "Spawn Gemini session",
      description: "Launch the Gemini CLI (Google OAuth, long-context).",
      group: "AI",
      run: () =>
        void runQuiet("Spawn Gemini", "spawn_session", {
          provider: "gemini",
          prompt: null,
        }),
    });

    // -- Maintenance (pulled dynamically from the backend) ------------
    // The backend's `list_maintenance_commands_inner` is the source of
    // truth. Whenever a new MaintenanceCommand is added there it shows
    // up here automatically — no duplicate frontend list to keep in sync.
    for (const m of maintenanceCommands) {
      list.push({
        id: `maint.${m.kind}`,
        label: m.label,
        description: m.description,
        group: `Maintenance (${m.group})`,
        run: () =>
          void runQuiet(m.label, "run_maintenance_command", { kind: m.kind }),
      });
    }

    // -- Memory actions (separate from maintenance because they call a
    //    different backend command — memory_action, not run_maintenance_command)
    list.push({
      id: "mem.qdrant-reembed",
      label: "Qdrant re-embed vault",
      description: "Re-vectorize ~/.ultron-vault notes into Qdrant.",
      group: "Memory",
      run: () =>
        void runQuiet("Qdrant re-embed", "memory_action", {
          action: "qdrant-reembed",
        }),
    });
    list.push({
      id: "mem.skills-reembed",
      label: "Embed skills index",
      description: "Re-embed installed skills metadata for semantic recall.",
      group: "Memory",
      run: () =>
        void runQuiet("Skills re-embed", "memory_action", {
          action: "skills-reembed",
        }),
    });

    // -- System / lifecycle ------------------------------------------
    list.push({
      id: "sys.rebuild",
      label: "Rebuild Control Center",
      description: "Spawn `npm run tauri build` in a new window.",
      group: "System",
      run: () =>
        void runQuiet("Rebuild", "run_app_lifecycle", { kind: "update" }),
    });
    list.push({
      id: "sys.uninstall",
      label: "Uninstall ULTRON",
      description: "Run the uninstall script in a new window (asks for confirmation).",
      group: "System",
      run: async () => {
        const ok = await confirmDialog(
          "Open the uninstaller? This walks you through removing ULTRON.",
          { title: "Uninstall ULTRON", kind: "warning" },
        );
        if (ok)
          void runQuiet("Uninstall", "run_app_lifecycle", { kind: "uninstall" });
      },
    });
    list.push({
      id: "sys.reset-mode",
      label: "Reset ULTRON mode to autodetect",
      description: "Forget the pinned LOW/MEDIUM/HIGH/ULTRA override.",
      group: "System",
      run: () => void runQuiet("Reset mode", "reset_mode_to_autodetect"),
    });
    list.push({
      id: "sys.purge-autostart",
      label: "Purge legacy autostart entries",
      description: "Remove stale Run-key / Startup shim left by older installs.",
      group: "System",
      run: () => void runQuiet("Purge autostart", "purge_legacy_autostart"),
    });
    list.push({
      id: "sys.scan-projects",
      label: "Scan projects",
      description: "Re-scan project folders so the launcher picks up new entries.",
      group: "System",
      run: () => void runQuiet("Scan projects", "scan_projects"),
    });

    // -- News --------------------------------------------------------
    list.push({
      id: "news.generate",
      label: "Generate news brief",
      description: "Kick off the ULTRON Times generator (HTML newsletter).",
      group: "News",
      run: () => void runQuiet("Generate news", "generate_news"),
    });

    return list;
  }, [maintenanceCommands]);

  return (
    <div className="flex h-full">
      <Sidebar active={tab} onSelect={setTab} globalStatus={globalStatus} />
      <main className="flex-1 overflow-auto">
        <UpdateBanner />
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
      <PopupHost />
    </div>
  );
}
