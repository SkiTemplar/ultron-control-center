// Control Center 2.7 — Diagnostics & Fixes (merged Diagnostics + Troubleshooting).
//
// USER: "Diagnostics mezclar con Troubleshooting con decenas de soluciones
// dependiendo del problema, no es necesario top procesos, ni disco, ni
// sistema ni network, (app health si), sólo necesito errores -> parser de
// errores mediante scripts -> Decenas de soluciones en formato de botones."
//
// This tab now shows ONLY:
//   1. App health (Claude / Codex / Gemini CLI / mem0 / projects.json)
//   2. Event-log parser surfacing recent Critical / Error rows
//   3. Per-row "Suggested fixes" — buttons mapped from the Event ID to one or
//      more entries in the FIX_CATALOG (each fix calls run_maintenance_command).
//
// Dropped (per USER's audit): Top processes, Disk stats, System metrics,
// Network latency probe. The full native diagnostic still runs for app
// health, but its non-app sections are no longer rendered.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticReport } from "../../types";
import { Markdown } from "../../lib/markdown";
import { DiagnosticHistoryPanel } from "./DiagnosticHistoryPanel";
import { DiagnosticSchedulePanel } from "./DiagnosticSchedulePanel";
import { confirmDialog } from "../../lib/dialog";

// ---------------------------------------------------------------------------
// Event Log types — mirror src-tauri/src/commands/event_log.rs.
// ---------------------------------------------------------------------------

type EventLogLevel =
  | "critical"
  | "error"
  | "warning"
  | "information"
  | "verbose"
  | "unknown";

interface EventLogEntry {
  event_id: number;
  source: string;
  log_name: string;
  level: EventLogLevel;
  time_created: string;
  message: string;
}

interface MaintenanceResult {
  kind: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  elapsed_ms: number;
}

// ---------------------------------------------------------------------------
// FIX_CATALOG — every "solution button" the UI knows how to render. Keyed by
// the `kind` token the backend dispatcher understands.
// ---------------------------------------------------------------------------

/**
 * Logical grouping for the Toolbox grid. Order here is the order shown.
 */
type FixCategory =
  | "network"
  | "services"
  | "update"
  | "storage"
  | "shell"
  | "diagnostic"
  | "system";

interface Fix {
  /** Backend kind token; must match maintenance.rs::resolve_command. */
  kind: string;
  /** Short button label. */
  label: string;
  /** One-line tooltip / description. */
  detail: string;
  /** Logical group for the Toolbox grid. */
  category: FixCategory;
  /** Optional confirm dialog before executing. */
  confirm?: { title: string; message: string };
}

const FIX_CATALOG: Record<string, Fix> = {
  // ---- network ----
  "pc-flush-dns": {
    kind: "pc-flush-dns",
    label: "Flush DNS",
    detail: "ipconfig /flushdns — clears the local DNS resolver cache.",
    category: "network",
  },
  "pc-renew-ip": {
    kind: "pc-renew-ip",
    label: "Renew IP",
    detail: "ipconfig /release && /renew — releases and re-acquires the DHCP lease.",
    category: "network",
  },
  "pc-reset-network": {
    kind: "pc-reset-network",
    label: "Reset TCP/IP",
    detail: "netsh int ip reset — resets the Windows TCP/IP stack. Reboot recommended.",
    category: "network",
    confirm: {
      title: "Reset TCP/IP stack?",
      message:
        "Drops your current connection and a reboot is recommended afterwards. Continue?",
    },
  },
  "pc-winsock-reset": {
    kind: "pc-winsock-reset",
    label: "Reset Winsock",
    detail: "netsh winsock reset — restores Winsock catalog to default. Reboot recommended.",
    category: "network",
    confirm: {
      title: "Reset Winsock?",
      message: "Some third-party LSPs may need to be re-registered. Continue?",
    },
  },
  "pc-reset-firewall": {
    kind: "pc-reset-firewall",
    label: "Reset firewall",
    detail: "netsh advfirewall reset — restores Windows Firewall to defaults.",
    category: "network",
    confirm: {
      title: "Reset Windows Firewall?",
      message: "Removes all custom inbound/outbound rules. Continue?",
    },
  },
  "pc-flush-arp": {
    kind: "pc-flush-arp",
    label: "Flush ARP cache",
    detail: "netsh interface ip delete arpcache — clears the local ARP table.",
    category: "network",
  },
  "pc-net-reset-all": {
    kind: "pc-net-reset-all",
    label: "Full network reset",
    detail:
      "release + flushdns + renew + winsock reset + TCP/IP reset, in that order. Reboot recommended.",
    category: "network",
    confirm: {
      title: "Run full network reset?",
      message:
        "Releases DHCP, flushes DNS, renews IP, then resets Winsock and TCP/IP. A reboot is recommended afterwards. Continue?",
    },
  },
  "pc-network-troubleshooter": {
    kind: "pc-network-troubleshooter",
    label: "Network troubleshooter",
    detail: "Launches the Windows built-in Network Adapter Diagnostic wizard.",
    category: "network",
  },
  "pc-network-connections": {
    kind: "pc-network-connections",
    label: "Network connections",
    detail: "Opens ncpa.cpl — classic adapter list.",
    category: "network",
  },
  "pc-open-hosts": {
    kind: "pc-open-hosts",
    label: "Open hosts file",
    detail: "Opens C:\\Windows\\System32\\drivers\\etc\\hosts in Notepad.",
    category: "network",
  },

  // ---- services ----
  "pc-restart-spooler": {
    kind: "pc-restart-spooler",
    label: "Restart Print Spooler",
    detail: "Restart-Service Spooler — fixes hung print queue / spooler crashes.",
    category: "services",
  },
  "pc-restart-audio": {
    kind: "pc-restart-audio",
    label: "Restart Audio service",
    detail: "Restart-Service Audiosrv + AudioEndpointBuilder.",
    category: "services",
  },
  "pc-restart-bluetooth": {
    kind: "pc-restart-bluetooth",
    label: "Restart Bluetooth",
    detail: "Restart-Service bthserv — Bluetooth Support service.",
    category: "services",
  },
  "pc-restart-wsearch": {
    kind: "pc-restart-wsearch",
    label: "Restart Windows Search",
    detail: "Restart-Service WSearch — fixes broken Start menu search.",
    category: "services",
  },
  "pc-restart-bits": {
    kind: "pc-restart-bits",
    label: "Restart BITS",
    detail: "Restart-Service BITS — Background Intelligent Transfer Service.",
    category: "services",
  },
  "pc-restart-wuauserv": {
    kind: "pc-restart-wuauserv",
    label: "Restart Update service",
    detail: "Restart-Service wuauserv — Windows Update service.",
    category: "services",
  },
  "pc-restart-time": {
    kind: "pc-restart-time",
    label: "Restart Time service",
    detail: "Restart-Service w32time + w32tm /resync — fixes clock skew.",
    category: "services",
  },
  "pc-services-mmc": {
    kind: "pc-services-mmc",
    label: "Open services.msc",
    detail: "Launches the Services management console.",
    category: "services",
  },

  // ---- update ----
  "pc-repair-wu": {
    kind: "pc-repair-wu",
    label: "Repair Windows Update",
    detail:
      "Stops wuauserv + BITS, wipes SoftwareDistribution, restarts them. Canonical WU fix.",
    category: "update",
    confirm: {
      title: "Repair Windows Update?",
      message:
        "Stops Windows Update services, deletes %WINDIR%\\SoftwareDistribution, then restarts them. Continue?",
    },
  },
  "pc-reset-wu-components": {
    kind: "pc-reset-wu-components",
    label: "Reset WU components",
    detail:
      "Stops wuauserv+bits+cryptsvc+msiserver, wipes SoftwareDistribution + catroot2, restarts. Heavier than Repair WU.",
    category: "update",
    confirm: {
      title: "Reset Windows Update components?",
      message:
        "Stops wuauserv, bits, cryptsvc and msiserver, then wipes SoftwareDistribution and catroot2 before restarting them. Continue?",
    },
  },
  "pc-wu-troubleshooter": {
    kind: "pc-wu-troubleshooter",
    label: "WU troubleshooter",
    detail: "Launches the Windows Update Diagnostic wizard (msdt).",
    category: "update",
  },
  "pc-windows-update": {
    kind: "pc-windows-update",
    label: "Open Windows Update",
    detail: "Opens ms-settings:windowsupdate.",
    category: "update",
  },
  "pc-wsreset": {
    kind: "pc-wsreset",
    label: "Reset Store cache",
    detail: "wsreset.exe — clears the Microsoft Store cache.",
    category: "update",
  },
  "pc-reregister-store-apps": {
    kind: "pc-reregister-store-apps",
    label: "Re-register Store apps",
    detail:
      "Get-AppxPackage | Add-AppxPackage — re-registers all Microsoft Store apps (fixes Start menu / UWP corruption).",
    category: "update",
    confirm: {
      title: "Re-register all Store apps?",
      message:
        "Walks every installed AppX package and re-registers it. Takes a few minutes. Continue?",
    },
  },

  // ---- storage ----
  "pc-sfc": {
    kind: "pc-sfc",
    label: "Run SFC scan",
    detail: "sfc /scannow — verify + restore system files. Opens a new console.",
    category: "storage",
  },
  "pc-dism": {
    kind: "pc-dism",
    label: "Run DISM repair",
    detail: "DISM /Online /Cleanup-Image /RestoreHealth — repairs the component store.",
    category: "storage",
  },
  "pc-chkdsk": {
    kind: "pc-chkdsk",
    label: "Run chkdsk (scan)",
    detail: "chkdsk C: /scan — read-only scan of the system drive.",
    category: "storage",
  },
  "pc-clear-temp": {
    kind: "pc-clear-temp",
    label: "Clear %TEMP%",
    detail: "Deletes everything under %TEMP%. Locked files are skipped.",
    category: "storage",
    confirm: {
      title: "Clear temp files?",
      message: "Permanently deletes contents of %TEMP%. Continue?",
    },
  },
  "pc-disk-cleanup": {
    kind: "pc-disk-cleanup",
    label: "Disk Cleanup",
    detail: "Launches cleanmgr.exe.",
    category: "storage",
  },
  "pc-disk-management": {
    kind: "pc-disk-management",
    label: "Disk Management",
    detail: "Opens diskmgmt.msc — partition + volume manager.",
    category: "storage",
  },

  // ---- shell ----
  "pc-restart-explorer": {
    kind: "pc-restart-explorer",
    label: "Restart Explorer",
    detail: "Kills + relaunches explorer.exe. Fixes taskbar / shell glitches.",
    category: "shell",
    confirm: {
      title: "Restart Explorer?",
      message:
        "Closes any open File Explorer windows. Taskbar will blink. Continue?",
    },
  },

  // ---- diagnostic ----
  "pc-mdsched": {
    kind: "pc-mdsched",
    label: "Memory diagnostic",
    detail: "Launches mdsched.exe — schedules a RAM check at next reboot.",
    category: "diagnostic",
  },
  "pc-power-troubleshooter": {
    kind: "pc-power-troubleshooter",
    label: "Power troubleshooter",
    detail: "Launches the Windows Power Diagnostic wizard.",
    category: "diagnostic",
  },
  "pc-audio-troubleshooter": {
    kind: "pc-audio-troubleshooter",
    label: "Audio troubleshooter",
    detail: "Launches the Audio Playback Diagnostic wizard.",
    category: "diagnostic",
  },
  "pc-bluetooth-troubleshooter": {
    kind: "pc-bluetooth-troubleshooter",
    label: "Bluetooth troubleshooter",
    detail: "Launches the Bluetooth Diagnostic wizard.",
    category: "diagnostic",
  },
  "pc-search-troubleshooter": {
    kind: "pc-search-troubleshooter",
    label: "Search troubleshooter",
    detail: "Launches the Search & Indexing Diagnostic wizard.",
    category: "diagnostic",
  },
  "pc-event-viewer": {
    kind: "pc-event-viewer",
    label: "Open Event Viewer",
    detail: "Launches eventvwr.msc for deeper inspection.",
    category: "diagnostic",
  },
  "pc-reliability-monitor": {
    kind: "pc-reliability-monitor",
    label: "Reliability Monitor",
    detail: "perfmon /rel — per-day system stability log.",
    category: "diagnostic",
  },
  "pc-resource-monitor": {
    kind: "pc-resource-monitor",
    label: "Resource Monitor",
    detail: "resmon.exe — per-process CPU/memory/disk/network.",
    category: "diagnostic",
  },
  "pc-perfmon": {
    kind: "pc-perfmon",
    label: "Performance Monitor",
    detail: "perfmon.exe — full counter graph.",
    category: "diagnostic",
  },
  "pc-task-manager": {
    kind: "pc-task-manager",
    label: "Task Manager",
    detail: "Launches taskmgr.exe.",
    category: "diagnostic",
  },

  // ---- system ----
  "pc-device-manager": {
    kind: "pc-device-manager",
    label: "Device Manager",
    detail: "Launches devmgmt.msc.",
    category: "system",
  },
  "pc-gpupdate": {
    kind: "pc-gpupdate",
    label: "gpupdate /force",
    detail: "Forces Group Policy refresh.",
    category: "system",
  },
  "pc-computer-management": {
    kind: "pc-computer-management",
    label: "Computer Management",
    detail: "Opens compmgmt.msc — full MMC console.",
    category: "system",
  },
  "pc-task-scheduler": {
    kind: "pc-task-scheduler",
    label: "Task Scheduler",
    detail: "Opens taskschd.msc.",
    category: "system",
  },
  "pc-programs-features": {
    kind: "pc-programs-features",
    label: "Programs & Features",
    detail: "Opens appwiz.cpl — installed software list.",
    category: "system",
  },
  "pc-power-options": {
    kind: "pc-power-options",
    label: "Power Options",
    detail: "Opens powercfg.cpl.",
    category: "system",
  },
  "pc-sound-settings": {
    kind: "pc-sound-settings",
    label: "Sound settings",
    detail: "Opens mmsys.cpl — playback / recording devices.",
    category: "system",
  },
  "pc-windows-security": {
    kind: "pc-windows-security",
    label: "Windows Security",
    detail: "Opens windowsdefender: settings.",
    category: "system",
  },
  "pc-recovery": {
    kind: "pc-recovery",
    label: "Recovery options",
    detail: "Opens ms-settings:recovery.",
    category: "system",
  },
  "pc-system-restore": {
    kind: "pc-system-restore",
    label: "System Restore",
    detail: "Launches rstrui.exe.",
    category: "system",
  },
};

const CATEGORY_LABELS: Record<FixCategory, string> = {
  network: "Network",
  services: "Services",
  update: "Windows Update / Store",
  storage: "Storage & integrity",
  shell: "Shell",
  diagnostic: "Diagnostic tools",
  system: "System & management",
};

const CATEGORY_ORDER: FixCategory[] = [
  "network",
  "services",
  "update",
  "storage",
  "shell",
  "diagnostic",
  "system",
];

// ---------------------------------------------------------------------------
// Known errors — description + suggested fix kinds for the most common
// Windows Event IDs. The frontend looks each row up in this map; rows
// without a hit fall back to a generic recovery toolbox.
// ---------------------------------------------------------------------------

interface KnownError {
  description: string;
  fixes: string[]; // Fix kinds (must exist in FIX_CATALOG)
  severity: "critical" | "error" | "warning";
}

const KNOWN_ERRORS: Record<number, KnownError> = {
  41: {
    description:
      "Kernel-Power — system rebooted without cleanly shutting down (hard crash, power loss or driver hang).",
    fixes: [
      "pc-mdsched",
      "pc-power-troubleshooter",
      "pc-reliability-monitor",
      "pc-event-viewer",
      "pc-device-manager",
      "pc-sfc",
      "pc-dism",
      "pc-chkdsk",
    ],
    severity: "critical",
  },
  1001: {
    description:
      "Windows Error Reporting — an application or driver crashed and was bucketed by WER.",
    fixes: [
      "pc-event-viewer",
      "pc-reliability-monitor",
      "pc-sfc",
      "pc-dism",
      "pc-restart-explorer",
    ],
    severity: "error",
  },
  6008: {
    description:
      "Unexpected shutdown — the previous system shutdown was not clean (forced reboot, BSOD, power loss).",
    fixes: [
      "pc-mdsched",
      "pc-chkdsk",
      "pc-power-troubleshooter",
      "pc-reliability-monitor",
      "pc-event-viewer",
    ],
    severity: "critical",
  },
  7000: {
    description: "Service failed to start — a Windows service could not be launched.",
    fixes: ["pc-services-mmc", "pc-event-viewer", "pc-sfc", "pc-dism"],
    severity: "error",
  },
  7001: {
    description: "Service depends on a service which failed to start — a dependency chain broke.",
    fixes: ["pc-services-mmc", "pc-event-viewer"],
    severity: "error",
  },
  7011: {
    description: "Service timeout — Windows gave up waiting for a service to respond (default 30s).",
    fixes: ["pc-services-mmc", "pc-restart-explorer"],
    severity: "warning",
  },
  7031: {
    description: "A service crashed and SCM is attempting recovery.",
    fixes: ["pc-services-mmc", "pc-event-viewer", "pc-restart-wsearch", "pc-restart-bits"],
    severity: "warning",
  },
  4624: {
    description: "Successful logon — informational, not an error.",
    fixes: ["pc-event-viewer"],
    severity: "warning",
  },
  4625: {
    description: "Failed logon attempt — wrong password, expired account or locked out.",
    fixes: ["pc-event-viewer", "pc-gpupdate"],
    severity: "warning",
  },
  1000: {
    description: "Application Error — a user-mode process crashed (AppCrash bucket).",
    fixes: ["pc-event-viewer", "pc-sfc", "pc-dism", "pc-clear-temp", "pc-restart-explorer"],
    severity: "error",
  },
  10010: {
    description: "DCOM server did not register with DCOM within the required timeout.",
    fixes: ["pc-event-viewer", "pc-services-mmc", "pc-sfc"],
    severity: "warning",
  },
  // Print spooler family.
  372: {
    description: "Print Spooler error — the spooler service has hit an error condition.",
    fixes: ["pc-restart-spooler", "pc-services-mmc", "pc-clear-temp"],
    severity: "error",
  },
  808: {
    description: "Print job failed to render.",
    fixes: ["pc-restart-spooler", "pc-services-mmc"],
    severity: "warning",
  },
  // Windows Update family.
  20: {
    description: "Windows Update installation failure (WUA).",
    fixes: [
      "pc-repair-wu",
      "pc-reset-wu-components",
      "pc-restart-wuauserv",
      "pc-restart-bits",
      "pc-windows-update",
      "pc-wu-troubleshooter",
      "pc-sfc",
    ],
    severity: "error",
  },
  25: {
    description: "Windows Update download failure.",
    fixes: [
      "pc-repair-wu",
      "pc-restart-bits",
      "pc-restart-wuauserv",
      "pc-network-troubleshooter",
      "pc-flush-dns",
    ],
    severity: "warning",
  },
  // User profile service.
  1530: {
    description:
      "User profile service — Windows detected your registry file is still in use after sign-out.",
    fixes: ["pc-event-viewer", "pc-services-mmc", "pc-restart-explorer"],
    severity: "warning",
  },
  // Service crashed (SCM logs this when a service terminates unexpectedly).
  7034: {
    description:
      "A service terminated unexpectedly. SCM is logging the crash; check the source service.",
    fixes: [
      "pc-services-mmc",
      "pc-event-viewer",
      "pc-restart-wsearch",
      "pc-restart-bits",
      "pc-sfc",
    ],
    severity: "error",
  },
  // Successful credential validation by the security subsystem.
  4776: {
    description:
      "Credential validation by SAM/NTLM (success or failure depending on status code).",
    fixes: ["pc-event-viewer", "pc-gpupdate"],
    severity: "warning",
  },
  // Disk family — bad block / IO error.
  7: {
    description: "Disk has a bad block — possible hardware failure starting.",
    fixes: ["pc-chkdsk", "pc-event-viewer", "pc-reliability-monitor", "pc-disk-management"],
    severity: "critical",
  },
  // Driver / hardware errors.
  219: {
    description:
      "A driver was not installed correctly — likely missing or incompatible.",
    fixes: ["pc-device-manager", "pc-event-viewer", "pc-sfc"],
    severity: "warning",
  },
  // Storage IO error (ntfs/storahci).
  153: {
    description: "An IO operation was retried after a timeout — possible disk issues.",
    fixes: ["pc-chkdsk", "pc-event-viewer", "pc-disk-management"],
    severity: "warning",
  },
  // Bluetooth / audio.
  2: {
    description:
      "Audio service or driver reported an error (HDAudio / Audiosrv).",
    fixes: [
      "pc-restart-audio",
      "pc-audio-troubleshooter",
      "pc-device-manager",
      "pc-event-viewer",
    ],
    severity: "warning",
  },
  // DCOM / COM activation timeout.
  10016: {
    description:
      "DCOM permission denied — the application-specific permission settings do not grant Local Activation.",
    fixes: ["pc-event-viewer", "pc-services-mmc", "pc-gpupdate"],
    severity: "warning",
  },
  // BugCheck / kernel crash dump.
  1003: {
    description:
      "BugCheck — the system crashed and produced a kernel dump (BSOD).",
    fixes: [
      "pc-mdsched",
      "pc-reliability-monitor",
      "pc-event-viewer",
      "pc-sfc",
      "pc-dism",
      "pc-device-manager",
    ],
    severity: "critical",
  },
  // App hang / not responding.
  1002: {
    description: "Application hang — a process stopped responding to Windows.",
    fixes: ["pc-event-viewer", "pc-reliability-monitor", "pc-clear-temp", "pc-restart-explorer"],
    severity: "warning",
  },
};

// Generic toolbox shown when the event ID isn't in KNOWN_ERRORS. Aim: cover
// the 80% of "I have no idea what this is" cases without overwhelming.
const GENERIC_FIXES = [
  "pc-event-viewer",
  "pc-reliability-monitor",
  "pc-services-mmc",
  "pc-sfc",
  "pc-dism",
  "pc-network-troubleshooter",
];

function levelBadge(level: EventLogLevel): { bg: string; fg: string; label: string } {
  switch (level) {
    case "critical":
      return { bg: "rgba(248, 81, 73, 0.18)", fg: "var(--color-danger)", label: "Critical" };
    case "error":
      return { bg: "rgba(248, 81, 73, 0.10)", fg: "var(--color-danger)", label: "Error" };
    case "warning":
      return { bg: "rgba(210, 153, 34, 0.14)", fg: "var(--color-warn)", label: "Warning" };
    case "information":
      return { bg: "rgba(88, 166, 255, 0.10)", fg: "var(--color-accent, #58a6ff)", label: "Info" };
    default:
      return { bg: "rgba(187, 187, 187, 0.10)", fg: "var(--color-text-tertiary)", label: level };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Diagnostics() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsErr, setEventsErr] = useState<string | null>(null);

  // Per-fix execution state (so the user knows what's running where).
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);

  // Toolbox (Available commands) — collapsible, with filter.
  const [toolboxOpen, setToolboxOpen] = useState(false);
  const [toolboxFilter, setToolboxFilter] = useState("");

  // "Solve with AI" modal state.
  const [solveOpen, setSolveOpen] = useState(false);
  const [solveProblem, setSolveProblem] = useState("");
  const [solveSending, setSolveSending] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setAnalysis(null);
    try {
      const r = (await invoke("run_diagnostic_native")) as DiagnosticReport;
      setReport(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsErr(null);
    try {
      const r = (await invoke("event_log_recent", {
        limit: 50,
        scope: "critical_and_error",
      })) as EventLogEntry[];
      setEvents(r);
    } catch (e) {
      setEventsErr(String(e));
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    void loadEvents();
  }, [run, loadEvents]);

  async function analyze() {
    if (!report) return;
    setAnalyzing(true);
    try {
      const md = (await invoke("analyze_diagnostic_with_ai", {
        reportJson: JSON.stringify(report, null, 2),
      })) as string;
      setAnalysis(md);
    } catch (e) {
      setAnalysis(`**Error:** ${String(e)}`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function runFix(fix: Fix) {
    if (fix.confirm) {
      const ok = await confirmDialog(fix.confirm.message, {
        title: fix.confirm.title,
        kind: "warning",
      });
      if (!ok) return;
    }
    setFixBusy(fix.kind);
    setFixResult(null);
    try {
      const r = (await invoke("run_maintenance_command", {
        kind: fix.kind,
      })) as MaintenanceResult;
      if (r.success) {
        setFixResult(`${fix.label}: ok (${r.elapsed_ms}ms).`);
      } else {
        const tail = (r.stderr || r.stdout || "").trim().slice(0, 200);
        setFixResult(`${fix.label}: failed (exit ${r.exit_code ?? "?"}). ${tail}`);
      }
    } catch (e) {
      setFixResult(`${fix.label}: ${String(e)}`);
    } finally {
      setFixBusy(null);
    }
  }

  /**
   * Spawn a Claude session with a fully-formed diagnostic prompt:
   *   - the user's problem statement
   *   - app health snapshot
   *   - the 10 most recent critical/error event log rows
   *   - the full FIX_CATALOG so Claude can recommend specific buttons.
   *
   * The session takes over in the embedded terminal — USER can iterate
   * with Claude from there.
   */
  async function solveWithAi(problem: string) {
    setSolveSending(true);
    setSolveError(null);
    try {
      const prompt = buildSolvePrompt(problem, report, events);
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: null,
        flags: { dangerouslySkipPermissions: false },
      });
      setSolveOpen(false);
      setSolveProblem("");
      setFixResult("Solve with AI: Claude session spawned with diagnostic context.");
    } catch (e) {
      setSolveError(String(e));
    } finally {
      setSolveSending(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div
        className="rounded p-3"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
              Diagnostics &amp; Fixes
            </div>
            <div
              className="mt-0.5 text-[12px] leading-snug"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Parses recent Windows Event Log critical/error rows, maps each one to a list
              of suggested fixes, and lets you run them as buttons. App health is shown
              for the Claude / Codex / Gemini CLIs and Mem0 wiring.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              onClick={() => setSolveOpen(true)}
              title="Describe a problem and spawn a Claude session with the current diagnostic context."
            >
              Solve with AI
            </button>
            <button
              type="button"
              className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              onClick={() => setHistoryOpen((v) => !v)}
            >
              {historyOpen ? "Hide history" : "History"}
            </button>
            <button
              type="button"
              className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
              onClick={() => setScheduleOpen((v) => !v)}
            >
              {scheduleOpen ? "Hide schedule" : "Schedule"}
            </button>
            <button
              type="button"
              className="rounded px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
              onClick={() => {
                void run();
                void loadEvents();
              }}
              disabled={loading || eventsLoading}
            >
              {loading || eventsLoading ? "Running..." : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {err && (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-200">
          {err}
        </div>
      )}

      {fixResult && (
        <div
          className="rounded border px-3 py-2 text-[12px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
        >
          {fixResult}
        </div>
      )}

      {historyOpen && (
        <DiagnosticHistoryPanel
          onSelect={(r) => {
            setReport(r);
            setHistoryOpen(false);
          }}
        />
      )}

      {scheduleOpen && <DiagnosticSchedulePanel />}

      {/* App health (kept) */}
      {report && (
        <AppHealthCard report={report} />
      )}

      {/* Toolbox — full list of available fixes, regardless of detected errors. */}
      <ToolboxPanel
        open={toolboxOpen}
        onToggle={() => setToolboxOpen((v) => !v)}
        filter={toolboxFilter}
        onFilterChange={setToolboxFilter}
        runFix={runFix}
        fixBusy={fixBusy}
      />

      {/* Event log + fix buttons */}
      <EventLogPanel
        events={events}
        loading={eventsLoading}
        error={eventsErr}
        runFix={runFix}
        fixBusy={fixBusy}
        onRefresh={() => void loadEvents()}
      />

      {report && (
        <div className="flex justify-end">
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-white/10 px-3 py-1 text-[12px] hover:bg-white/5 disabled:opacity-50"
            onClick={analyze}
            disabled={analyzing}
          >
            {analyzing ? "Analyzing..." : "Analyze with AI"}
          </button>
        </div>
      )}

      {analysis && (
        <div className="rounded border border-white/10 bg-[var(--color-surface-1)] p-3">
          <div className="mb-2 text-[12px] text-white/50">AI analysis</div>
          <div className="prose prose-invert prose-sm max-w-none">
            <Markdown source={analysis} />
          </div>
        </div>
      )}

      {solveOpen && (
        <SolveWithAiModal
          problem={solveProblem}
          onProblemChange={setSolveProblem}
          sending={solveSending}
          error={solveError}
          eventsCount={events.length}
          hasReport={!!report}
          onCancel={() => {
            setSolveOpen(false);
            setSolveError(null);
          }}
          onSend={() => {
            const trimmed = solveProblem.trim();
            if (!trimmed) {
              setSolveError("Describe the problem first.");
              return;
            }
            void solveWithAi(trimmed);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App health card — replaces the multi-card grid; only the subset USER
// asked to keep.
// ---------------------------------------------------------------------------

function AppHealthCard({ report }: { report: DiagnosticReport }) {
  const sev = report.app.severity;
  const border =
    sev === "error"
      ? "border-red-500/40 bg-red-500/10"
      : sev === "warn"
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-emerald-500/30 bg-emerald-500/5";
  const glyph =
    sev === "error"
      ? { ch: "✕", color: "text-red-400" }
      : sev === "warn"
        ? { ch: "!", color: "text-amber-400" }
        : { ch: "✓", color: "text-emerald-400" };

  return (
    <div className={`rounded border p-4 ${border}`}>
      <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold">
        <span className={`font-mono ${glyph.color}`}>{glyph.ch}</span>
        App health
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        <HealthRow k="projects.json" v={report.app.projects_json_ok ? "ok" : "missing / corrupt"} ok={report.app.projects_json_ok} />
        <HealthRow k="claude in PATH" v={report.app.claude_in_path ? "yes" : "no"} ok={report.app.claude_in_path} />
        <HealthRow k="codex in PATH" v={report.app.codex_in_path ? "yes" : "no"} ok={report.app.codex_in_path} />
        <HealthRow k="gemini in PATH" v={report.app.gemini_in_path ? "yes" : "no"} ok={report.app.gemini_in_path} />
        <HealthRow k="mem0 configured" v={report.app.mem0_configured ? "yes" : "no"} ok={report.app.mem0_configured} />
      </div>
    </div>
  );
}

function HealthRow({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <div className="flex justify-between text-[13px]">
      <span style={{ color: "var(--color-text-tertiary)" }}>{k}</span>
      <span
        className="font-mono"
        style={{ color: ok ? "var(--color-success)" : "var(--color-warn)" }}
      >
        {v}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event Log panel — shows recent Critical/Error events. Each row carries its
// own block of "Suggested fixes" buttons mapped from the Event ID.
// ---------------------------------------------------------------------------

function EventLogPanel({
  events,
  loading,
  error,
  runFix,
  fixBusy,
  onRefresh,
}: {
  events: EventLogEntry[];
  loading: boolean;
  error: string | null;
  runFix: (fix: Fix) => void | Promise<void>;
  fixBusy: string | null;
  onRefresh: () => void;
}) {
  const visible = events.slice(0, 25);
  const hasMore = events.length > visible.length;

  return (
    <section
      className="rounded"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <header
        className="flex items-center justify-between px-3 py-2"
        style={{
          background: "var(--color-surface-1)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div>
          <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Event Log errors with suggested fixes
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Live wevtutil query (Critical + Error). Each row maps to a curated list of
            buttons that run the matching Windows command.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void runFix(FIX_CATALOG["pc-event-viewer"])}
            disabled={fixBusy !== null}
            className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Launch eventvwr.msc"
          >
            Open Event Viewer
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </header>

      {error && (
        <div
          className="m-3 rounded p-2 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
            fontFamily: "var(--font-mono, ui-monospace)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div className="px-3 py-6 text-center text-[13px]" style={{ color: "var(--color-text-tertiary)" }}>
          No critical or error events found.
        </div>
      )}

      {visible.length > 0 && (
        <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
          {visible.map((evt, idx) => (
            <EventLogRow
              key={`${evt.time_created}-${idx}`}
              evt={evt}
              runFix={runFix}
              fixBusy={fixBusy}
            />
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="px-3 py-2 text-[11px]" style={{ color: "var(--color-text-faint)" }}>
          ... {events.length - visible.length} more — open Event Viewer for the full list.
        </div>
      )}
    </section>
  );
}

function EventLogRow({
  evt,
  runFix,
  fixBusy,
}: {
  evt: EventLogEntry;
  runFix: (fix: Fix) => void | Promise<void>;
  fixBusy: string | null;
}) {
  const known = KNOWN_ERRORS[evt.event_id];
  const badge = levelBadge(evt.level);
  const fixKinds = known ? known.fixes : GENERIC_FIXES;

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide"
          style={{ background: badge.bg, color: badge.fg }}
        >
          {badge.label}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]"
            style={{ color: "var(--color-text)" }}
          >
            <span className="font-semibold tabular-nums">id {evt.event_id}</span>
            <span
              className="truncate"
              style={{ color: "var(--color-text-secondary)" }}
              title={evt.source}
            >
              {evt.source || "—"}
            </span>
            <span
              className="ml-auto shrink-0 tabular-nums text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {evt.time_created}
            </span>
          </div>
          {known ? (
            <div className="mt-1 text-[12.5px] leading-snug" style={{ color: "var(--color-text-secondary)" }}>
              {known.description}
            </div>
          ) : (
            evt.message && (
              <div
                className="mt-1 line-clamp-2 text-[12px] leading-snug"
                style={{
                  color: "var(--color-text-tertiary)",
                  fontFamily: "var(--font-mono, ui-monospace)",
                }}
                title={evt.message}
              >
                {evt.message}
              </div>
            )
          )}

          {/* Suggested fixes — every fix is a button. Whether the event is
              known or not, we always offer something actionable. */}
          {fixKinds.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {fixKinds
                .map((k) => FIX_CATALOG[k])
                .filter((f): f is Fix => !!f)
                .map((f) => {
                  const busy = fixBusy === f.kind;
                  return (
                    <button
                      key={f.kind}
                      type="button"
                      onClick={() => void runFix(f)}
                      disabled={fixBusy !== null}
                      title={f.detail}
                      className="rounded border px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
                      style={{
                        borderColor: "var(--color-border-strong)",
                        background: busy ? "var(--color-accent)" : "var(--color-surface-3)",
                        color: busy ? "var(--color-accent-text)" : "var(--color-text)",
                      }}
                    >
                      {busy ? "Running…" : f.label}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Toolbox panel — collapsible card listing every fix in FIX_CATALOG, grouped
// by category, with a filter input. Renders a compact 2-3 column grid of
// cards instead of the per-row event buttons.
// ---------------------------------------------------------------------------

function ToolboxPanel({
  open,
  onToggle,
  filter,
  onFilterChange,
  runFix,
  fixBusy,
}: {
  open: boolean;
  onToggle: () => void;
  filter: string;
  onFilterChange: (v: string) => void;
  runFix: (fix: Fix) => void | Promise<void>;
  fixBusy: string | null;
}) {
  const allFixes = Object.values(FIX_CATALOG);
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? allFixes.filter(
        (f) =>
          f.label.toLowerCase().includes(q) ||
          f.detail.toLowerCase().includes(q) ||
          f.kind.toLowerCase().includes(q),
      )
    : allFixes;

  const grouped: Record<FixCategory, Fix[]> = {
    network: [],
    services: [],
    update: [],
    storage: [],
    shell: [],
    diagnostic: [],
    system: [],
  };
  for (const fix of filtered) grouped[fix.category].push(fix);

  return (
    <section
      className="rounded"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <header
        className="flex cursor-pointer items-center justify-between px-3 py-2"
        style={{
          background: "var(--color-surface-1)",
          borderBottom: open ? "1px solid var(--color-border)" : "none",
        }}
        onClick={onToggle}
      >
        <div>
          <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Toolbox · {allFixes.length} commands
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Every fix the Control Center can run, grouped by category. Use as a
            quick reference — you don't need an error to trigger one.
          </div>
        </div>
        <span
          className="ml-3 shrink-0 font-mono text-[12px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {open ? "▾" : "▸"}
        </span>
      </header>

      {open && (
        <div className="p-3">
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter by name, kind or description…"
            className="mb-3 w-full rounded px-2 py-1 text-[12px]"
            style={{
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
              outline: "none",
            }}
          />

          {filtered.length === 0 && (
            <div
              className="px-2 py-4 text-center text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              No commands match "{filter}".
            </div>
          )}

          <div className="space-y-3">
            {CATEGORY_ORDER.map((cat) => {
              const items = grouped[cat];
              if (items.length === 0) return null;
              return (
                <div key={cat}>
                  <div
                    className="mb-1.5 text-[11px] font-medium uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {CATEGORY_LABELS[cat]} · {items.length}
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((fix) => (
                      <ToolboxCard
                        key={fix.kind}
                        fix={fix}
                        runFix={runFix}
                        fixBusy={fixBusy}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function ToolboxCard({
  fix,
  runFix,
  fixBusy,
}: {
  fix: Fix;
  runFix: (fix: Fix) => void | Promise<void>;
  fixBusy: string | null;
}) {
  const busy = fixBusy === fix.kind;
  return (
    <div
      className="flex items-start justify-between gap-2 rounded p-2"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="min-w-0 flex-1">
        <div
          className="text-[12.5px] font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          {fix.label}
        </div>
        <div
          className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug"
          style={{ color: "var(--color-text-tertiary)" }}
          title={fix.detail}
        >
          {fix.detail}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void runFix(fix)}
        disabled={fixBusy !== null}
        className="shrink-0 rounded border px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
        style={{
          borderColor: "var(--color-border-strong)",
          background: busy ? "var(--color-accent)" : "var(--color-surface-3)",
          color: busy ? "var(--color-accent-text)" : "var(--color-text)",
        }}
      >
        {busy ? "Running…" : "Run"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Solve with AI — modal + prompt builder.
// ---------------------------------------------------------------------------

function SolveWithAiModal({
  problem,
  onProblemChange,
  sending,
  error,
  eventsCount,
  hasReport,
  onCancel,
  onSend,
}: {
  problem: string;
  onProblemChange: (v: string) => void;
  sending: boolean;
  error: string | null;
  eventsCount: number;
  hasReport: boolean;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0, 0, 0, 0.6)" }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
          Solve with AI
        </div>
        <div
          className="mb-3 text-[12px] leading-snug"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Describe the problem. Claude will be spawned in the embedded terminal
          with the current diagnostic snapshot ({eventsCount} recent events
          {hasReport ? ", App health" : ""}, {Object.keys(FIX_CATALOG).length}{" "}
          available fixes) and is expected to recommend specific actions.
        </div>

        <textarea
          value={problem}
          onChange={(e) => onProblemChange(e.target.value)}
          placeholder="e.g. Spotify won't start, internet feels slow, mouse stutters…"
          rows={5}
          className="w-full rounded p-2 text-[12.5px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
            outline: "none",
            resize: "vertical",
          }}
          autoFocus
        />

        {error && (
          <div
            className="mt-2 rounded px-2 py-1.5 text-[12px]"
            style={{
              background: "rgba(248, 81, 73, 0.10)",
              border: "1px solid rgba(248, 81, 73, 0.30)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}

        <div className="mt-3 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={sending}
            className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={sending}
            className="rounded px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {sending ? "Spawning…" : "Send to Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Build the prompt sent to Claude when the user clicks "Send to Claude".
 *
 * Includes:
 *   - the user's problem statement
 *   - app health (CLIs in PATH, mem0 wiring, projects.json)
 *   - up to 10 most recent critical/error event log rows
 *   - the full FIX_CATALOG with kind tokens, so Claude can recommend
 *     specific buttons by name.
 */
function buildSolvePrompt(
  problem: string,
  report: DiagnosticReport | null,
  events: EventLogEntry[],
): string {
  const recent = events.slice(0, 10);

  const eventBlock =
    recent.length === 0
      ? "(no critical/error events in the recent window)"
      : recent
          .map(
            (e) =>
              `- [${e.level}] id=${e.event_id} src=${e.source} at=${e.time_created}\n  ${(e.message || "").replace(/\s+/g, " ").trim().slice(0, 240)}`,
          )
          .join("\n");

  const healthBlock = report
    ? [
        `projects.json: ${report.app.projects_json_ok ? "ok" : "MISSING/CORRUPT"}`,
        `claude in PATH: ${report.app.claude_in_path ? "yes" : "no"}`,
        `codex in PATH: ${report.app.codex_in_path ? "yes" : "no"}`,
        `gemini in PATH: ${report.app.gemini_in_path ? "yes" : "no"}`,
        `mem0 configured: ${report.app.mem0_configured ? "yes" : "no"}`,
      ].join("\n")
    : "(no app health snapshot loaded)";

  const fixBlock = Object.values(FIX_CATALOG)
    .map((f) => `- ${f.kind} (${CATEGORY_LABELS[f.category]}) — ${f.label}: ${f.detail}`)
    .join("\n");

  return [
    "You are the Control Center diagnostic assistant. The user described a problem on their Windows machine.",
    "Diagnose the most likely cause and recommend the most relevant fixes from the catalog below.",
    "Prefer fixes by their kind token (e.g. pc-flush-dns). Explain the reasoning briefly before listing actions.",
    "",
    "## User problem",
    problem,
    "",
    "## App health snapshot",
    healthBlock,
    "",
    "## Recent critical/error events (top 10)",
    eventBlock,
    "",
    "## Available fixes (FIX_CATALOG)",
    fixBlock,
    "",
    "## Output format",
    "1. One-paragraph diagnosis (what's most likely wrong, why).",
    "2. Ordered list of recommended fixes, each as: `pc-<kind>` — short rationale.",
    "3. Optional: extra commands or manual checks not in the catalog (if needed).",
  ].join("\n");
}

export default Diagnostics;
