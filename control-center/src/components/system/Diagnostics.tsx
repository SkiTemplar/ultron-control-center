// Control Center 2.9.5 — Diagnostics & Fixes (rediseño P2 2026-05-27)
//
// USER: "Diagnostics y Fixes está muy caótico, no llego a entender a que
// botón le tengo que dar, vendría bien una serie de errores comunes o algo y
// luego los botones para posiblemente solucionarlo."
//
// Estructura nueva:
//   1. Header: buscador "Search common errors..." + filtro por categoría
//   2. COMMON_ERRORS: 13 errores conocidos con icono severidad, título corto,
//      síntoma, botón Diagnose (corre check específico) + botón Fix
//   3. Recent Fixes: historial local (~/.ultron/cockpit/fix-history.jsonl)
//   4. App Health (kept — compacto)
//   5. Toolbox Windows (collapsible, al fondo — ya existía)
//   6. Event Log con fixes sugeridos (kept)

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiagnosticReport } from "../../types";
import { Markdown } from "../../lib/markdown";
import { DiagnosticHistoryPanel } from "./DiagnosticHistoryPanel";
import { DiagnosticSchedulePanel } from "./DiagnosticSchedulePanel";
import { confirmDialog } from "../../lib/dialog";

// ---------------------------------------------------------------------------
// Types
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

interface CommonErrorCheckResult {
  status: "ok" | "fail" | "warn";
  details: string;
  suggested_fix: string | null;
}

// ---------------------------------------------------------------------------
// COMMON_ERRORS catalog — 13 errores reconocibles con check + fix
// ---------------------------------------------------------------------------

type CommonErrorCategory =
  | "AI / Claude"
  | "Network"
  | "Storage"
  | "Plugins"
  | "System"
  | "Git";

type CommonErrorSeverity = "critical" | "warning" | "info";

interface CommonError {
  id: string;
  category: CommonErrorCategory;
  severity: CommonErrorSeverity;
  title: string;
  symptom: string;
  /** Backend `diagnostics_run(error_id)` */
  checkId: string;
  /** Primary fix: `run_maintenance_command(kind)` — null means open modal/navigate */
  primaryFixKind: string | null;
  primaryFixLabel: string;
  /** Optional extra fix kinds shown in "More" dropdown */
  extraFixes?: Array<{ kind: string; label: string }>;
}

const COMMON_ERRORS: CommonError[] = [
  {
    id: "mem0-unreachable",
    category: "AI / Claude",
    severity: "critical",
    title: "Mem0 unreachable",
    symptom: "Memory panel shows 'disconnected' or API calls fail with 401/403.",
    checkId: "mem0-unreachable",
    primaryFixKind: null,
    primaryFixLabel: "Open Settings > API Keys",
    extraFixes: [],
  },
  {
    id: "claude-login-expired",
    category: "AI / Claude",
    severity: "critical",
    title: "Claude Code login expired",
    symptom: "Terminal shows 'authentication required' or spawned sessions fail immediately.",
    checkId: "claude-login-expired",
    primaryFixKind: null,
    primaryFixLabel: "Run claude /login in terminal",
    extraFixes: [],
  },
  {
    id: "ai-router-no-keys",
    category: "AI / Claude",
    severity: "warning",
    title: "AI Router: no providers configured",
    symptom: "AI Router falls back to Claude-only mode; Codex / Gemini routing never triggers.",
    checkId: "ai-router-no-keys",
    primaryFixKind: null,
    primaryFixLabel: "Open Settings > API Keys",
    extraFixes: [],
  },
  {
    id: "node-not-found",
    category: "AI / Claude",
    severity: "critical",
    title: "Node.js not in PATH",
    symptom: "Claude Code CLI cannot be installed or updated; npm commands fail.",
    checkId: "node-not-found",
    primaryFixKind: null,
    primaryFixLabel: "Install Node.js (nodejs.org)",
    extraFixes: [],
  },
  {
    id: "network-unreachable",
    category: "Network",
    severity: "critical",
    title: "Network unreachable",
    symptom: "All AI providers timeout; API calls fail with ECONNREFUSED / ERR_NETWORK.",
    checkId: "network-unreachable",
    primaryFixKind: "pc-flush-dns",
    primaryFixLabel: "Flush DNS",
    extraFixes: [
      { kind: "pc-renew-ip", label: "Renew IP" },
      { kind: "pc-net-reset-all", label: "Full network reset" },
      { kind: "pc-network-troubleshooter", label: "Network troubleshooter" },
    ],
  },
  {
    id: "port-1420-in-use",
    category: "System",
    severity: "warning",
    title: "Port 1420 in use",
    symptom: "Control Center fails to start with EADDRINUSE — another instance may be running.",
    checkId: "port-1420-in-use",
    primaryFixKind: null,
    primaryFixLabel: "Kill process on port 1420",
    extraFixes: [
      { kind: "pc-task-manager", label: "Open Task Manager" },
    ],
  },
  {
    id: "gh-cli-missing",
    category: "System",
    severity: "warning",
    title: "gh CLI missing",
    symptom: "GitHub operations in workflows fail; 'gh' command not recognized.",
    checkId: "gh-cli-missing",
    primaryFixKind: null,
    primaryFixLabel: "scoop install gh",
    extraFixes: [],
  },
  {
    id: "tauri-capabilities-denied",
    category: "System",
    severity: "warning",
    title: "Tauri capabilities issue",
    symptom: "Shell commands silently fail; file dialogs don't open; permissions errors in logs.",
    checkId: "tauri-capabilities-denied",
    primaryFixKind: null,
    primaryFixLabel: "Check capabilities/default.json",
    extraFixes: [
      { kind: "pc-event-viewer", label: "Open Event Viewer" },
    ],
  },
  {
    id: "qdrant-binary-missing",
    category: "AI / Claude",
    severity: "info",
    title: "Qdrant binary not found",
    symptom: "Vector search / ECC local KG features unavailable; graphify indexing fails.",
    checkId: "qdrant-binary-missing",
    primaryFixKind: null,
    primaryFixLabel: "Download qdrant.exe",
    extraFixes: [],
  },
  {
    id: "plugins-out-of-date",
    category: "Plugins",
    severity: "info",
    title: "Plugins may be out of date",
    symptom: "ECC hooks not triggering; plugin features behave unexpectedly.",
    checkId: "plugins-out-of-date",
    primaryFixKind: null,
    primaryFixLabel: "Check plugin updates",
    extraFixes: [],
  },
  {
    id: "hooks-misconfigured",
    category: "Plugins",
    severity: "warning",
    title: "Hooks misconfigured",
    symptom: "PostToolUse / Stop hooks are not firing; auto-format or cost-watchdog inactive.",
    checkId: "hooks-misconfigured",
    primaryFixKind: null,
    primaryFixLabel: "Open ~/.claude/settings.json",
    extraFixes: [],
  },
  {
    id: "ultron-disk-usage",
    category: "Storage",
    severity: "info",
    title: ".ultron disk usage high",
    symptom: "~/.ultron folder has grown large; old diagnostics, sessions or logs piling up.",
    checkId: "ultron-disk-usage",
    primaryFixKind: "pc-clear-temp",
    primaryFixLabel: "Clear %TEMP%",
    extraFixes: [
      { kind: "pc-disk-cleanup", label: "Disk Cleanup" },
    ],
  },
  {
    id: "projects-json-missing",
    category: "Storage",
    severity: "critical",
    title: "projects.json missing or corrupt",
    symptom: "Projects tab is empty; Control Center shows 'no projects found' on every launch.",
    checkId: "projects-json-missing",
    primaryFixKind: null,
    primaryFixLabel: "Open cockpit folder",
    extraFixes: [
      { kind: "pc-event-viewer", label: "Open Event Viewer" },
    ],
  },
  {
    id: "git-uncommitted-cockpit",
    category: "Git",
    severity: "info",
    title: "Uncommitted changes in cockpit",
    symptom: "kanban, workdays or project data changed locally but not committed to git.",
    checkId: "git-uncommitted-cockpit",
    primaryFixKind: null,
    primaryFixLabel: "Open terminal to commit",
    extraFixes: [],
  },
];

const COMMON_ERROR_CATEGORIES: CommonErrorCategory[] = [
  "AI / Claude",
  "Network",
  "Storage",
  "Plugins",
  "System",
  "Git",
];

// ---------------------------------------------------------------------------
// FIX_CATALOG (Windows PC fixes — unchanged from v2.7)
// ---------------------------------------------------------------------------

type FixCategory =
  | "network"
  | "services"
  | "update"
  | "storage"
  | "shell"
  | "diagnostic"
  | "system";

interface Fix {
  kind: string;
  label: string;
  detail: string;
  category: FixCategory;
  confirm?: { title: string; message: string };
}

const FIX_CATALOG: Record<string, Fix> = {
  "pc-flush-dns": { kind: "pc-flush-dns", label: "Flush DNS", detail: "ipconfig /flushdns — clears the local DNS resolver cache.", category: "network" },
  "pc-renew-ip": { kind: "pc-renew-ip", label: "Renew IP", detail: "ipconfig /release && /renew — releases and re-acquires the DHCP lease.", category: "network" },
  "pc-reset-network": { kind: "pc-reset-network", label: "Reset TCP/IP", detail: "netsh int ip reset — resets the Windows TCP/IP stack. Reboot recommended.", category: "network", confirm: { title: "Reset TCP/IP stack?", message: "Drops your current connection and a reboot is recommended afterwards. Continue?" } },
  "pc-winsock-reset": { kind: "pc-winsock-reset", label: "Reset Winsock", detail: "netsh winsock reset — restores Winsock catalog to default. Reboot recommended.", category: "network", confirm: { title: "Reset Winsock?", message: "Some third-party LSPs may need to be re-registered. Continue?" } },
  "pc-reset-firewall": { kind: "pc-reset-firewall", label: "Reset firewall", detail: "netsh advfirewall reset — restores Windows Firewall to defaults.", category: "network", confirm: { title: "Reset Windows Firewall?", message: "Removes all custom inbound/outbound rules. Continue?" } },
  "pc-flush-arp": { kind: "pc-flush-arp", label: "Flush ARP cache", detail: "netsh interface ip delete arpcache — clears the local ARP table.", category: "network" },
  "pc-net-reset-all": { kind: "pc-net-reset-all", label: "Full network reset", detail: "release + flushdns + renew + winsock reset + TCP/IP reset, in that order. Reboot recommended.", category: "network", confirm: { title: "Run full network reset?", message: "Releases DHCP, flushes DNS, renews IP, then resets Winsock and TCP/IP. A reboot is recommended afterwards. Continue?" } },
  "pc-network-troubleshooter": { kind: "pc-network-troubleshooter", label: "Network troubleshooter", detail: "Launches the Windows built-in Network Adapter Diagnostic wizard.", category: "network" },
  "pc-network-connections": { kind: "pc-network-connections", label: "Network connections", detail: "Opens ncpa.cpl — classic adapter list.", category: "network" },
  "pc-open-hosts": { kind: "pc-open-hosts", label: "Open hosts file", detail: "Opens C:\\Windows\\System32\\drivers\\etc\\hosts in Notepad.", category: "network" },
  "pc-restart-spooler": { kind: "pc-restart-spooler", label: "Restart Print Spooler", detail: "Restart-Service Spooler — fixes hung print queue / spooler crashes.", category: "services" },
  "pc-restart-audio": { kind: "pc-restart-audio", label: "Restart Audio service", detail: "Restart-Service Audiosrv + AudioEndpointBuilder.", category: "services" },
  "pc-restart-bluetooth": { kind: "pc-restart-bluetooth", label: "Restart Bluetooth", detail: "Restart-Service bthserv — Bluetooth Support service.", category: "services" },
  "pc-restart-wsearch": { kind: "pc-restart-wsearch", label: "Restart Windows Search", detail: "Restart-Service WSearch — fixes broken Start menu search.", category: "services" },
  "pc-restart-bits": { kind: "pc-restart-bits", label: "Restart BITS", detail: "Restart-Service BITS — Background Intelligent Transfer Service.", category: "services" },
  "pc-restart-wuauserv": { kind: "pc-restart-wuauserv", label: "Restart Update service", detail: "Restart-Service wuauserv — Windows Update service.", category: "services" },
  "pc-restart-time": { kind: "pc-restart-time", label: "Restart Time service", detail: "Restart-Service w32time + w32tm /resync — fixes clock skew.", category: "services" },
  "pc-services-mmc": { kind: "pc-services-mmc", label: "Open services.msc", detail: "Launches the Services management console.", category: "services" },
  "pc-repair-wu": { kind: "pc-repair-wu", label: "Repair Windows Update", detail: "Stops wuauserv + BITS, wipes SoftwareDistribution, restarts them.", category: "update", confirm: { title: "Repair Windows Update?", message: "Stops Windows Update services, deletes SoftwareDistribution, then restarts them. Continue?" } },
  "pc-reset-wu-components": { kind: "pc-reset-wu-components", label: "Reset WU components", detail: "Stops wuauserv+bits+cryptsvc+msiserver, wipes SoftwareDistribution + catroot2, restarts.", category: "update", confirm: { title: "Reset Windows Update components?", message: "Stops wuauserv, bits, cryptsvc and msiserver, then wipes SoftwareDistribution and catroot2. Continue?" } },
  "pc-wu-troubleshooter": { kind: "pc-wu-troubleshooter", label: "WU troubleshooter", detail: "Launches the Windows Update Diagnostic wizard (msdt).", category: "update" },
  "pc-windows-update": { kind: "pc-windows-update", label: "Open Windows Update", detail: "Opens ms-settings:windowsupdate.", category: "update" },
  "pc-wsreset": { kind: "pc-wsreset", label: "Reset Store cache", detail: "wsreset.exe — clears the Microsoft Store cache.", category: "update" },
  "pc-reregister-store-apps": { kind: "pc-reregister-store-apps", label: "Re-register Store apps", detail: "Get-AppxPackage | Add-AppxPackage — re-registers all Microsoft Store apps.", category: "update", confirm: { title: "Re-register all Store apps?", message: "Walks every installed AppX package and re-registers it. Takes a few minutes. Continue?" } },
  "pc-sfc": { kind: "pc-sfc", label: "Run SFC scan", detail: "sfc /scannow — verify + restore system files. Opens a new console.", category: "storage" },
  "pc-dism": { kind: "pc-dism", label: "Run DISM repair", detail: "DISM /Online /Cleanup-Image /RestoreHealth — repairs the component store.", category: "storage" },
  "pc-chkdsk": { kind: "pc-chkdsk", label: "Run chkdsk (scan)", detail: "chkdsk C: /scan — read-only scan of the system drive.", category: "storage" },
  "pc-clear-temp": { kind: "pc-clear-temp", label: "Clear %TEMP%", detail: "Deletes everything under %TEMP%. Locked files are skipped.", category: "storage", confirm: { title: "Clear temp files?", message: "Permanently deletes contents of %TEMP%. Continue?" } },
  "pc-disk-cleanup": { kind: "pc-disk-cleanup", label: "Disk Cleanup", detail: "Launches cleanmgr.exe.", category: "storage" },
  "pc-disk-management": { kind: "pc-disk-management", label: "Disk Management", detail: "Opens diskmgmt.msc — partition + volume manager.", category: "storage" },
  "pc-restart-explorer": { kind: "pc-restart-explorer", label: "Restart Explorer", detail: "Kills + relaunches explorer.exe. Fixes taskbar / shell glitches.", category: "shell", confirm: { title: "Restart Explorer?", message: "Closes any open File Explorer windows. Taskbar will blink. Continue?" } },
  "pc-mdsched": { kind: "pc-mdsched", label: "Memory diagnostic", detail: "Launches mdsched.exe — schedules a RAM check at next reboot.", category: "diagnostic" },
  "pc-power-troubleshooter": { kind: "pc-power-troubleshooter", label: "Power troubleshooter", detail: "Launches the Windows Power Diagnostic wizard.", category: "diagnostic" },
  "pc-audio-troubleshooter": { kind: "pc-audio-troubleshooter", label: "Audio troubleshooter", detail: "Launches the Audio Playback Diagnostic wizard.", category: "diagnostic" },
  "pc-bluetooth-troubleshooter": { kind: "pc-bluetooth-troubleshooter", label: "Bluetooth troubleshooter", detail: "Launches the Bluetooth Diagnostic wizard.", category: "diagnostic" },
  "pc-search-troubleshooter": { kind: "pc-search-troubleshooter", label: "Search troubleshooter", detail: "Launches the Search & Indexing Diagnostic wizard.", category: "diagnostic" },
  "pc-event-viewer": { kind: "pc-event-viewer", label: "Open Event Viewer", detail: "Launches eventvwr.msc for deeper inspection.", category: "diagnostic" },
  "pc-reliability-monitor": { kind: "pc-reliability-monitor", label: "Reliability Monitor", detail: "perfmon /rel — per-day system stability log.", category: "diagnostic" },
  "pc-resource-monitor": { kind: "pc-resource-monitor", label: "Resource Monitor", detail: "resmon.exe — per-process CPU/memory/disk/network.", category: "diagnostic" },
  "pc-perfmon": { kind: "pc-perfmon", label: "Performance Monitor", detail: "perfmon.exe — full counter graph.", category: "diagnostic" },
  "pc-task-manager": { kind: "pc-task-manager", label: "Task Manager", detail: "Launches taskmgr.exe.", category: "diagnostic" },
  "pc-device-manager": { kind: "pc-device-manager", label: "Device Manager", detail: "Launches devmgmt.msc.", category: "system" },
  "pc-gpupdate": { kind: "pc-gpupdate", label: "gpupdate /force", detail: "Forces Group Policy refresh.", category: "system" },
  "pc-computer-management": { kind: "pc-computer-management", label: "Computer Management", detail: "Opens compmgmt.msc — full MMC console.", category: "system" },
  "pc-task-scheduler": { kind: "pc-task-scheduler", label: "Task Scheduler", detail: "Opens taskschd.msc.", category: "system" },
  "pc-programs-features": { kind: "pc-programs-features", label: "Programs & Features", detail: "Opens appwiz.cpl — installed software list.", category: "system" },
  "pc-power-options": { kind: "pc-power-options", label: "Power Options", detail: "Opens powercfg.cpl.", category: "system" },
  "pc-sound-settings": { kind: "pc-sound-settings", label: "Sound settings", detail: "Opens mmsys.cpl — playback / recording devices.", category: "system" },
  "pc-windows-security": { kind: "pc-windows-security", label: "Windows Security", detail: "Opens windowsdefender: settings.", category: "system" },
  "pc-recovery": { kind: "pc-recovery", label: "Recovery options", detail: "Opens ms-settings:recovery.", category: "system" },
  "pc-system-restore": { kind: "pc-system-restore", label: "System Restore", detail: "Launches rstrui.exe.", category: "system" },
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
  "network", "services", "update", "storage", "shell", "diagnostic", "system",
];

// ---------------------------------------------------------------------------
// Known Windows Event IDs
// ---------------------------------------------------------------------------

interface KnownError {
  description: string;
  fixes: string[];
  severity: "critical" | "error" | "warning";
}

const KNOWN_ERRORS: Record<number, KnownError> = {
  41: { description: "Kernel-Power — system rebooted without cleanly shutting down (hard crash, power loss or driver hang).", fixes: ["pc-mdsched", "pc-power-troubleshooter", "pc-reliability-monitor", "pc-event-viewer", "pc-device-manager", "pc-sfc", "pc-dism", "pc-chkdsk"], severity: "critical" },
  1001: { description: "Windows Error Reporting — an application or driver crashed and was bucketed by WER.", fixes: ["pc-event-viewer", "pc-reliability-monitor", "pc-sfc", "pc-dism", "pc-restart-explorer"], severity: "error" },
  6008: { description: "Unexpected shutdown — the previous system shutdown was not clean (forced reboot, BSOD, power loss).", fixes: ["pc-mdsched", "pc-chkdsk", "pc-power-troubleshooter", "pc-reliability-monitor", "pc-event-viewer"], severity: "critical" },
  7000: { description: "Service failed to start — a Windows service could not be launched.", fixes: ["pc-services-mmc", "pc-event-viewer", "pc-sfc", "pc-dism"], severity: "error" },
  7001: { description: "Service depends on a service which failed to start — a dependency chain broke.", fixes: ["pc-services-mmc", "pc-event-viewer"], severity: "error" },
  7011: { description: "Service timeout — Windows gave up waiting for a service to respond (default 30s).", fixes: ["pc-services-mmc", "pc-restart-explorer"], severity: "warning" },
  7031: { description: "A service crashed and SCM is attempting recovery.", fixes: ["pc-services-mmc", "pc-event-viewer", "pc-restart-wsearch", "pc-restart-bits"], severity: "warning" },
  4625: { description: "Failed logon attempt — wrong password, expired account or locked out.", fixes: ["pc-event-viewer", "pc-gpupdate"], severity: "warning" },
  1000: { description: "Application Error — a user-mode process crashed (AppCrash bucket).", fixes: ["pc-event-viewer", "pc-sfc", "pc-dism", "pc-clear-temp", "pc-restart-explorer"], severity: "error" },
  10010: { description: "DCOM server did not register with DCOM within the required timeout.", fixes: ["pc-event-viewer", "pc-services-mmc", "pc-sfc"], severity: "warning" },
  372: { description: "Print Spooler error — the spooler service has hit an error condition.", fixes: ["pc-restart-spooler", "pc-services-mmc", "pc-clear-temp"], severity: "error" },
  20: { description: "Windows Update installation failure (WUA).", fixes: ["pc-repair-wu", "pc-reset-wu-components", "pc-restart-wuauserv", "pc-restart-bits", "pc-windows-update", "pc-wu-troubleshooter", "pc-sfc"], severity: "error" },
  25: { description: "Windows Update download failure.", fixes: ["pc-repair-wu", "pc-restart-bits", "pc-restart-wuauserv", "pc-network-troubleshooter", "pc-flush-dns"], severity: "warning" },
  7034: { description: "A service terminated unexpectedly. SCM is logging the crash; check the source service.", fixes: ["pc-services-mmc", "pc-event-viewer", "pc-restart-wsearch", "pc-restart-bits", "pc-sfc"], severity: "error" },
  7: { description: "Disk has a bad block — possible hardware failure starting.", fixes: ["pc-chkdsk", "pc-event-viewer", "pc-reliability-monitor", "pc-disk-management"], severity: "critical" },
  219: { description: "A driver was not installed correctly — likely missing or incompatible.", fixes: ["pc-device-manager", "pc-event-viewer", "pc-sfc"], severity: "warning" },
  153: { description: "An IO operation was retried after a timeout — possible disk issues.", fixes: ["pc-chkdsk", "pc-event-viewer", "pc-disk-management"], severity: "warning" },
  10016: { description: "DCOM permission denied — Local Activation not granted.", fixes: ["pc-event-viewer", "pc-services-mmc", "pc-gpupdate"], severity: "warning" },
  1003: { description: "BugCheck — the system crashed and produced a kernel dump (BSOD).", fixes: ["pc-mdsched", "pc-reliability-monitor", "pc-event-viewer", "pc-sfc", "pc-dism", "pc-device-manager"], severity: "critical" },
  1002: { description: "Application hang — a process stopped responding to Windows.", fixes: ["pc-event-viewer", "pc-reliability-monitor", "pc-clear-temp", "pc-restart-explorer"], severity: "warning" },
};

const GENERIC_FIXES = ["pc-event-viewer", "pc-reliability-monitor", "pc-services-mmc", "pc-sfc", "pc-dism", "pc-network-troubleshooter"];

// ---------------------------------------------------------------------------
// Fix history persistence helpers
// ---------------------------------------------------------------------------

interface FixHistoryEntry {
  ts: string;
  kind: string;
  label: string;
  success: boolean;
  source: "common_error" | "toolbox" | "event_log";
  error_id?: string;
}

async function appendFixHistory(entry: FixHistoryEntry): Promise<void> {
  try {
    await invoke<void>("notes_save_global", {
      name: "__fix-history-append__",
      content: JSON.stringify(entry),
    });
  } catch {
    // History is best-effort — never block the fix from running
  }
}

// Since we can't call a dedicated JSONL append command, we persist history
// in localStorage as a capped ring buffer (last 50 entries). The backend
// write above is a no-op placeholder until a real JSONL command exists.
const FIX_HISTORY_LS_KEY = "ultron.diagnostics.fix_history";
const FIX_HISTORY_MAX = 50;

function loadFixHistory(): FixHistoryEntry[] {
  try {
    const raw = localStorage.getItem(FIX_HISTORY_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as FixHistoryEntry[];
    return [];
  } catch {
    return [];
  }
}

function saveFixHistory(entries: FixHistoryEntry[]): void {
  try {
    localStorage.setItem(FIX_HISTORY_LS_KEY, JSON.stringify(entries.slice(0, FIX_HISTORY_MAX)));
  } catch {
    // ignore
  }
}

function pushFixHistory(entry: FixHistoryEntry): FixHistoryEntry[] {
  const prev = loadFixHistory();
  const next = [entry, ...prev].slice(0, FIX_HISTORY_MAX);
  saveFixHistory(next);
  return next;
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function severityIcon(s: CommonErrorSeverity): { symbol: string; color: string } {
  switch (s) {
    case "critical": return { symbol: "●", color: "var(--color-danger, #f85149)" };
    case "warning":  return { symbol: "▲", color: "var(--color-warn, #d29922)" };
    case "info":     return { symbol: "◆", color: "var(--color-accent, #58a6ff)" };
  }
}

function levelBadge(level: EventLogLevel): { bg: string; fg: string; label: string } {
  switch (level) {
    case "critical": return { bg: "rgba(248,81,73,0.18)", fg: "var(--color-danger)", label: "Critical" };
    case "error":    return { bg: "rgba(248,81,73,0.10)", fg: "var(--color-danger)", label: "Error" };
    case "warning":  return { bg: "rgba(210,153,34,0.14)", fg: "var(--color-warn)", label: "Warning" };
    case "information": return { bg: "rgba(88,166,255,0.10)", fg: "var(--color-accent,#58a6ff)", label: "Info" };
    default: return { bg: "rgba(187,187,187,0.10)", fg: "var(--color-text-tertiary)", label: level };
  }
}

// ---------------------------------------------------------------------------
// Main component
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

  // Common errors filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CommonErrorCategory | "All">("All");

  // Per-common-error check state: id -> result | "running" | null
  const [checkState, setCheckState] = useState<Record<string, CommonErrorCheckResult | "running" | null>>({});

  // Per-fix execution state
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);

  // Fix history
  const [fixHistory, setFixHistory] = useState<FixHistoryEntry[]>(() => loadFixHistory());

  // Toolbox panel — "todos los comandos posibles". USER lo usa más que los
  // errores comunes, así que arranca ABIERTO y se muestra arriba del todo.
  const [toolboxOpen, setToolboxOpen] = useState(true);
  const [toolboxFilter, setToolboxFilter] = useState("");

  // Common errors — sección colapsable, CERRADA por defecto (uso esporádico).
  const [commonErrorsOpen, setCommonErrorsOpen] = useState(false);

  // Event log panel
  const [eventLogOpen, setEventLogOpen] = useState(false);

  // Solve with AI
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
      const r = (await invoke("event_log_recent", { limit: 50, scope: "critical_and_error" })) as EventLogEntry[];
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
      const md = (await invoke("analyze_diagnostic_with_ai", { reportJson: JSON.stringify(report, null, 2) })) as string;
      setAnalysis(md);
    } catch (e) {
      setAnalysis(`**Error:** ${String(e)}`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function runCheck(error: CommonError) {
    setCheckState((prev) => ({ ...prev, [error.id]: "running" }));
    try {
      const result = (await invoke("diagnostics_run", { errorId: error.checkId })) as CommonErrorCheckResult;
      setCheckState((prev) => ({ ...prev, [error.id]: result }));
    } catch (e) {
      setCheckState((prev) => ({
        ...prev,
        [error.id]: { status: "fail", details: String(e), suggested_fix: null },
      }));
    }
  }

  async function runFix(fix: Fix, source: FixHistoryEntry["source"] = "toolbox", errorId?: string) {
    if (fix.confirm) {
      const ok = await confirmDialog(fix.confirm.message, { title: fix.confirm.title, kind: "warning" });
      if (!ok) return;
    }
    setFixBusy(fix.kind);
    setFixResult(null);
    try {
      const r = (await invoke("run_maintenance_command", { kind: fix.kind })) as MaintenanceResult;
      const entry: FixHistoryEntry = {
        ts: new Date().toISOString(),
        kind: fix.kind,
        label: fix.label,
        success: r.success,
        source,
        error_id: errorId,
      };
      const updated = pushFixHistory(entry);
      setFixHistory(updated);
      void appendFixHistory(entry);
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

  async function solveWithAi(problem: string) {
    setSolveSending(true);
    setSolveError(null);
    try {
      const prompt = buildSolvePrompt(problem, report, events);
      await invoke("spawn_session", { provider: "claude", prompt, cwd: null, flags: { dangerouslySkipPermissions: false } });
      setSolveOpen(false);
      setSolveProblem("");
      setFixResult("Solve with AI: Claude session spawned with diagnostic context.");
    } catch (e) {
      setSolveError(String(e));
    } finally {
      setSolveSending(false);
    }
  }

  // Filtered common errors
  const filteredErrors = COMMON_ERRORS.filter((e) => {
    const matchesCat = categoryFilter === "All" || e.category === categoryFilter;
    if (!matchesCat) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      e.title.toLowerCase().includes(q) ||
      e.symptom.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                               */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="rounded p-3"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
              Diagnostics &amp; Fixes
            </div>
            <div className="mt-0.5 text-[12px] leading-snug" style={{ color: "var(--color-text-tertiary)" }}>
              Selecciona un error conocido, haz clic en Diagnose para verificar si aplica, y usa Fix para corregirlo.
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button type="button" className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
              onClick={() => setSolveOpen(true)}>
              Solve with AI
            </button>
            <button type="button" className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
              onClick={() => setHistoryOpen((v) => !v)}>
              {historyOpen ? "Hide history" : "History"}
            </button>
            <button type="button" className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
              onClick={() => setScheduleOpen((v) => !v)}>
              {scheduleOpen ? "Hide schedule" : "Schedule"}
            </button>
            <button type="button"
              className="rounded px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
              onClick={() => { void run(); void loadEvents(); }}
              disabled={loading || eventsLoading}>
              {loading || eventsLoading ? "Running..." : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {err && (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-200">{err}</div>
      )}

      {fixResult && (
        <div className="rounded border px-3 py-2 text-[12px]"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-secondary)" }}>
          {fixResult}
        </div>
      )}

      {historyOpen && <DiagnosticHistoryPanel onSelect={(r) => { setReport(r); setHistoryOpen(false); }} />}
      {scheduleOpen && <DiagnosticSchedulePanel />}

      {/* ------------------------------------------------------------------ */}
      {/* App Health (compacto)                                               */}
      {/* ------------------------------------------------------------------ */}
      {report && <AppHealthCard report={report} />}

      {/* ------------------------------------------------------------------ */}
      {/* Toolbox Windows — "todos los comandos posibles" (prominente, arriba) */}
      {/* ------------------------------------------------------------------ */}
      <ToolboxPanel
        open={toolboxOpen}
        onToggle={() => setToolboxOpen((v) => !v)}
        filter={toolboxFilter}
        onFilterChange={setToolboxFilter}
        runFix={(fix) => void runFix(fix, "toolbox")}
        fixBusy={fixBusy}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Common Errors section (colapsable, cerrada por defecto)             */}
      {/* ------------------------------------------------------------------ */}
      <section
        className="rounded"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <button
          type="button"
          onClick={() => setCommonErrorsOpen((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors"
          style={{
            background: "var(--color-surface-1)",
            borderBottom: commonErrorsOpen ? "1px solid var(--color-border)" : "none",
          }}
        >
          <span className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Common errors
          </span>
          <span style={{ color: "var(--color-text-faint)" }}>{commonErrorsOpen ? "▲" : "▼"}</span>
        </button>

        {commonErrorsOpen && (
          <>
            <div
              className="px-3 py-2.5"
              style={{ borderBottom: "1px solid var(--color-border)" }}
            >
              {/* Search + category filter */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search common errors..."
                  className="min-w-[200px] flex-1 rounded px-2.5 py-1 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border)",
                    outline: "none",
                  }}
                />
                <div className="flex flex-wrap items-center gap-1">
                  {(["All", ...COMMON_ERROR_CATEGORIES] as Array<"All" | CommonErrorCategory>).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategoryFilter(cat)}
                      className="rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
                      style={{
                        background: categoryFilter === cat ? "var(--color-accent)" : "var(--color-surface-3)",
                        color: categoryFilter === cat ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredErrors.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
                No errors match "{searchQuery}".
              </div>
            )}

            <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
              {filteredErrors.map((error) => (
                <CommonErrorRow
                  key={error.id}
                  error={error}
                  checkResult={checkState[error.id] ?? null}
                  fixBusy={fixBusy}
                  onDiagnose={() => void runCheck(error)}
                  onFix={(fix, source, eid) => void runFix(fix, source, eid)}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Recent Fixes                                                        */}
      {/* ------------------------------------------------------------------ */}
      {fixHistory.length > 0 && (
        <RecentFixesPanel
          entries={fixHistory}
          onClear={() => {
            saveFixHistory([]);
            setFixHistory([]);
          }}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Event Log (collapsible)                                             */}
      {/* ------------------------------------------------------------------ */}
      <EventLogPanel
        open={eventLogOpen}
        onToggle={() => setEventLogOpen((v) => !v)}
        events={events}
        loading={eventsLoading}
        error={eventsErr}
        runFix={(fix) => void runFix(fix, "event_log")}
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
          onCancel={() => { setSolveOpen(false); setSolveError(null); }}
          onSend={() => {
            const trimmed = solveProblem.trim();
            if (!trimmed) { setSolveError("Describe the problem first."); return; }
            void solveWithAi(trimmed);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommonErrorRow
// ---------------------------------------------------------------------------

function CommonErrorRow({
  error,
  checkResult,
  fixBusy,
  onDiagnose,
  onFix,
}: {
  error: CommonError;
  checkResult: CommonErrorCheckResult | "running" | null;
  fixBusy: string | null;
  onDiagnose: () => void;
  onFix: (fix: Fix, source: FixHistoryEntry["source"], errorId: string) => void;
}) {
  const icon = severityIcon(error.severity);
  const [extraOpen, setExtraOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!extraOpen) return;
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setExtraOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [extraOpen]);

  const isRunning = checkResult === "running";
  const result = checkResult !== "running" ? checkResult : null;

  const hasExtraFixes = (error.extraFixes ?? []).length > 0;
  const primaryFix = error.primaryFixKind ? FIX_CATALOG[error.primaryFixKind] : null;

  return (
    <li className="px-3 py-3">
      <div className="flex items-start gap-3">
        {/* Severity icon */}
        <span
          className="mt-0.5 shrink-0 text-[14px]"
          title={error.severity}
          style={{ color: icon.color, lineHeight: 1 }}
        >
          {icon.symbol}
        </span>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
              {error.title}
            </span>
            <span
              className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {error.category}
            </span>
          </div>

          <div className="mt-0.5 text-[12px] leading-snug" style={{ color: "var(--color-text-secondary)" }}>
            {error.symptom}
          </div>

          {/* Check result */}
          {result && (
            <div
              className="mt-1.5 rounded px-2 py-1 text-[11.5px] leading-snug"
              style={{
                background:
                  result.status === "ok"
                    ? "rgba(63,185,80,0.08)"
                    : result.status === "fail"
                    ? "rgba(248,81,73,0.08)"
                    : "rgba(210,153,34,0.08)",
                border: `1px solid ${
                  result.status === "ok"
                    ? "rgba(63,185,80,0.25)"
                    : result.status === "fail"
                    ? "rgba(248,81,73,0.25)"
                    : "rgba(210,153,34,0.25)"
                }`,
                color:
                  result.status === "ok"
                    ? "var(--color-success, #3fb950)"
                    : result.status === "fail"
                    ? "var(--color-danger, #f85149)"
                    : "var(--color-warn, #d29922)",
              }}
            >
              <span className="font-semibold capitalize">{result.status}</span>
              {" — "}
              {result.details}
              {result.suggested_fix && (
                <span style={{ color: "var(--color-text-secondary)" }}>
                  {" "}Sugerencia: {result.suggested_fix}
                </span>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {/* Diagnose */}
            <button
              type="button"
              onClick={onDiagnose}
              disabled={isRunning}
              className="rounded border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
              style={{
                borderColor: "var(--color-border-strong)",
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
              }}
            >
              {isRunning ? "Checking..." : result ? "Re-check" : "Diagnose"}
            </button>

            {/* Primary Fix */}
            {primaryFix ? (
              <button
                type="button"
                onClick={() => onFix(primaryFix, "common_error", error.id)}
                disabled={fixBusy !== null}
                title={primaryFix.detail}
                className="rounded border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
                style={{
                  borderColor:
                    result?.status === "fail"
                      ? "rgba(248,81,73,0.5)"
                      : "var(--color-border-strong)",
                  background:
                    fixBusy === primaryFix.kind
                      ? "var(--color-accent)"
                      : result?.status === "fail"
                      ? "rgba(248,81,73,0.12)"
                      : "var(--color-surface-3)",
                  color:
                    fixBusy === primaryFix.kind
                      ? "var(--color-accent-text)"
                      : result?.status === "fail"
                      ? "var(--color-danger)"
                      : "var(--color-text)",
                }}
              >
                {fixBusy === primaryFix.kind ? "Running..." : `Fix: ${error.primaryFixLabel}`}
              </button>
            ) : (
              /* Non-automated fix — informational button */
              <span
                className="rounded border px-2.5 py-0.5 text-[11.5px] font-medium"
                style={{
                  borderColor: "var(--color-border)",
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                }}
                title="Este fix requiere acción manual — ver la descripción del síntoma"
              >
                Fix: {error.primaryFixLabel}
              </span>
            )}

            {/* More fixes dropdown */}
            {hasExtraFixes && (
              <div ref={dropdownRef} className="relative">
                <button
                  type="button"
                  onClick={() => setExtraOpen((v) => !v)}
                  disabled={fixBusy !== null}
                  className="rounded border px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
                  style={{
                    borderColor: "var(--color-border-strong)",
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  More {extraOpen ? "▲" : "▼"}
                </button>
                {extraOpen && (
                  <div
                    className="absolute left-0 top-full z-20 mt-1 min-w-[160px] rounded shadow-lg"
                    style={{
                      background: "var(--color-surface-1)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    {(error.extraFixes ?? []).map((ef) => {
                      const fix = FIX_CATALOG[ef.kind];
                      if (!fix) return null;
                      return (
                        <button
                          key={ef.kind}
                          type="button"
                          onClick={() => {
                            setExtraOpen(false);
                            onFix(fix, "common_error", error.id);
                          }}
                          title={fix.detail}
                          className="flex w-full items-start px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-white/5"
                          style={{ color: "var(--color-text)" }}
                        >
                          {ef.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Recent Fixes Panel
// ---------------------------------------------------------------------------

function RecentFixesPanel({
  entries,
  onClear,
}: {
  entries: FixHistoryEntry[];
  onClear: () => void;
}) {
  const shown = entries.slice(0, 10);
  return (
    <section
      className="rounded"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <header
        className="flex items-center justify-between px-3 py-2"
        style={{ background: "var(--color-surface-1)", borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          Recent fixes
        </div>
        <button
          type="button"
          onClick={onClear}
          className="text-[11px] transition-colors hover:underline"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Clear
        </button>
      </header>
      <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
        {shown.map((entry, i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-1.5">
            <span
              className="shrink-0 text-[11px]"
              style={{ color: entry.success ? "var(--color-success, #3fb950)" : "var(--color-danger)" }}
            >
              {entry.success ? "OK" : "FAIL"}
            </span>
            <span className="flex-1 truncate text-[12px]" style={{ color: "var(--color-text)" }}>
              {entry.label}
            </span>
            {entry.error_id && (
              <span className="shrink-0 truncate text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                {entry.error_id}
              </span>
            )}
            <span className="shrink-0 tabular-nums text-[11px]" style={{ color: "var(--color-text-faint, var(--color-text-tertiary))" }}>
              {new Date(entry.ts).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// App Health Card (compacto)
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
    <div className={`rounded border p-3 ${border}`}>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
        <span className={`font-mono ${glyph.color}`}>{glyph.ch}</span>
        App health
      </div>
      <div className="grid gap-1 sm:grid-cols-3">
        <HealthRow k="claude" v={report.app.claude_in_path ? "in PATH" : "missing"} ok={report.app.claude_in_path} />
        <HealthRow k="codex" v={report.app.codex_in_path ? "in PATH" : "missing"} ok={report.app.codex_in_path} />
        <HealthRow k="gemini" v={report.app.gemini_in_path ? "in PATH" : "missing"} ok={report.app.gemini_in_path} />
        <HealthRow k="mem0" v={report.app.mem0_configured ? "configured" : "not configured"} ok={report.app.mem0_configured} />
        <HealthRow k="projects.json" v={report.app.projects_json_ok ? "ok" : "missing/corrupt"} ok={report.app.projects_json_ok} />
      </div>
    </div>
  );
}

function HealthRow({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <div className="flex justify-between text-[12px]">
      <span style={{ color: "var(--color-text-tertiary)" }}>{k}</span>
      <span className="font-mono" style={{ color: ok ? "var(--color-success)" : "var(--color-warn)" }}>{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbox Panel (Windows fixes — collapsible, ahora cerrado por defecto)
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
    ? allFixes.filter((f) => f.label.toLowerCase().includes(q) || f.detail.toLowerCase().includes(q) || f.kind.toLowerCase().includes(q))
    : allFixes;

  const grouped: Record<FixCategory, Fix[]> = {
    network: [], services: [], update: [], storage: [], shell: [], diagnostic: [], system: [],
  };
  for (const fix of filtered) grouped[fix.category].push(fix);

  return (
    <section className="rounded" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}>
      <header
        className="flex cursor-pointer items-center justify-between px-3 py-2"
        style={{ background: "var(--color-surface-1)", borderBottom: open ? "1px solid var(--color-border)" : "none" }}
        onClick={onToggle}
      >
        <div>
          <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Windows Toolbox <span style={{ color: "var(--color-text-tertiary)", fontWeight: 400 }}>· {allFixes.length} comandos</span>
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Fixes de red, servicios, Windows Update, almacenamiento, shell y diagnósticos. No requieren un error detectado.
          </div>
        </div>
        <span className="ml-3 shrink-0 font-mono text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          {open ? "▾" : "▸"}
        </span>
      </header>

      {open && (
        <div className="p-3">
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter by name, kind or description..."
            className="mb-3 w-full rounded px-2 py-1 text-[12px]"
            style={{ background: "var(--color-surface-1)", color: "var(--color-text)", border: "1px solid var(--color-border)", outline: "none" }}
          />
          {filtered.length === 0 && (
            <div className="px-2 py-4 text-center text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              No commands match "{filter}".
            </div>
          )}
          <div className="space-y-3">
            {CATEGORY_ORDER.map((cat) => {
              const items = grouped[cat];
              if (items.length === 0) return null;
              return (
                <div key={cat}>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                    {CATEGORY_LABELS[cat]} · {items.length}
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((fix) => (
                      <ToolboxCard key={fix.kind} fix={fix} runFix={runFix} fixBusy={fixBusy} />
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

function ToolboxCard({ fix, runFix, fixBusy }: { fix: Fix; runFix: (fix: Fix) => void | Promise<void>; fixBusy: string | null }) {
  const busy = fixBusy === fix.kind;
  return (
    <div className="flex items-start justify-between gap-2 rounded p-2"
      style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold" style={{ color: "var(--color-text)" }}>{fix.label}</div>
        <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug" style={{ color: "var(--color-text-tertiary)" }} title={fix.detail}>{fix.detail}</div>
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
        {busy ? "Running..." : "Run"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event Log Panel (collapsible)
// ---------------------------------------------------------------------------

function EventLogPanel({
  open,
  onToggle,
  events,
  loading,
  error,
  runFix,
  fixBusy,
  onRefresh,
}: {
  open: boolean;
  onToggle: () => void;
  events: EventLogEntry[];
  loading: boolean;
  error: string | null;
  runFix: (fix: Fix) => void | Promise<void>;
  fixBusy: string | null;
  onRefresh: () => void;
}) {
  const visible = events.slice(0, 25);

  return (
    <section className="rounded" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}>
      <header
        className="flex cursor-pointer items-center justify-between px-3 py-2"
        style={{ background: "var(--color-surface-1)", borderBottom: open ? "1px solid var(--color-border)" : "none" }}
        onClick={onToggle}
      >
        <div>
          <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Windows Event Log
            {events.length > 0 && (
              <span className="ml-2 rounded px-1.5 py-px text-[10px] font-medium"
                style={{ background: "rgba(248,81,73,0.15)", color: "var(--color-danger)" }}>
                {events.length} events
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Errores recientes del Event Log de Windows (Critical + Error) con fixes sugeridos por ID.
          </div>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRefresh(); }}
            disabled={loading}
            className="rounded px-2.5 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
          >
            {loading ? "..." : "Refresh"}
          </button>
          <span className="font-mono text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            {open ? "▾" : "▸"}
          </span>
        </div>
      </header>

      {open && (
        <>
          {error && (
            <div className="m-3 rounded p-2 text-[12px]"
              style={{ background: "rgba(248,81,73,0.06)", border: "1px solid rgba(248,81,73,0.22)", color: "var(--color-danger)", fontFamily: "var(--font-mono, ui-monospace)" }}>
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
                <EventLogRow key={`${evt.time_created}-${idx}`} evt={evt} runFix={runFix} fixBusy={fixBusy} />
              ))}
            </ul>
          )}
          {events.length > visible.length && (
            <div className="px-3 py-2 text-[11px]" style={{ color: "var(--color-text-faint)" }}>
              ... {events.length - visible.length} more — open Event Viewer for the full list.
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EventLogRow({ evt, runFix, fixBusy }: { evt: EventLogEntry; runFix: (fix: Fix) => void | Promise<void>; fixBusy: string | null }) {
  const known = KNOWN_ERRORS[evt.event_id];
  const badge = levelBadge(evt.level);
  const fixKinds = known ? known.fixes : GENERIC_FIXES;

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide"
          style={{ background: badge.bg, color: badge.fg }}>
          {badge.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]" style={{ color: "var(--color-text)" }}>
            <span className="font-semibold tabular-nums">id {evt.event_id}</span>
            <span className="truncate" style={{ color: "var(--color-text-secondary)" }} title={evt.source}>{evt.source || "—"}</span>
            <span className="ml-auto shrink-0 tabular-nums text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>{evt.time_created}</span>
          </div>
          {known ? (
            <div className="mt-1 text-[12.5px] leading-snug" style={{ color: "var(--color-text-secondary)" }}>{known.description}</div>
          ) : (
            evt.message && (
              <div className="mt-1 line-clamp-2 text-[12px] leading-snug"
                style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono, ui-monospace)" }}
                title={evt.message}>
                {evt.message}
              </div>
            )
          )}
          {fixKinds.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {fixKinds.map((k) => FIX_CATALOG[k]).filter((f): f is Fix => !!f).map((f) => {
                const busy = fixBusy === f.kind;
                return (
                  <button key={f.kind} type="button" onClick={() => void runFix(f)} disabled={fixBusy !== null}
                    title={f.detail}
                    className="rounded border px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
                    style={{
                      borderColor: "var(--color-border-strong)",
                      background: busy ? "var(--color-accent)" : "var(--color-surface-3)",
                      color: busy ? "var(--color-accent-text)" : "var(--color-text)",
                    }}>
                    {busy ? "Running..." : f.label}
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
// Solve with AI modal
// ---------------------------------------------------------------------------

function SolveWithAiModal({
  problem, onProblemChange, sending, error, eventsCount, hasReport, onCancel, onSend,
}: {
  problem: string; onProblemChange: (v: string) => void; sending: boolean; error: string | null;
  eventsCount: number; hasReport: boolean; onCancel: () => void; onSend: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onCancel}>
      <div className="w-full max-w-lg rounded p-4"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>Solve with AI</div>
        <div className="mb-3 text-[12px] leading-snug" style={{ color: "var(--color-text-tertiary)" }}>
          Describe the problem. Claude will be spawned with the current diagnostic snapshot ({eventsCount} recent events
          {hasReport ? ", App health" : ""}, {Object.keys(FIX_CATALOG).length} available fixes).
        </div>
        <textarea
          value={problem}
          onChange={(e) => onProblemChange(e.target.value)}
          placeholder="e.g. Mem0 returns 401 on every call, Claude session spawns then dies immediately..."
          rows={5}
          className="w-full rounded p-2 text-[12.5px]"
          style={{ background: "var(--color-surface-1)", color: "var(--color-text)", border: "1px solid var(--color-border)", outline: "none", resize: "vertical" }}
          autoFocus
        />
        {error && (
          <div className="mt-2 rounded px-2 py-1.5 text-[12px]"
            style={{ background: "rgba(248,81,73,0.10)", border: "1px solid rgba(248,81,73,0.30)", color: "var(--color-danger)" }}>
            {error}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-1.5">
          <button type="button" onClick={onCancel} disabled={sending}
            className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}>
            Cancel
          </button>
          <button type="button" onClick={onSend} disabled={sending}
            className="rounded px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
            {sending ? "Spawning..." : "Send to Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// buildSolvePrompt
// ---------------------------------------------------------------------------

function buildSolvePrompt(problem: string, report: DiagnosticReport | null, events: EventLogEntry[]): string {
  const recent = events.slice(0, 10);
  const eventBlock = recent.length === 0
    ? "(no critical/error events in the recent window)"
    : recent.map((e) => `- [${e.level}] id=${e.event_id} src=${e.source} at=${e.time_created}\n  ${(e.message || "").replace(/\s+/g, " ").trim().slice(0, 240)}`).join("\n");

  const healthBlock = report
    ? [`projects.json: ${report.app.projects_json_ok ? "ok" : "MISSING/CORRUPT"}`, `claude in PATH: ${report.app.claude_in_path ? "yes" : "no"}`, `codex in PATH: ${report.app.codex_in_path ? "yes" : "no"}`, `gemini in PATH: ${report.app.gemini_in_path ? "yes" : "no"}`, `mem0 configured: ${report.app.mem0_configured ? "yes" : "no"}`].join("\n")
    : "(no app health snapshot loaded)";

  const fixBlock = Object.values(FIX_CATALOG).map((f) => `- ${f.kind} (${CATEGORY_LABELS[f.category]}) — ${f.label}: ${f.detail}`).join("\n");

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
