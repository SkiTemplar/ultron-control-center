// Rutas de fichero citadas en el texto de Claude y su resolución contra el
// directorio de trabajo de la sesión (pestaña Adjuntos y enlaces del chat).
// Puro: la comprobación en disco la hace `sesiones_paths_status`.

const DRIVE = /^[A-Za-z]:[\\/]/;
/** `/c/Users/…` de Git Bash. */
const GIT_BASH_DRIVE = /^\/([A-Za-z])(?=\/)/;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const EXT = String.raw`\.[A-Za-z][A-Za-z0-9]{0,7}`;
const SEG = String.raw`[\p{L}\p{N}_.@+-]`;
/**
 * Ruta en texto libre: al menos un separador y extensión; absoluta (Windows o
 * POSIX) o relativa. Sin espacios (las que los llevan, entre comillas invertidas).
 */
const FREE_PATH = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.@+\\/:-])(?:[A-Za-z]:[\\/]|~[\\/]|\/)?(?:${SEG}+[\\/])+${SEG}*${EXT}(?![\p{L}\p{N}_@+\\/-])`,
  "gu",
);
const BACKTICK = /`([^`\n]+)`/g;
const BACKTICK_PATH = new RegExp(String.raw`^(?:[A-Za-z]:[\\/]|~[\\/]|\/)?(?:[\p{L}\p{N}_ .@()+-]+[\\/])*[\p{L}\p{N}_ .@()+-]+${EXT}$`, "u");
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const MAX_LEN = 260;

/** Extensiones de medios o documentos que el chat abre con la app del sistema y no en VS Code. */
export const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|mp4|webm|mov|mkv|avi|m4v|wmv|mp3|wav|ogg|flac|m4a|aac|opus|pdf|docx|xlsx|pptx|odt|ods|odp|zip|7z|gz|glb|gltf|fbx|stl)$/i;

/**
 * Ruta de red (`//host`, `\\host`, también con los separadores mezclados) o de
 * dispositivo (`\\?\`, `\\.\`, `\??\`). Abrirla entabla una conexión SMB en la que
 * Windows entrega el hash NTLM al host de la ruta, sin que nadie pulse nada.
 */
const NETWORK_PATH = /^\s*(?:[\\/]{2}|[\\/]\?\?[\\/])/;

export function isNetworkPath(p: string): boolean {
  return NETWORK_PATH.test(p);
}

export const NETWORK_PATH_BLOCKED = "Ruta de red bloqueada: abrirla entregaría tus credenciales de Windows a ese host.";

/** Contenido de comillas invertidas que parece una ruta (`a/b.mp4`, `C:\x y\z.png:12`). */
function backtickPath(raw: string): string | null {
  const t = raw.trim().replace(LINE_SUFFIX, "");
  if (!t || t.length > MAX_LEN || /\s{2}|^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  if (!BACKTICK_PATH.test(t)) return null;
  // Con espacios solo si hay separador: `npm run x.js` no es una ruta.
  if (/\s/.test(t) && !/[\\/]/.test(t)) return null;
  return t;
}

/** Rutas citadas en un texto, en orden de aparición y sin repetir el texto exacto. */
export function extractPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(BACKTICK)) {
    const p = backtickPath(m[1]);
    if (p) found.add(p);
  }
  const sinUrls = text.replace(URL_RE, " ");
  for (const m of sinUrls.matchAll(FREE_PATH)) {
    if (m[0].length <= MAX_LEN) found.add(m[0]);
  }
  return [...found];
}

function isWindowsLike(p: string, cwd?: string): boolean {
  return DRIVE.test(p) || (!!cwd && DRIVE.test(cwd));
}

/** Quita `.` y resuelve `..` por segmentos; `null` si sube por encima de la raíz. */
function normalize(root: string, rest: string, sep: "\\" | "/"): string | null {
  const out: string[] = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return `${root}${sep}${out.join(sep)}`;
}

/**
 * Ruta absoluta de `raw`: tal cual si ya lo es (normalizada) o relativa a
 * `cwd`. `null` si es relativa sin `cwd`, de red (UNC), con `~` o se sale de la raíz.
 */
export function resolvePath(raw: string, cwd?: string): string | null {
  let p = raw.trim().replace(/^["']+|["']+$/g, "");
  if (!p || p.startsWith("\\\\") || p.startsWith("~")) return null;
  const win = isWindowsLike(p, cwd);
  if (win) p = p.replace(GIT_BASH_DRIVE, (_, d: string) => `${d}:`);
  if (DRIVE.test(p)) return normalize(p.slice(0, 2).toUpperCase(), p.slice(3), "\\");
  if (p.startsWith("/")) return win ? null : normalize("", p, "/");
  if (!cwd) return null;
  const base = resolvePath(cwd);
  if (!base) return null;
  return win ? normalize(base.slice(0, 2), `${base.slice(3)}\\${p}`, "\\") : normalize("", `${base}/${p}`, "/");
}

/** Clave de deduplicado: en Windows las rutas no distinguen mayúsculas. */
export function pathKey(abs: string): string {
  return DRIVE.test(abs) ? abs.toLowerCase() : abs;
}
