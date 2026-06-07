import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  InstalledApp,
  InstalledAppsReport,
  UninstallAppResult,
} from "../types";
import { Diagnostics } from "./system/Diagnostics";

// v2.7 cleanup (internal audit 2026-05-24):
//   - Bloatware sub-tab DROPPED: most catalog entries weren't present on his
//     box. He wants the same card-driven layout applied to his REAL apps so
//     he can spot abandoned installs instead.
//   - Troubleshooting sub-tab DROPPED: merged into Diagnostics under the
//     new "Diagnostics & Fixes" tab.
//   - Apps panel REDESIGNED: Library-style cartillas grouped by usage
//     category (Development / Games / Media / Productivity / System / Other)
//     with bigger type + horizontal cards. Each app exposes Folder + Uninstall.
//   - Hooks sub-tab REMOVED from System: Hooks now lives exclusively in
//     Library (Library > Hooks). Keeping it in two places caused confusion.
type SystemSubTab = "diagnostics" | "apps";

// ---------------------------------------------------------------------------
// App categorisation heuristic
// ---------------------------------------------------------------------------

type AppCategory =
  | "Development"
  | "Games"
  | "Media"
  | "Productivity"
  | "System utilities"
  | "Other";

const CATEGORY_ORDER: AppCategory[] = [
  "Development",
  "Games",
  "Media",
  "Productivity",
  "System utilities",
  "Other",
];

// Stable per-app identifier used as the key in the override map. Mirrors the
// React key already used inside CategoryCard so the two never drift.
function appId(app: InstalledApp): string {
  return `${app.provider}|${app.name}|${app.package_id ?? ""}`;
}

// localStorage key for the manual / AI override map.
const OVERRIDES_LS_KEY = "ultron.apps.category_overrides";

type CategoryOverrides = Record<string, AppCategory>;

function loadOverrides(): CategoryOverrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: CategoryOverrides = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && (CATEGORY_ORDER as readonly string[]).includes(v)) {
          out[k] = v as AppCategory;
        }
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function saveOverrides(map: CategoryOverrides) {
  try {
    localStorage.setItem(OVERRIDES_LS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Quick keyword-based classifier. Runs over (name + publisher) so we catch
 *  both "Visual Studio Code" and "Microsoft Corporation" → publisher-based
 *  matches. Cheap and good enough for a first pass. */
function classifyApp(app: InstalledApp): AppCategory {
  const hay = `${app.name} ${app.publisher ?? ""}`.toLowerCase();

  const dev = [
    "visual studio",
    "vscode",
    "code -",
    "intellij",
    "jetbrains",
    "rider",
    "pycharm",
    "webstorm",
    "android studio",
    "git",
    "github",
    "node",
    "npm",
    "python",
    "rust",
    "cargo",
    "docker",
    "postman",
    "insomnia",
    "sourcetree",
    "fork",
    "tortoise",
    "wireshark",
    "vmware",
    "virtualbox",
    "wsl",
    "putty",
    "filezilla",
    "winscp",
    "sublime",
    "notepad++",
    "windows terminal",
    "powershell",
    "tauri",
    "claude code",
    "anthropic",
    "openai",
  ];
  if (dev.some((k) => hay.includes(k))) return "Development";

  const games = [
    "steam",
    "epic games",
    "ubisoft",
    "ea app",
    "ea games",
    "origin",
    "gog galaxy",
    "battle.net",
    "blizzard",
    "rockstar",
    "minecraft",
    "riot",
    "league of legends",
    "valorant",
    "discord",
    "twitch",
    "xbox",
    "nvidia",
    "geforce",
    "razer",
    "logitech g hub",
    "playstation",
  ];
  if (games.some((k) => hay.includes(k))) return "Games";

  const media = [
    "spotify",
    "vlc",
    "obs",
    "kdenlive",
    "davinci",
    "premiere",
    "audacity",
    "photoshop",
    "lightroom",
    "after effects",
    "media player",
    "movies",
    "music",
    "netflix",
    "youtube",
    "plex",
    "kodi",
    "winamp",
    "iTunes",
    "handbrake",
    "krita",
    "gimp",
    "inkscape",
    "blender",
    "figma",
  ];
  if (media.some((k) => hay.includes(k))) return "Media";

  const productivity = [
    "office",
    "word",
    "excel",
    "powerpoint",
    "outlook",
    "onenote",
    "onedrive",
    "teams",
    "slack",
    "zoom",
    "notion",
    "obsidian",
    "evernote",
    "todoist",
    "trello",
    "asana",
    "anki",
    "calibre",
    "acrobat",
    "adobe reader",
    "libreoffice",
    "okular",
    "sumatra",
    "1password",
    "bitwarden",
    "lastpass",
    "keepass",
  ];
  if (productivity.some((k) => hay.includes(k))) return "Productivity";

  const system = [
    "driver",
    "redistributable",
    "runtime",
    "directx",
    "powertoys",
    "7-zip",
    "winrar",
    "rufus",
    "everything",
    "ccleaner",
    "treesize",
    "crystaldiskinfo",
    "hwinfo",
    "msi afterburner",
    "displaylink",
    "logi options",
    "synaptics",
    "realtek",
    "intel",
    "amd ",
    "asus",
    "lenovo",
    "dell",
    "hp ",
  ];
  if (system.some((k) => hay.includes(k))) return "System utilities";

  return "Other";
}

// ---------------------------------------------------------------------------
// Enhanced classifier — publisher-first DB with hand-curated mappings. Used
// when the user hits "Auto-categorize" so we get better buckets than the
// quick keyword fallback above.
// ---------------------------------------------------------------------------

const PUBLISHER_CATEGORY: Array<[RegExp, AppCategory]> = [
  // Development
  [/\bjetbrains\b/i, "Development"],
  [/\bgithub\b/i, "Development"],
  [/\bgitlab\b/i, "Development"],
  [/\banthropic\b/i, "Development"],
  [/\bopenai\b/i, "Development"],
  [/\bdocker\b/i, "Development"],
  [/\bhashicorp\b/i, "Development"],
  [/\bcanonical\b/i, "Development"],
  [/\bpostman\b/i, "Development"],
  [/\bsublimehq\b/i, "Development"],
  [/\bnotepad\+\+\b/i, "Development"],
  [/\boracle\b/i, "Development"],
  [/\bpython software foundation\b/i, "Development"],
  [/\bnode\.?js foundation\b/i, "Development"],
  [/\brust foundation\b/i, "Development"],
  [/\bmongodb\b/i, "Development"],
  [/\bpostgresql\b/i, "Development"],

  // Games / gaming platforms
  [/\bvalve\b/i, "Games"],
  [/\bepic games\b/i, "Games"],
  [/\bubisoft\b/i, "Games"],
  [/\belectronic arts\b/i, "Games"],
  [/\briot games\b/i, "Games"],
  [/\bblizzard\b/i, "Games"],
  [/\bactivision\b/i, "Games"],
  [/\brockstar\b/i, "Games"],
  [/\bmojang\b/i, "Games"],
  [/\bgog\.com\b/i, "Games"],
  [/\bcd projekt\b/i, "Games"],
  [/\bbethesda\b/i, "Games"],
  [/\b2k games\b/i, "Games"],
  [/\bsquare enix\b/i, "Games"],
  [/\bcapcom\b/i, "Games"],
  [/\bbandai namco\b/i, "Games"],

  // Media / creative
  [/\badobe\b/i, "Media"],
  [/\bspotify ab\b/i, "Media"],
  [/\bspotify\b/i, "Media"],
  [/\bnetflix\b/i, "Media"],
  [/\bplex\b/i, "Media"],
  [/\bvideolan\b/i, "Media"],
  [/\bblender foundation\b/i, "Media"],
  [/\bautodesk\b/i, "Media"],
  [/\bobs project\b/i, "Media"],
  [/\bobsproject\b/i, "Media"],
  [/\bxsplit\b/i, "Media"],
  [/\baudacity\b/i, "Media"],
  [/\bsteinberg\b/i, "Media"],
  [/\bnative instruments\b/i, "Media"],
  [/\bavid technology\b/i, "Media"],

  // Productivity / comms / utilities-for-humans
  [/\bdiscord inc\b/i, "Productivity"],
  [/\bdiscord\b/i, "Productivity"],
  [/\bslack technologies\b/i, "Productivity"],
  [/\bzoom video communications\b/i, "Productivity"],
  [/\bnotion labs\b/i, "Productivity"],
  [/\bgoogle llc\b/i, "Productivity"],
  [/\bmozilla\b/i, "Productivity"],
  [/\bbrave software\b/i, "Productivity"],
  [/\bopera\b/i, "Productivity"],
  [/\b1password\b/i, "Productivity"],
  [/\bagilebits\b/i, "Productivity"],
  [/\bbitwarden\b/i, "Productivity"],
  [/\bdropbox\b/i, "Productivity"],
  [/\bevernote\b/i, "Productivity"],
  [/\bdoist\b/i, "Productivity"],
  [/\btrello\b/i, "Productivity"],
  [/\basana\b/i, "Productivity"],
  [/\blibreoffice\b/i, "Productivity"],
  [/\bthe document foundation\b/i, "Productivity"],

  // System utilities / drivers / OEM
  [/\bnvidia corporation\b/i, "System utilities"],
  [/\bintel corporation\b/i, "System utilities"],
  [/\badvanced micro devices\b/i, "System utilities"],
  [/\brealtek\b/i, "System utilities"],
  [/\bsynaptics\b/i, "System utilities"],
  [/\bconexant\b/i, "System utilities"],
  [/\bdell\b/i, "System utilities"],
  [/\bhp inc\b/i, "System utilities"],
  [/\blenovo\b/i, "System utilities"],
  [/\basustek\b/i, "System utilities"],
  [/\basus\b/i, "System utilities"],
  [/\bmsi\b/i, "System utilities"],
  [/\bgigabyte\b/i, "System utilities"],
  [/\blogitech\b/i, "System utilities"],
  [/\brazer\b/i, "System utilities"],
  [/\bcorsair\b/i, "System utilities"],
];

// Hand-tuned name → category overrides. Applied before publisher rules so
// well-known apps published by Microsoft / Google / etc. get the right
// bucket regardless of who shipped them.
const NAME_CATEGORY: Array<[RegExp, AppCategory]> = [
  // Development
  [/\bvisual studio\b/i, "Development"],
  [/\bvs ?code\b/i, "Development"],
  [/\bandroid studio\b/i, "Development"],
  [/\bxcode\b/i, "Development"],
  [/\bwindows terminal\b/i, "Development"],
  [/\bpowershell\b/i, "Development"],
  [/\bwsl\b/i, "Development"],
  [/\bdocker desktop\b/i, "Development"],
  [/\bgit (for windows|bash|gui)\b/i, "Development"],
  [/\bgithub desktop\b/i, "Development"],
  [/\bsourcetree\b/i, "Development"],
  [/\bfork\b/i, "Development"],
  [/\bclaude code\b/i, "Development"],
  [/\bcursor\b/i, "Development"],
  [/\bzed\b/i, "Development"],
  [/\bunity hub\b/i, "Development"],
  [/\bunreal engine\b/i, "Development"],
  [/\bepic games launcher\b/i, "Games"], // override -> games launcher

  // Games
  [/\bsteam\b/i, "Games"],
  [/\bminecraft\b/i, "Games"],
  [/\bvalorant\b/i, "Games"],
  [/\bleague of legends\b/i, "Games"],
  [/\bbattle\.net\b/i, "Games"],
  [/\bea (app|desktop|origin)\b/i, "Games"],
  [/\bgog galaxy\b/i, "Games"],
  [/\briot client\b/i, "Games"],

  // Media
  [/\bphotoshop\b/i, "Media"],
  [/\billustrator\b/i, "Media"],
  [/\bpremiere\b/i, "Media"],
  [/\bafter effects\b/i, "Media"],
  [/\blightroom\b/i, "Media"],
  [/\baudition\b/i, "Media"],
  [/\bblender\b/i, "Media"],
  [/\bkrita\b/i, "Media"],
  [/\bgimp\b/i, "Media"],
  [/\binkscape\b/i, "Media"],
  [/\bfigma\b/i, "Media"],
  [/\bspotify\b/i, "Media"],
  [/\bvlc\b/i, "Media"],
  [/\bplex\b/i, "Media"],
  [/\bobs studio\b/i, "Media"],
  [/\bdavinci resolve\b/i, "Media"],
  [/\bhandbrake\b/i, "Media"],

  // Productivity / comms
  [/\bdiscord\b/i, "Productivity"],
  [/\bslack\b/i, "Productivity"],
  [/\bzoom\b/i, "Productivity"],
  [/\bmicrosoft teams\b/i, "Productivity"],
  [/\bnotion\b/i, "Productivity"],
  [/\bobsidian\b/i, "Productivity"],
  [/\bevernote\b/i, "Productivity"],
  [/\bonenote\b/i, "Productivity"],
  [/\bchrome\b/i, "Productivity"],
  [/\bfirefox\b/i, "Productivity"],
  [/\bbrave\b/i, "Productivity"],
  [/\bedge\b/i, "Productivity"],
  [/\bopera\b/i, "Productivity"],
  [/\bthunderbird\b/i, "Productivity"],
  [/\boutlook\b/i, "Productivity"],
  [/\bword\b/i, "Productivity"],
  [/\bexcel\b/i, "Productivity"],
  [/\bpowerpoint\b/i, "Productivity"],
  [/\bacrobat\b/i, "Productivity"],
  [/\b1password\b/i, "Productivity"],
  [/\bbitwarden\b/i, "Productivity"],

  // System
  [/\bredistributable\b/i, "System utilities"],
  [/\b\.net (runtime|framework)\b/i, "System utilities"],
  [/\bvisual c\+\+\b/i, "System utilities"],
  [/\bdirectx\b/i, "System utilities"],
  [/\bpowertoys\b/i, "System utilities"],
  [/\b7-zip\b/i, "System utilities"],
  [/\bwinrar\b/i, "System utilities"],
];

function enhancedClassifyApp(app: InstalledApp): AppCategory {
  const name = app.name || "";
  const publisher = app.publisher || "";

  // 1) Hand-tuned name rules first (most specific).
  for (const [re, cat] of NAME_CATEGORY) {
    if (re.test(name)) return cat;
  }

  // 2) Publisher DB.
  for (const [re, cat] of PUBLISHER_CATEGORY) {
    if (re.test(publisher)) return cat;
  }

  // 3) Install-location hint (Steam apps land under steamapps\common).
  const loc = (app.install_location || "").toLowerCase();
  if (loc.includes("steamapps\\common")) return "Games";
  if (loc.includes("\\epic games\\")) return "Games";
  if (loc.includes("\\riot games\\")) return "Games";

  // 4) Fall back to the original keyword classifier.
  return classifyApp(app);
}

// ---------------------------------------------------------------------------
// Apps panel — Library-style cartillas (one per category) with horizontal,
// large-typography rows. Replaces the old dense grid layout.
// ---------------------------------------------------------------------------

const CATEGORY_DESCRIPTIONS: Record<AppCategory, string> = {
  Development: "IDEs, language runtimes, CLI tooling, git clients, containers.",
  Games: "Game launchers, titles and game-related peripherals.",
  Media: "Streaming, players, image and video editing.",
  Productivity: "Office suites, note-taking, communication, document readers.",
  "System utilities": "Drivers, runtimes, archivers, OEM helpers.",
  Other: "Everything that didn't match a known category.",
};

function effectiveCategory(
  app: InstalledApp,
  overrides: CategoryOverrides,
): AppCategory {
  const id = appId(app);
  const override = overrides[id];
  if (override) return override;
  return classifyApp(app);
}

function classifyAppList(
  apps: InstalledApp[],
  overrides: CategoryOverrides,
): Map<AppCategory, InstalledApp[]> {
  const buckets = new Map<AppCategory, InstalledApp[]>();
  for (const c of CATEGORY_ORDER) buckets.set(c, []);
  for (const a of apps) {
    const cat = effectiveCategory(a, overrides);
    const arr = buckets.get(cat) ?? [];
    arr.push(a);
    buckets.set(cat, arr);
  }
  for (const [, arr] of buckets) {
    arr.sort((x, y) => x.name.localeCompare(y.name));
  }
  return buckets;
}

function UninstallModal({
  appInfo,
  onClose,
  onDone,
}: {
  appInfo: InstalledApp;
  onClose: () => void;
  onDone: (result: UninstallAppResult) => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = typed.trim() === appInfo.name.trim() && !busy;

  async function go() {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      const r = (await invoke("uninstall_app", {
        name: appInfo.name,
        provider: appInfo.provider,
        packageId: appInfo.package_id,
      })) as UninstallAppResult;
      onDone(r);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded p-4"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
          Uninstall {appInfo.name}?
        </div>
        <div
          className="mb-3 text-[12.5px] leading-snug"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Routes through the {appInfo.provider} uninstaller. Irreversible. Type the app
          name to confirm.
        </div>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={appInfo.name}
          className="w-full rounded px-2 py-1.5 text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            fontFamily: "var(--font-mono)",
          }}
        />
        {error && (
          <div
            className="mt-2 rounded p-2 text-[12px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={go}
            disabled={!armed}
            className="rounded px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "rgba(248, 81, 73, 0.85)",
              color: "white",
            }}
          >
            {busy ? "Uninstalling…" : "Uninstall"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single horizontal app card. Bigger font, more breathing room than the
// previous dense grid row.
// ---------------------------------------------------------------------------

function AppCard({
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

// ---------------------------------------------------------------------------
// Category cartilla — collapsible card that holds every app in the bucket.
// ---------------------------------------------------------------------------

function CategoryCard({
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

function AppsPanel() {
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

// ---------------------------------------------------------------------------
// Top-level System tab.
// ---------------------------------------------------------------------------

export function System() {
  const [subTab, setSubTab] = useState<SystemSubTab>("diagnostics");

  return (
    <div className="pb-8">
      <SystemHeader subTab={subTab} setSubTab={setSubTab} />
      <div className="px-10">
        {subTab === "apps" && <AppsPanel />}
        {subTab === "diagnostics" && <Diagnostics />}
      </div>
    </div>
  );
}

const CONTEXT_HINTS: Record<SystemSubTab, string> = {
  apps:
    'Abre Apps cuando una instalación quedó abandonada, un programa ralentiza el sistema, o quieres saber qué hay instalado antes de liberar espacio.',
  diagnostics:
    'Abre Diagnostics cuando Claude Code no arranca, la terminal no abre, aparecen errores de permisos, o quieres ejecutar fixes del Event Log con un clic.',
};

function SystemHeader({
  subTab,
  setSubTab,
}: {
  subTab: SystemSubTab;
  setSubTab: (t: SystemSubTab) => void;
}) {
  const TABS: { id: SystemSubTab; label: string }[] = [
    { id: "diagnostics", label: "Diagnostics & Fixes" },
    { id: "apps", label: "Apps" },
  ];
  return (
    <header className="mb-5 flex flex-wrap items-baseline justify-between gap-4 px-10 pt-8">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight">System</h1>
        <p
          className="mt-1 text-[13.5px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Installed apps grouped by usage · on-demand PC diagnostics with one-click fixes.
        </p>
        <div
          className="mt-3 inline-flex rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className="rounded px-3.5 py-1.5 text-[13px] font-medium transition-colors"
              style={{
                background: subTab === t.id ? "var(--color-surface-3)" : "transparent",
                color: subTab === t.id ? "var(--color-text)" : "var(--color-text-tertiary)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p
          className="mt-2 text-[12px] leading-snug"
          style={{ color: "var(--color-text-faint, var(--color-text-tertiary))" }}
        >
          {CONTEXT_HINTS[subTab]}
        </p>
      </div>
    </header>
  );
}
