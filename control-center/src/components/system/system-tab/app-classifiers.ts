// App categorisation heuristics: keyword classifier, enhanced publisher DB,
// and group-by-category helpers.

import type { InstalledApp } from "../../../types";
import {
  type AppCategory,
  type CategoryOverrides,
  CATEGORY_ORDER,
  appId,
} from "./types";

/** Quick keyword-based classifier. Runs over (name + publisher) so we catch
 *  both "Visual Studio Code" and "Microsoft Corporation" → publisher-based
 *  matches. Cheap and good enough for a first pass. */
export function classifyApp(app: InstalledApp): AppCategory {
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

export function enhancedClassifyApp(app: InstalledApp): AppCategory {
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

export function effectiveCategory(
  app: InstalledApp,
  overrides: CategoryOverrides,
): AppCategory {
  const id = appId(app);
  const override = overrides[id];
  if (override) return override;
  return classifyApp(app);
}

export function classifyAppList(
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
