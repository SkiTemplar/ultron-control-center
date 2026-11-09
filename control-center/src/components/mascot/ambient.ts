// Mascota — qué estás haciendo, para el ánimo de Pupus (funciones puras).
//
// Entradas, todas locales y sin tokens: la ventana en primer plano que ya
// vigila desk_watch.rs (ejecutable, título, juego de la tabla, pantalla
// completa), el tiempo sin tocar teclado ni ratón y si alguna app usa el
// micrófono (presence.rs). Los títulos solo se miran aquí: no se guardan.
//
// Alcance real: la llamada se deduce del micrófono en uso (un dictado
// también cuenta) o del título de la ventana (Teams, Zoom, Meet, Discord
// con voz); los títulos cambian con el idioma y la versión, así que habrá
// llamadas que no se vean.

import type { EpisodeKind } from "./episodes";

export type Activity = "ide" | "terminal" | "navegador" | "juego" | "llamada" | "video" | "ultron" | "otro";

export interface ForegroundLike {
  exe: string;
  title: string;
  /** Juego de la tabla de Settings (desk_watch.rs), o null. */
  game?: unknown;
  /** Silencio de juego (juego de la tabla o pantalla completa). */
  quiet?: boolean;
}

export interface AmbientSample {
  atMs: number;
  activity: Activity;
  /** Milisegundos sin tocar teclado ni ratón (null = no se sabe). */
  idleMs: number | null;
}

/** Sin tocar nada desde hace esto, te has ido. */
export const AWAY_MS = 5 * 60_000;

const BY_EXE: [RegExp, Activity][] = [
  [/^(code|cursor|devenv|rider64|clion64|idea64|pycharm64|webstorm64|zed|unrealeditor|unity|sublime_text)\.exe$/, "ide"],
  [/^(windowsterminal|wt|pwsh|powershell|cmd|wezterm-gui|alacritty|mintty)\.exe$/, "terminal"],
  [/^(vlc|mpv|mpc-hc64|potplayermini64)\.exe$/, "video"],
  [/^control-center\.exe$/, "ultron"],
  [/^(chrome|msedge|firefox|brave|opera|vivaldi|arc)\.exe$/, "navegador"],
];

const CALL_TITLE = /reuni[oó]n|meeting|llamada|\bcall\b/i;
const VOICE_TITLE = /\bvoz\b|\bvoice\b|llamada|\bcall\b/i;
const VIDEO_TITLE = /youtube|netflix|twitch|prime video|disney\+|\bmax\b/i;

function isCallWindow(exe: string, title: string): boolean {
  if (/^zoom\.exe$/.test(exe)) return CALL_TITLE.test(title) || /zoom meeting|reuni[oó]n de zoom/i.test(title);
  if (/^(ms-teams|teams)\.exe$/.test(exe)) return CALL_TITLE.test(title);
  if (/^discord\.exe$/.test(exe)) return VOICE_TITLE.test(title);
  return /^meet -|google meet/i.test(title);
}

/** Actividad según la ventana delante y el micrófono. */
export function classifyForeground(fg: ForegroundLike | null, mic = false): Activity {
  if (fg && (fg.game || fg.quiet)) return "juego";
  const exe = (fg?.exe ?? "").toLowerCase();
  const title = fg?.title ?? "";
  if (mic || (fg && isCallWindow(exe, title))) return "llamada";
  if (!fg) return "otro";
  for (const [re, act] of BY_EXE) {
    if (!re.test(exe)) continue;
    return act === "navegador" && VIDEO_TITLE.test(title) ? "video" : act;
  }
  return "otro";
}

const isAway = (s: AmbientSample) => s.idleMs !== null && s.idleMs >= AWAY_MS;

function edge(prev: boolean, next: boolean, on: EpisodeKind, off: EpisodeKind): EpisodeKind[] {
  if (prev === next) return [];
  return [next ? on : off];
}

/**
 * Sucesos entre dos muestras. La primera (`prev = null`) no emite nada: lo
 * que ya estaba así al arrancar no es noticia. Volver = el tiempo sin
 * tocar nada baja de AWAY_MS (solo baja con una entrada tuya).
 */
export function diffAmbient(prev: AmbientSample | null, next: AmbientSample): EpisodeKind[] {
  if (!prev) return [];
  const out: EpisodeKind[] = [];
  out.push(...edge(prev.activity === "juego", next.activity === "juego", "juegoEmpieza", "juegoTermina"));
  out.push(...edge(prev.activity === "llamada", next.activity === "llamada", "llamadaEmpieza", "llamadaTermina"));
  if (prev.idleMs !== null && next.idleMs !== null) out.push(...edge(isAway(prev), isAway(next), "teVas", "vuelves"));
  return out;
}

/** ¿Actividad en la que conviene no distraerte (sin travesuras ni paseos largos)? */
export function isFocusActivity(a: Activity): boolean {
  return a === "ide" || a === "terminal" || a === "llamada";
}
