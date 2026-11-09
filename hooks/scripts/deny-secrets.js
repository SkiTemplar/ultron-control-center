#!/usr/bin/env node
/**
 * ULTRON HOOK · deny-secrets · v2.0 (port Node del deny-secrets.py v1.0)
 *
 * PreToolUse hook that blocks Read / Edit / Write / NotebookEdit / Bash /
 * PowerShell / Grep access to credential files: .env, private keys /
 * keystores, anything under an `.ssh/` directory, `~/.aws/credentials`,
 * `secrets.json` / `credentials.json` / `service-account*.json`,
 * `.git-credentials`, `.netrc`, `.npmrc` / `.pypirc` (ask) and the GitHub CLI
 * `hosts.yml`. PowerShell y Grep entraron el 2026-10-17 (H23 de la auditoria):
 * hasta entonces la shell principal de Windows leia `~/.ultron/.env` sin freno.
 * Tambien bloquea en duro escribir los ficheros de control de los guardianes
 * (su propia pausa y el marcador `.ultron-trabajo.json`): ver
 * lib/guard-control-files.js.
 *
 * Desde el 2026-10-23 (seguridad-2 y hooks-9 de la auditoria) cubre tambien
 * los tokens de Codex (`~/.codex/auth.json`) y Gemini (`oauth_creds.json`),
 * el del puente de Pupus (`cockpit/mascot-bridge.json` y `%TEMP%/ultron-pupus/`)
 * y `~/.claude.json` (env de los MCP en claro); resuelve globs (`.e*`,
 * `~/.cod?x/auth.json`), comillas partidas (`.e""nv`) y concatenaciones
 * (`'.'+'env'`), y pide permiso al volcar variables de entorno con secretos
 * (`echo $GROQ_API_KEY`, `printenv`, `reg query HKCU\Environment`).
 *
 * Auditoria 2026-11-01: `Monitor` ejecuta shell y entra en SHELL_TOOLS; el
 * clasificador mira tambien lo que se lanza a traves de otra shell
 * (`-EncodedCommand`, `cmd /c`, `bash -c`, `echo … | bash`: lib/shell-wrappers.js),
 * resuelve un `cd` previo y el `cwd` del payload contra los directorios sensibles
 * (`cd ~/.codex && cat auth.json`, tambien en subshell o grupo: lib/secret-cwd.js),
 * normaliza `.` y `..` en las rutas (`.codex/./auth.json`), ve `printenv VAR`,
 * `process.env.VAR` en `node -p`, `/proc/self/environ`, `prod.env`, `.envrc` y el
 * flujo NTFS, y no pide permiso por un texto que solo se cita (mensaje de commit,
 * heredoc literal). Lo que pasa de MAX_CLASSIFIED_CHARS no se clasifica: pide
 * permiso, sin pausa posible, porque el plazo del hook es de 15 s.
 *
 * Limite declarado: no evalua la shell; una ruta construida en una variable
 * o con codigo arbitrario sigue sin verse. Un `prod.env` como palabra suelta solo
 * cuenta tras un verbo que lee ficheros o `--env-file`: `process.env` en codigo no
 * es un fichero. `echo <base64> | base64 -d | bash` tampoco se decodifica, y un `cd`
 * previo no se traslada al comando interior (`cd d && bash -c "cat f"`).
 *
 * Critical when ULTRON runs with `--dangerously-skip-permissions`: it is the
 * tripwire that stops an agent from reading the user's secrets.
 *
 * Port 2026-08-11 (audit 08-09 #4): reescrito de Python a Node para eliminar
 * los ~200ms de arranque `uv run python` que pagaba CADA tool call del matcher
 * (Read|Edit|Write|NotebookEdit|Bash, hook sincrono en el hot path). Mismas
 * reglas y mismo contrato JSON que el .py; el selftest hermano
 * (deny-secrets.selftest.mjs) fija el comportamiento con casos deny Y allow.
 *
 * Design — SPECIFIC patterns, not a generic `*secret*` substring. A substring
 * match would flag legit code (`secrets_scanner.py`) and blow the "<1% false
 * positive" target. Every rule targets a real credential-file shape.
 *
 * Defense in depth — single-user offline system; this is a tripwire, NOT a
 * primary boundary. The hook never throws and always exits 0.
 *
 * Instrumentacion (2026-09-22): era el unico de los hooks registrados sin
 * una sola llamada a `observe`, y por eso no dejaba ningun rastro en
 * hook-timing.jsonl — no habia forma de saber si el tripwire se habia
 * disparado alguna vez. Ahora cada ejecucion deja su linea de timing y las
 * que bloquean anotan ADEMAS `decision` (deny|ask), `rule` (el NOMBRE de la
 * regla que caso) y `tool`.
 *
 * Lo que NO se registra, a proposito: la ruta. Anotar la ruta bloqueada en un
 * log que la app lee y que puede acabar en un repo publico convierte al
 * guardian en la fuga (mandamiento 9). Los nombres de regla salen de un
 * conjunto cerrado escrito en este fichero, asi que no hay dato del usuario
 * que redactar.
 *
 * El fail-safe de este hook es distinto al del resto: los demas fallan
 * ABIERTOS (exit 0 sin salida ante cualquier excepcion) porque un hook roto
 * no puede tumbar todas las sesiones; este es una puerta de seguridad y falla
 * CERRADO. Por eso la instrumentacion entera va envuelta: si `lib/hook-obs`
 * faltara o lanzara, el hook sigue clasificando y bloqueando igual.
 */

'use strict';

// Observabilidad opcional: un fallo aqui NUNCA puede desarmar el tripwire.
let obs = { observe() {}, annotate() {}, logHookError() {} };
try {
  obs = require('./lib/hook-obs');
} catch (_) {
  /* sin observabilidad, pero el hook sigue bloqueando */
}

// Ficheros de control de los guardianes (la pausa de este hook y el marcador
// del modo uni): deny duro a escribirlos (seguridad MEDIUM de la auditoria
// 2026-10-17). Si la libreria faltara, se registra el fallo y el resto del
// hook sigue protegiendo las credenciales igual.
let classifyControlWrite = () => null;
let neutralizeLiteralHeredocs = (command) => command;
try {
  ({ classifyControlWrite, neutralizeLiteralHeredocs } = require('./lib/guard-control-files'));
} catch (e) {
  obs.logHookError('deny-secrets', e);
}

// Normalizacion de shell. Si faltara, se registra y el hook sigue clasificando
// la linea tal cual: pierde los comandos interiores, no las demas reglas.
let shell = {
  variantes: (command) => [command],
  comandosDe: () => [],
  palabras: (text) => String(text || '').split(/\s+/).filter(Boolean),
};
try {
  shell = require('./lib/shell-wrappers');
} catch (e) {
  obs.logHookError('deny-secrets', e);
}

// Comodines y volcado de entorno. Si faltaran, se registra y las demas reglas siguen.
let GLOB_CHARS = /[*?[]/;
let globCandidates = () => [];
let classifyEnvDump = () => null;
let classifyRelativeToCwd = () => null;
try {
  ({ GLOB_CHARS, globCandidates } = require('./lib/secret-globs'));
  ({ classifyEnvDump } = require('./lib/secret-env-dump'));
  ({ classifyRelativeToCwd } = require('./lib/secret-cwd'));
} catch (e) {
  obs.logHookError('deny-secrets', e);
}

// Tools whose tool_input carries a file path.
const fs = require('fs');
const path = require('path');
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Shells cuyo `command` se trocea y se clasifica token a token. PowerShell es
// la shell principal en Windows: hasta el 2026-10-17 (H23 de la auditoria)
// no estaba ni aqui ni en el matcher, y `Get-Content ~/.ultron/.env` pasaba.
// `Monitor.command` es "Shell command or script" segun los tipos del motor: cada
// linea de su stdout vuelve al modelo (auditoria 2026-11-01). Su shell depende de
// la maquina, asi que se trocea en los dos dialectos.
const SHELL_DIALECTS = Object.freeze({ Bash: ['bash'], PowerShell: ['ps'], Monitor: ['bash', 'ps'] });
const SHELL_TOOLS = new Set(Object.keys(SHELL_DIALECTS));

// Herramientas de busqueda que LEEN contenido: Grep con `path` a un fichero de
// credenciales (o `glob` que lo seleccione) vuelca su contenido al contexto.
// Glob no esta: solo lista nombres. Limite declarado: un Grep sobre un
// directorio entero sin glob puede alcanzar un .env si ripgrep no lo ignora.
const SEARCH_TOOLS = new Set(['Grep']);

// Extensions that are private keys / keystores by definition.
const KEY_EXTS = new Set(['pem', 'pfx', 'p12', 'key', 'keystore', 'jks']);

// .env.<x> suffixes that are SAFE — examples / templates carry no real secret.
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];
// Lo mismo con otro separador o delante: `.env-example`, `example.env`.
const SAFE_ENV_NAME = /(?:^|[.\-_])(?:example|sample|template|dist)(?:[.\-_]env)?$/;
// `prod.env` como palabra suelta de una linea de shell. Sin ruta ni verbo que lee
// ficheros es codigo (`process.env`, `import.meta.env`), no un fichero.
const NAMED_ENV_WORD = /^[\w-]+(?:\.[\w-]+)*\.env$/i;
const FILE_READERS = new Set([
  'cat', 'type', 'gc', 'get-content', 'less', 'more', 'head', 'tail', 'tac', 'nl', 'bat', 'source', '.',
  'cp', 'copy', 'copy-item', 'mv', 'move', 'move-item', 'scp', 'rsync', 'sed', 'awk', 'xxd', 'od', 'strings', 'base64',
]);
// En estos el primer argumento que no es opcion es el patron, no un fichero.
const PATTERN_READERS = new Set(['grep', 'rg', 'findstr', 'select-string', 'sls']);
const ENV_FILE_FLAG = /(?:--env-file[=\s]+|(?:^|\s)<\s*)["']?([\w.-]+\.env)["']?(?=\s|$)/i;

// SSH private-key basename prefixes.
const SSH_KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'];

// Exact credential-file basenames (dotfile variants included).
const CRED_BASENAMES = new Set([
  'secrets.json',
  'credentials.json',
  '.secrets.json',
  '.credentials.json',
]);

// Ficheros con tokens en claro de herramientas de linea de comandos.
const GIT_CRED_BASENAMES = new Set(['.git-credentials']);
const NETRC_BASENAMES = new Set(['.netrc', '_netrc']);
// Registros de paquetes: suelen llevar `_authToken`, pero un `.npmrc` de
// proyecto a menudo solo fija el registro, asi que van a 'ask', no a deny.
const REGISTRY_BASENAMES = new Set(['.npmrc', '.pypirc']);
// Carpetas donde GitHub CLI guarda `hosts.yml` con el token OAuth.
const GH_CONFIG_DIRS = new Set(['gh', 'github cli']);

// Ficheros de credenciales de las CLI y de ULTRON (seguridad-2, 2026-10-23):
// el token OAuth/API de Codex y Gemini, el del puente de Pupus (fichero y
// copia temporal de los ajustes del freno) y la config de Claude Code, que
// guarda en claro el `env` de los MCP (tokens de Supabase, por ejemplo).
const CLI_AUTH_FILES = { '.codex': 'auth.json', '.gemini': 'oauth_creds.json' };
const BRIDGE_BASENAMES = new Set(['mascot-bridge.json']);
const BRIDGE_DIRS = new Set(['ultron-pupus']);

/**
 * Return a block reason for a credential file path, or null if safe.
 * `globs: false` no resuelve comodines (palabras sueltas de una linea de
 * shell, donde `*mascot*` suele ser un patron de `find` o de `tasklist`).
 */
function classifyPath(p, { globs = true } = {}) {
  if (!p || typeof p !== 'string') return null;
  const norm = p
    .replace(/\\/g, '/')
    .trim()
    .replace(/^["']+|["']+$/g, '');
  if (!norm) return null;
  const raw = norm.split('/').filter(Boolean);
  if (raw.length === 0) return null;
  const segments = resolveDots(raw);
  // La forma literal tambien: `.ssh/../x` nombra el directorio aunque no se quede en el.
  const direct = classifySegments(raw) || classifySegments(segments);
  if (direct || !globs || !segments.some((s) => GLOB_CHARS.test(s))) return direct;
  for (const candidate of globCandidates(segments)) {
    const reason = classifySegments(candidate);
    if (reason) return reason;
  }
  return null;
}

/** Segmentos sin `.` y con cada `..` resuelto: `.codex/./auth.json` es `.codex/auth.json`. */
function resolveDots(segments) {
  const out = [];
  for (const s of segments) {
    if (s === '.') continue;
    if (s === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(s);
  }
  return out;
}

/**
 * Nombre en minusculas como lo resuelve Win32: sin flujo NTFS (`.env::$DATA` lee
 * el flujo principal) y sin los puntos ni blancos finales que CreateFile recorta.
 * Mismo criterio que guard-control-files. `..` se queda como esta.
 */
function win32Name(name) {
  const low = name.toLowerCase();
  return low.replace(/:.*$/, '').replace(/[. ]+$/, '') || low;
}

/**
 * 1. .env credential file (but NOT .env.example / .sample / .template).
 * `.env*` / `.env?` (glob de shell o de Grep) tambien selecciona el real, y
 * `*.env` tambien: el `*` de ripgrep y de PowerShell casa con la cadena vacia y
 * no trata aparte los ficheros que empiezan por punto. `.envrc` es el de direnv;
 * `prod.env`, `.env-prod` y `.env_prod` son la misma convencion con otro nombre.
 */
function isDotenvName(baseLow) {
  const isEnvFile =
    baseLow === '.env' ||
    baseLow === '.envrc' ||
    /^\.env[.\-_]/.test(baseLow) ||
    /^\.env[*?]/.test(baseLow) ||
    /^\*+\.env$/.test(baseLow) ||
    baseLow.endsWith('.env');
  return isEnvFile && !SAFE_ENV_NAME.test(baseLow) && !SAFE_ENV_SUFFIXES.some((s) => baseLow.endsWith(s));
}

/** Reglas sobre una ruta ya troceada en segmentos. */
function classifySegments(segments) {
  if (segments.length === 0) return null;
  const baseLow = win32Name(segments[segments.length - 1]);
  const segLow = new Set(segments.map((s) => s.toLowerCase()));
  const ext = baseLow.includes('.') ? baseLow.split('.').pop() : '';

  if (isDotenvName(baseLow)) return 'dotenv credential file';

  // 2. private key / keystore by extension
  if (KEY_EXTS.has(ext)) return `private key / keystore (.${ext})`;

  // 3. SSH private key by basename
  if (SSH_KEY_PREFIXES.some((pre) => baseLow.startsWith(pre))) {
    return 'SSH private key';
  }

  // 4. anything inside an .ssh directory
  if (segLow.has('.ssh')) return 'file inside an .ssh directory';

  // 5. ~/.aws/credentials
  if (segLow.has('.aws') && baseLow === 'credentials') {
    return 'AWS credentials file';
  }

  // 6. secrets.json / credentials.json / service-account*.json
  if (CRED_BASENAMES.has(baseLow)) return 'credentials/secrets file';
  if (baseLow.startsWith('service-account') && ext === 'json') {
    return 'service-account key file';
  }

  return classifyToolTokens(segments, baseLow);
}

/** Reglas 7-8: tokens en claro de herramientas de linea de comandos y de ULTRON. */
function classifyToolTokens(segments, baseLow) {
  // 7. tokens en claro de git, netrc, registros de paquetes y GitHub CLI
  if (GIT_CRED_BASENAMES.has(baseLow)) return 'git credential store';
  if (NETRC_BASENAMES.has(baseLow)) return 'netrc credentials file';
  if (REGISTRY_BASENAMES.has(baseLow)) return 'package registry token file';
  const parentLow = segments.length > 1 ? win32Name(segments[segments.length - 2]) : '';
  if (baseLow === 'hosts.yml' && GH_CONFIG_DIRS.has(parentLow)) return 'GitHub CLI token file';

  // 8. CLI, puente de ULTRON y config de Claude Code (seguridad-2)
  if (CLI_AUTH_FILES[parentLow] === baseLow) return 'CLI auth token file';
  if (BRIDGE_BASENAMES.has(baseLow) || segments.some((s) => BRIDGE_DIRS.has(s.toLowerCase()))) {
    return 'ULTRON bridge token file';
  }
  if (baseLow === '.claude.json' || baseLow.startsWith('.claude.json.')) {
    return 'Claude Code config with MCP tokens';
  }

  return null;
}

// Separadores de token en una linea de shell (Bash o PowerShell): blancos,
// operadores, redirecciones pegadas (`cat<.env`), `=` de los flags
// (`--env-file=.env`) y la coma de las listas de PowerShell. Las comillas se
// quitan aparte para no partir una ruta con espacios mas de lo necesario.
const SHELL_TOKEN_SPLIT = /[\s;|&<>()`=,{}]+/;

// Una ruta de Windows solo con barras invertidas cuenta como ruta si va
// anclada: unidad (`C:\`), `~\`, variable (`$HOME\`, `$env:X\`, `%X%\`), `.\`,
// `..\` o UNC. Sin ancla, `mock\.env\` o `"\.env"` son casi siempre escapes de
// una expresion regular dentro de `node -e`/`rg`, y clasificarlos pediria
// permiso en falso. Limite declarado: `src\.env` relativo sin ancla no se ve.
const WIN_ANCHORED = /^(?:[a-z]:|~|\$[\w:]+|%\w+%|\.{1,2}|\\)\\/i;

/** Clasifica un token ya limpio de una linea de shell. */
function classifyShellToken(rawToken) {
  if (!rawToken) return null;
  // Fuera de una ruta anclada o de un dotfile (`.ultron\.env`), `\.` es el
  // punto escapado de una regex (`"\.env"`, `/mock\.env\(/`): es un patron de
  // busqueda, no una ruta, y no se clasifica.
  const token = rawToken;
  if (token.includes('\\.') && !WIN_ANCHORED.test(token) && !token.startsWith('.')) return null;
  const isPathLike =
    token.includes('/') || token.startsWith('.') || token.startsWith('~') || WIN_ANCHORED.test(token);
  if (isPathLike) return classifyPath(token);
  if (token.includes('\\')) return null;
  // Palabra suelta (`cat credentials.json`, `type id_rsa`): solo cuentan los
  // nombres exactos. La regla por extension no se aplica: `e.key` o
  // `$entry.Key` en codigo dentro de un `node -e` no son claves privadas.
  // Tampoco el nombre del directorio del puente suelto (`grep ultron-pupus`).
  if (BRIDGE_DIRS.has(token.toLowerCase())) return null;
  // `prod.env` suelto lo decide namedEnvFile: `process.env` y `$x.env` son codigo.
  if (/\.env$/i.test(token) && !/^\*+\.env$/i.test(token)) return null;
  const reason = classifyPath(token, { globs: false });
  return reason && !reason.startsWith('private key') ? reason : null;
}

/** `cat prod.env`, `grep K prod.env`, `--env-file=prod.env`, `< prod.env`. */
function namedEnvFile(command, dialects) {
  const flag = command.match(ENV_FILE_FLAG);
  if (flag && isDotenvName(flag[1].toLowerCase())) return true;
  for (const { bin, resto } of shell.comandosDe(command, dialects)) {
    const isPattern = PATTERN_READERS.has(bin);
    if (!isPattern && !FILE_READERS.has(bin)) continue;
    const args = shell.palabras(resto).filter((a) => !a.startsWith('-'));
    const files = isPattern ? args.slice(1) : args;
    if (files.some((a) => NAMED_ENV_WORD.test(a) && isDotenvName(a.toLowerCase()))) return true;
  }
  return false;
}

// --- texto que se cita y no se ejecuta ----------------------------------------
// Cadena literal: sin expansion posible ni comilla escapada, que bash y PowerShell
// leen distinto (`"a\" ; cat .env`). Ante la duda no se quita y el freno pregunta.
const LITERAL_MESSAGE = /(?:^|\s)(?:-[a-zA-Z]*m|--mes[a-z]*=?)\s*(?:"[^"\\`$]*"|'[^']*')/g;

/**
 * Linea sin los mensajes de `git commit`, que se citan y no se ejecutan: nombrar
 * un fichero de credenciales al describir un cambio no accede a el. Solo en el
 * propio comando `git commit`, no en un `eval` que reevalue la cadena.
 */
function withoutCommitMessages(command, dialects) {
  let out = command;
  for (const { seg, bin, resto } of shell.comandosDe(command, dialects)) {
    if (bin !== 'git' || !/(?:^|\s)commit(?:\s|$)/.test(resto)) continue;
    const limpio = seg.replace(LITERAL_MESSAGE, ' ');
    out = out.replace(seg, () => limpio);
  }
  return out;
}

// Ruta entre comillas con espacios (`"C:\Program Files\app\.env"`): al trocear
// por blancos se partiria y la segunda mitad perderia el ancla, asi que se
// clasifica entera. Solo rutas absolutas de una linea, no cualquier cadena.
// El contenido va acotado (una ruta de Windows no pasa de unos cientos de
// caracteres): sin tope, una comilla sin cerrar en una linea de 100 KB hacia
// el escaneo cuadratico (650 ms medidos) y acercaba el hook a su timeout.
const QUOTED_PATH = /"([^"\n]{1,400})"|'([^'\n]{1,400})'/g;
const ABSOLUTE_PATH = /^(?:(?:[a-z]:|~|\$[\w:]+|%\w+%)[\\/]|\/|\\\\)[^;|&<>()`]*$/i;

function quotedPaths(command) {
  const out = [];
  for (const m of command.matchAll(QUOTED_PATH)) {
    const inner = (m[1] || m[2] || '').trim();
    if (/\s/.test(inner) && ABSOLUTE_PATH.test(inner)) out.push(inner);
  }
  return out;
}

// Ruta colgada de una expresion de PowerShell: `${env:USERPROFILE}\.ultron\.env`
// o `"$($env:USERPROFILE)\.ultron\.env"`. Al trocear por llaves y parentesis
// el resto (`\.ultron\.env`) pierde el ancla y pareceria un escape de regex;
// aqui el ancla es la propia expresion.
const PS_EXPR_PATH = /\$(?:\{[^{}\s]+\}|\([^()\n]*\))(\\[^\s"';|&<>()`,]+)/g;

function exprPaths(command) {
  return [...command.matchAll(PS_EXPR_PATH)].map((m) => m[1]);
}

// Parametro de PowerShell con el valor pegado por dos puntos
// (`Get-Content -Path:C:\x\.env`): el valor es la ruta.
const PS_PARAM_PREFIX = /^-[A-Za-z][\w-]*:/;

/**
 * Variante con las comillas partidas y las concatenaciones resueltas
 * (hooks-9): `.e""nv`, `".e"nv`, `'.'+'env'` (JS) y `".e" + "nv"` (PowerShell)
 * nombran el fichero sin escribirlo entero. Tambien quita el escape de una
 * letra (`.e\nv` en bash, `` .e`nv `` en PowerShell). No evalua la shell: una
 * ruta construida en una variable sigue sin verse (limite declarado).
 */
function joinedQuotes(command) {
  return command
    .replace(/(["'])\s*\+\s*(["'])/g, '')
    .replace(/["']/g, '')
    .replace(/[\\`]([A-Za-z0-9])/g, '$1');
}

/** Una linea de shell ya desenvuelta. */
function classifyShellLine(command, cwd, dialects) {
  const direct = classifyShellText(command);
  if (direct) return direct;
  const joined = joinedQuotes(command);
  if (joined !== command) {
    const reason = classifyShellText(joined);
    if (reason) return reason;
  }
  if (namedEnvFile(command, dialects)) return 'command accesses a dotenv credential file';
  const relative = classifyRelativeToCwd(command, cwd, { classifyPath, tokenSplit: SHELL_TOKEN_SPLIT });
  if (relative) return relative;
  const dump = classifyEnvDump(command);
  return dump ? `command reads an ${dump}` : null;
}

/**
 * Scan a shell command for tokens that reference a credential file: la linea y
 * cada comando que lanza a traves de otra shell (`powershell -EncodedCommand`,
 * `cmd /c`, `bash -c`). El comando interior se ejecuta en el mismo directorio.
 *
 * @param {string} command
 * @param {{cwd?: string, dialects?: string[]}} [opts] `cwd` del payload y dialectos
 *   de la herramienta. Los `$(cat <<'EOF' …)` literales solo se quitan en bash.
 */
function classifyShell(command, { cwd = '', dialects = ['bash'] } = {}) {
  if (!command || typeof command !== 'string') return null;
  const isBashOnly = dialects.length === 1 && dialects[0] === 'bash';
  const code = withoutCommitMessages(isBashOnly ? neutralizeLiteralHeredocs(command) : command, dialects);
  for (const line of shell.variantes(code, dialects)) {
    const reason = classifyShellLine(line, cwd, dialects);
    if (reason) return reason;
  }
  return null;
}

/** Rutas y tokens de una linea de shell (sin normalizar comillas). */
function classifyShellText(command) {
  for (const anchored of [...quotedPaths(command), ...exprPaths(command)]) {
    const reason = classifyPath(anchored);
    if (reason) return `command accesses a ${reason}`;
  }
  for (const raw of command.split(SHELL_TOKEN_SPLIT).filter(Boolean)) {
    const token = raw.replace(PS_PARAM_PREFIX, '').replace(/^["']+|["']+$/g, '');
    const reason = classifyShellToken(token);
    if (reason) return `command accesses a ${reason}`;
  }
  return null;
}

/**
 * Expande las llaves de un glob (`*.{pem,key}` -> `*.pem`, `*.key`). `null` si
 * pasa del tope: recortar la lista dejaria sin mirar justo la alternativa de detras.
 */
function expandBraces(glob, limit = 64) {
  const done = [];
  const pending = [glob];
  for (let steps = 0; pending.length > 0; steps++) {
    if (steps > limit * 16) return null;
    const one = pending.pop();
    const m = one.match(/\{([^{}]*)\}/);
    if (!m) {
      done.push(one);
      if (done.length > limit) return null;
      continue;
    }
    const alts = m[1].split(',');
    if (pending.length + alts.length > limit) return null;
    for (const alt of alts.reverse()) pending.push(one.slice(0, m.index) + alt + one.slice(m.index + m[0].length));
  }
  return done;
}

/** Ruta y glob de una busqueda (Grep); el glob, con sus llaves expandidas. */
function classifySearch(toolInput) {
  const base = String(toolInput.path || '').replace(/[\\/]+$/, '');
  const byPath = classifyPath(base);
  if (byPath) return byPath;
  const globs = expandBraces(String(toolInput.glob || ''));
  if (!globs) return TOO_LARGE_REASON;
  for (const one of globs) {
    // El glob se resuelve dentro de `path`: `*.json` en cockpit/ alcanza el token del puente.
    const reason = classifyPath(one) || (base && one ? classifyPath(`${base}/${one}`) : null);
    if (reason) return reason;
  }
  return null;
}

// Topes del clasificador: el hook tiene 15 s de plazo y varias reglas son
// superlineales con entradas patologicas. Una linea de este tamano no cabe en la
// linea de comandos de Windows (32 KB), asi que el tope no estorba al trabajo normal;
// pasarse pide permiso, nunca deja pasar sin mirar. `content` de Write no se clasifica.
const MAX_CLASSIFIED_CHARS = 64 * 1024;
const CLASSIFIED_FIELDS = ['command', 'file_path', 'notebook_path', 'path', 'glob'];
const TOO_LARGE_REASON = 'input too large to classify';

function isOversized(toolInput) {
  return CLASSIFIED_FIELDS.some((k) => typeof toolInput[k] === 'string' && toolInput[k].length > MAX_CLASSIFIED_CHARS);
}

/**
 * Return a block reason for this tool call, or null if it is allowed.
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string} [cwd] directorio de la sesion (campo `cwd` del payload)
 */
function classify(toolName, toolInput, cwd = '') {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (isOversized(toolInput)) return TOO_LARGE_REASON;
  const control = classifyControlWrite(toolName, toolInput);
  if (control) return control;
  if (FILE_TOOLS.has(toolName)) {
    const p = toolInput.file_path || toolInput.notebook_path || '';
    return classifyPath(p);
  }
  if (SHELL_TOOLS.has(toolName)) {
    return classifyShell(toolInput.command || '', { cwd, dialects: SHELL_DIALECTS[toolName] });
  }
  if (SEARCH_TOOLS.has(toolName)) return classifySearch(toolInput);
  return null;
}

// ---------------------------------------------------------------------------
// deny vs ask
// ---------------------------------------------------------------------------

// Motivos que degradan de bloqueo duro a peticion de permiso (2026-08-19).
// El fichero de variables de entorno es la config del proyecto en el que se
// trabaja: bloquearlo en seco obligaba a salir a una shell manual para tareas
// legitimas (ver que variable falta, anadir una clave). Con 'ask' el harness
// pide confirmacion al usuario en el momento y el permiso muere con esa tool
// call — sigue sin haber acceso silencioso, que es lo que este hook existe
// para impedir.
//
// Todo lo demas (claves privadas, keystores, .ssh, credenciales cloud,
// service accounts) se queda en deny duro: ningun flujo normal necesita que
// el agente las lea.
//
// Los ficheros de registro de paquetes (.npmrc, .pypirc) siguen la misma
// logica (2026-10-17): un .npmrc de proyecto suele fijar solo el registro.
// La config de Claude Code (`~/.claude.json`), el volcado de variables de
// entorno y el token del puente de Pupus tambien piden permiso (2026-10-23):
// llevan tokens en claro, pero revisar la config de un MCP, comprobar que una
// variable existe o borrar el fichero del puente al depurar son tareas
// legitimas (medido sobre 14.612 llamadas reales). Los tokens de las CLI
// (Codex, Gemini) se quedan en deny.
const ASK_REASON_FRAGMENTS = [
  'dotenv credential file',
  'package registry token file',
  'Claude Code config with MCP tokens',
  'environment secret dump',
  'ULTRON bridge token file',
  TOO_LARGE_REASON,
];

// Pausa con caducidad (2026-10-16): el usuario puede dejar de recibir la
// peticion de permiso del .env durante un rato (trabajo nocturno sin nadie
// delante). Solo afecta a los casos 'ask'; los 'deny' duros siguen. El fichero
// lleva {"hasta": "<ISO>"}; caducado, ilegible o ausente = sin pausa.
// Desde el 2026-10-17 lo escribe `/permisos pausar-env` (mod ultron-permisos),
// el agente no puede tocarlo (lib/guard-control-files.js) y una fecha a mas de
// MAX_PAUSA_MS vista se ignora: una pausa casi eterna seria un bypass permanente.
const MAX_PAUSA_MS = 12 * 3600e3;

function pausaPath() {
  return process.env.ULTRON_DENY_SECRETS_PAUSA ||
    path.join(require('os').homedir(), '.ultron', 'run', 'deny-secrets-pausa.json');
}

/** true si hay una pausa vigente de las peticiones 'ask' en `ahora` (ms). */
function askEnPausa(ahora = Date.now()) {
  try {
    const { hasta } = JSON.parse(fs.readFileSync(pausaPath(), 'utf8'));
    const t = Date.parse(hasta);
    return Number.isFinite(t) && ahora < t && t - ahora <= MAX_PAUSA_MS;
  } catch (_) {
    return false;
  }
}

/** 'ask' si el motivo admite permiso explicito del usuario, 'deny' si no. */
function decisionFor(reason) {
  if (!reason || typeof reason !== 'string') return 'deny';
  return ASK_REASON_FRAGMENTS.some((f) => reason.includes(f)) ? 'ask' : 'deny';
}

// Conjunto CERRADO de nombres de regla para el log. Es lo unico que sale de
// aqui hacia hook-timing.jsonl: identifica QUE salto sin decir sobre QUE. El
// orden importa (ssh-key antes que ssh-dir: una clave dentro de .ssh es lo
// primero, mas especifico).
const RULE_IDS = [
  ['dotenv credential file', 'dotenv'],
  ['private key / keystore', 'private-key'],
  ['SSH private key', 'ssh-key'],
  ['file inside an .ssh directory', 'ssh-dir'],
  ['AWS credentials file', 'aws-credentials'],
  ['credentials/secrets file', 'credentials-file'],
  ['service-account key file', 'service-account'],
  ['git credential store', 'git-credentials'],
  ['netrc credentials file', 'netrc'],
  ['package registry token file', 'registry-token'],
  ['GitHub CLI token file', 'gh-token'],
  ['CLI auth token file', 'cli-auth'],
  ['ULTRON bridge token file', 'bridge-token'],
  ['Claude Code config with MCP tokens', 'claude-config'],
  ['environment secret dump', 'env-dump'],
  ['deny-secrets pause file', 'pause-file'],
  ['uni deliverable marker', 'uni-marker'],
  ['classifier error', 'classifier-error'],
  [TOO_LARGE_REASON, 'input-too-large'],
];

/** Nombre corto y estable de la regla que caso (nunca la ruta). */
function ruleIdFor(reason) {
  const r = String(reason || '');
  for (const [fragmento, id] of RULE_IDS) {
    if (r.includes(fragmento)) return id;
  }
  return 'unknown';
}

/** Texto del bloqueo: los ficheros de control dicen cual es su productor legitimo. */
function denyMessage(reason) {
  const rule = ruleIdFor(reason);
  if (rule === 'pause-file') {
    return `ULTRON deny-secrets blocked: ${reason}. La pausa solo la pone la ` +
      `persona desde el chat con /permisos pausar-env <minutos>.`;
  }
  if (rule === 'uni-marker') {
    return `ULTRON deny-secrets blocked: ${reason}. El marcador del modo uni ` +
      `lo crea project-create.mjs; se cambia a mano, fuera del agente. Leerlo con Read sigue permitido.`;
  }
  return `ULTRON deny-secrets blocked: ${reason}. Credential files are ` +
    `off-limits to the agent — open it from a manual shell if ` +
    `genuinely needed.`;
}

function handle(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || '').replace(/^﻿/, ''));
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object' || data.hook_event_name !== 'PreToolUse') {
    return null;
  }

  let reason;
  try {
    reason = classify(data.tool_name || '', data.tool_input || {}, typeof data.cwd === 'string' ? data.cwd : '');
  } catch (exc) {
    // Fail-CLOSED: this is a security gate. If the classifier itself crashes
    // we cannot prove the access is safe, so we DENY rather than silently
    // letting the call through. The catch still swallows the exception so
    // the hook never crashes the tool flow.
    process.stderr.write(`deny-secrets: classify() threw, failing closed: ${exc}\n`);
    reason = 'classifier error (failing closed for safety)';
  }

  if (!reason) return null;

  const decision = decisionFor(reason);
  // Rastro del caso interesante: que decidio, que regla caso y sobre que tool.
  // Se anota en la linea de timing de este proceso (ver lib/hook-obs.js); la
  // ruta NO viaja. `via_bash` distingue el bloqueo por argumento de comando
  // del bloqueo por file_path, que son dos caminos distintos del clasificador.
  obs.annotate({
    decision,
    rule: ruleIdFor(reason),
    tool: String(data.tool_name || 'unknown'),
    // Nombre historico: cubre cualquier shell (Bash, PowerShell o Monitor).
    via_bash: String(reason).startsWith('command '),
  });
  // La pausa es para los casos 'ask' clasificados; sin clasificar, relleno delante de
  // una clave pasaria sin que nadie lo viera.
  if (decision === 'ask' && reason !== TOO_LARGE_REASON && askEnPausa()) {
    obs.annotate({ paused: true });
    return null;
  }
  if (decision === 'ask') {
    return JSON.stringify({
      systemMessage:
        `ULTRON deny-secrets: ${reason} — requiere permiso explicito del ` +
        `usuario. Concedido, el acceso vale solo para esta tool call.`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `PERMISO REQUERIDO (deny-secrets): ${reason}`,
      },
    });
  }

  return JSON.stringify({
    systemMessage: denyMessage(reason),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `BLOCKED (deny-secrets): ${reason}`,
    },
  });
}

// Export para el selftest; ejecucion real solo como script principal.
module.exports = {
  FILE_TOOLS,
  SHELL_TOOLS,
  SEARCH_TOOLS,
  classify,
  classifyPath,
  classifyShell,
  // Alias historico: el clasificador de shell nacio solo para Bash.
  classifyBash: classifyShell,
  decisionFor,
  ruleIdFor,
  handle,
  askEnPausa,
};

if (require.main === module) {
  // observe() dentro del bloque principal: requerido por el selftest, el
  // modulo no debe registrar nada ni ensuciar el log de timing.
  obs.observe('deny-secrets');
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    let out = null;
    try {
      out = handle(raw);
    } catch (e) {
      // Fail-CLOSED tambien aqui: si handle() reventara (no deberia: ya tiene
      // su propio catch), se bloquea en vez de dejar pasar el acceso.
      obs.logHookError('deny-secrets', e);
      obs.annotate({ decision: 'deny', rule: 'classifier-error', tool: 'unknown' });
      out = JSON.stringify({
        systemMessage: 'ULTRON deny-secrets: fallo interno del hook — se bloquea por seguridad.',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'BLOCKED (deny-secrets): fallo interno, failing closed',
        },
      });
    }
    if (out) process.stdout.write(out + '\n');
    process.exit(0);
  });
}
