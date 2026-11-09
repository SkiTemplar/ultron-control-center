// Mascota — ajustes (espejo de MascotSettings en src-tauri/src/mascot/mod.rs,
// guardados en ~/.ultron/cockpit/mascot.json) y la tabla de juegos.

/** Disfraces que sabe pintar Pupus con un juego delante. */
export type GameOutfit = "car" | "pirate" | "tactical" | "none";

export const OUTFITS: readonly GameOutfit[] = ["car", "pirate", "tactical", "none"];

export interface GameEntry {
  /** Nombre del ejecutable en minúsculas, sin ruta («cs2.exe»). */
  exe: string;
  name: string;
  outfit: GameOutfit;
}

export const DEFAULT_GAMES: readonly GameEntry[] = [
  { exe: "rocketleague.exe", name: "Rocket League", outfit: "car" },
  { exe: "sotgame.exe", name: "Sea of Thieves", outfit: "pirate" },
  { exe: "cs2.exe", name: "Counter-Strike 2", outfit: "tactical" },
];

/** Tope de la tabla (el mismo que games.rs). */
export const MAX_GAMES = 64;

export interface MascotSettings {
  enabled: boolean;
  scale: number;
  wander: boolean;
  climb_windows: boolean;
  collide_windows: boolean;
  jump: boolean;
  splat: boolean;
  gravity: number;
  bounciness: number;
  eyes_follow_cursor: boolean;
  sleep_after_min: number;
  drive_with_mcp: boolean;
  hang_struggle: boolean;
  hats: boolean;
  cursor_pranks: boolean;
  claude_model: string;
  codex_model: string;
  /** Con un juego delante, Pupus no molesta. */
  game_mode: boolean;
  games: GameEntry[];
  /** Va a señalar en la barra de tareas el botón que reclama atención. */
  taskbar_hints: boolean;
  /** Barra transparente con islas: se posa en ellas y, en los huecos, abajo del todo. */
  taskbar_islands: boolean;
  /** Con una sesión esperando permiso, se cuelga junto a su fila en Sessions y la señala. */
  /** Sale en grabaciones de pantalla (nunca en las capturas del MCP). */
  capturable: boolean;
  /** Se esconde mientras alguna aplicación usa el micrófono. */
  hide_in_calls: boolean;
  /** Avisa de builds y tests en rojo. */
  build_alerts: boolean;
  /** Avisa de entregas del calendario de la uni. */
  calendar: boolean;
  /** Su ánimo reacciona a lo que haces: juegos, llamadas, ausencias, programar. */
  ambient_mood: boolean;
  /** Actividades por su cuenta: leer, pescar, malabares, avión de papel… (activities/). */
  activities: boolean;
  /** Baila cuando suena música (controles multimedia de Windows, media.rs). */
  music_dance: boolean;
}

export const DEFAULT_SETTINGS: MascotSettings = {
  enabled: true,
  scale: 4,
  wander: true,
  climb_windows: true,
  collide_windows: false,
  jump: true,
  splat: true,
  gravity: 1,
  bounciness: 0.45,
  eyes_follow_cursor: true,
  sleep_after_min: 3,
  drive_with_mcp: true,
  hang_struggle: false,
  hats: true,
  cursor_pranks: true,
  claude_model: "claude-sonnet-5-5",
  codex_model: "",
  game_mode: true,
  games: DEFAULT_GAMES.map((g) => ({ ...g })),
  taskbar_hints: true,
  taskbar_islands: false,
  capturable: true,
  hide_in_calls: true,
  build_alerts: true,
  calendar: true,
  ambient_mood: true,
  activities: true,
  music_dance: true,
};

/**
 * Por qué no vale un ejecutable de la tabla, o null si vale. Mismo criterio
 * que normalize_games (games.rs): solo el nombre de fichero, acabado en .exe.
 */
export function gameExeError(exe: string): string | null {
  const e = exe.trim();
  if (!e) return "Falta el ejecutable.";
  if (/[\\/]/.test(e)) return "Solo el nombre del fichero, sin carpeta.";
  if (!/\.exe$/i.test(e)) return "Tiene que acabar en .exe.";
  return null;
}

/** Copia limpia de la tabla: minúsculas, sin inválidos ni duplicados, con tope. */
export function normalizeGames(list: readonly GameEntry[]): GameEntry[] {
  const out: GameEntry[] = [];
  for (const g of list) {
    const exe = g.exe.trim().toLowerCase();
    if (gameExeError(exe) || out.some((o) => o.exe === exe)) continue;
    const outfit = OUTFITS.includes(g.outfit) ? g.outfit : "none";
    out.push({ exe, name: g.name.trim(), outfit });
    if (out.length >= MAX_GAMES) break;
  }
  return out;
}
