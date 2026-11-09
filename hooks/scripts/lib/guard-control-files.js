'use strict';
/**
 * Ficheros de control de los guardianes (2026-10-17, auditoria: seguridad
 * MEDIUM de la seccion 7). Son ficheros que DESARMAN o RELAJAN una proteccion:
 *
 * - `deny-secrets-pausa.json`: pausa con caducidad de las peticiones 'ask' de
 *   deny-secrets. Su unico productor legitimo es `/permisos pausar-env` desde
 *   el chat (mod ultron-permisos), que escribe sin pasar por una herramienta.
 * - `.ultron-trabajo.json`: marcador del modo uni que protege `borrador/` y
 *   `entrega/`. Lo crea `project-create.mjs` (la plantilla trabajo-entrega).
 *
 * Con `bypassPermissions` nada pide permiso, asi que si el agente pudiera
 * escribirlos se quitaria el freno a si mismo. Aqui se decide un deny duro:
 *
 * - Edit/Write/NotebookEdit/MultiEdit sobre el fichero: deny siempre.
 * - Shell (Bash, PowerShell o Monitor) que nombra el fichero: deny salvo que el comando
 *   sea de solo lectura (cada segmento empieza por un verbo de lectura y no hay
 *   redireccion de salida). Leerlo con Read sigue permitido.
 *
 * El mensaje multilinea de `git commit` (`-m "$(cat <<'EOF' ... EOF\n)"`) que
 * nombra uno de estos ficheros no bloquea: ver neutralizeLiteralHeredocs.
 *
 * El nombre se reconoce aunque la shell o Win32 lo reconstruyan (revision
 * adversarial 2026-10-18): partido por comillas o comillas invertidas,
 * `$'...'`, punto escapado, concatenacion `'a' + 'b'` de PowerShell, llaves
 * (`{json,bak}`), comodines con al menos MIN_GLOB_LITERALS letras fijas
 * (`deny-secrets-p*.json`, `*.jso?`), punto o blanco final y flujo NTFS
 * (`::$DATA`).
 *
 * Limite declarado: no ve el nombre si se construye en tiempo de ejecucion
 * (variables, codigo dentro de `node -e` o de un script escrito antes),
 * comodines con menos de MIN_GLOB_LITERALS letras fijas (`*.json`), nombres
 * cortos 8.3 (`DENY-S~1.JSO`), copias de un directorio entero ni enlaces
 * simbolicos que apunten al fichero con otro nombre. Tampoco el programa que
 * un comando de lectura lea de su configuracion (un `core.fsmonitor` ya
 * escrito en el `.git/config` de `git -C <ruta>`). Es un freno de defensa en
 * profundidad, no una frontera.
 */

const PAUSA_BASENAME = 'deny-secrets-pausa.json';
const MARKER_BASENAME = '.ultron-trabajo.json';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

// Verbos que solo leen o listan. Se comparan en minusculas. `less` no esta:
// `less -o <f>` copia la entrada a un fichero.
const READ_ONLY_VERBS = new Set([
  'cat', 'type', 'gc', 'get-content', 'head', 'tail', 'more', 'tac', 'nl',
  'ls', 'dir', 'gci', 'get-childitem', 'get-item', 'test-path', 'stat', 'du',
  'grep', 'rg', 'select-string', 'sls', 'wc', 'measure-object', 'jq', 'find',
  'sort', 'cut', 'tr', 'diff', 'cmp', 'md5sum', 'sha256sum', 'get-filehash',
  'convertfrom-json', 'convertto-json', 'select-object', 'where-object',
  'sort-object', 'format-list', 'format-table', 'out-string', 'echo',
  'write-output', 'write-host', 'basename', 'dirname', 'realpath', 'readlink',
  'join-path', 'resolve-path', 'split-path',
  // Cambiar de directorio no escribe nada; `cd <ruta> && cat <fichero>` es la
  // forma habitual de un subagente, cuyo cwd se reinicia en cada llamada.
  'cd', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location',
]);
// Opciones con las que un verbo de lectura escribe un fichero o lanza un
// programa: el segmento deja de ser de solo lectura.
const READ_VERB_WRITING_OPTION = new Map([
  ['rg', /^--pre(?:=|$)/],
  ['sort', /^(?:--output(?:=|$)|-[^-]*o)/],
  ['find', /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/],
]);
// Subcomandos de git que no escriben ficheros del arbol de trabajo: `add` y
// `commit` cuentan porque nombrar el fichero en un `-m` de una linea es
// habitual. El mensaje multilinea de Claude Code (`-m "$(cat <<'EOF' ...)"`)
// se reconoce aparte (neutralizeLiteralHeredocs).
const GIT_SAFE = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'blame', 'check-ignore', 'grep', 'add', 'commit']);
// Opciones globales de git que no ejecutan nada ni escriben: se saltan para
// llegar al subcomando (`git -C <ruta> diff`). Cualquier otra (sobre todo
// `-c`, que puede fijar `core.fsmonitor` o `core.pager` a un comando, o
// `--exec-path`) hace que el segmento deje de ser de solo lectura.
const GIT_GLOBAL_FLAGS = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs']);
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree']);
// Opciones de los subcomandos de lectura que escriben un fichero o lanzan un
// programa: `git diff --output=<f>`, `git grep -O<cmd>`.
// `--output-indicator-*` de `git diff` solo cambia un caracter de la salida.
const GIT_WRITING_OPTION = /^(?:--output(?:=|$)|--open-files-in-pager|-O)/;

// Separadores de segmento: operadores, subshells, bloques de PowerShell y saltos.
const SEGMENT_SPLIT = /[;|&\n(){}`]+|\$\(/;
// Palabras para buscar llaves y comodines; las comas se tratan despues de
// expandir las llaves, que las usan como separador de alternativas.
const WORD_SPLIT = /[\s;|&<>()=]+/;
const GLOB_CHARS = /[*?[]/;
// Letras fijas que debe tener un comodin para contar como nombre del fichero:
// `*.json` o `*` a secas seleccionan cualquier cosa y bloquearlos daria falsos
// positivos en limpiezas legitimas (`rm dist/*.json`).
const MIN_GLOB_LITERALS = 3;
const MAX_BRACE_ALTERNATIVES = 64;

/**
 * Ultimo componente de una ruta en minusculas, como lo resuelve Win32: sin
 * flujo NTFS (`f::$DATA` escribe el flujo principal de `f`) y sin los puntos
 * ni blancos finales que CreateFile recorta.
 */
function basenameOf(token) {
  const parts = String(token).split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts[parts.length - 1].toLowerCase().replace(/:.*$/, '').replace(/[. ]+$/, '');
}

/** Nombres protegidos: los fijos y el de la pausa si se movio por variable. */
function protectedNames(env = process.env) {
  const names = new Map([
    [PAUSA_BASENAME, 'deny-secrets pause file'],
    [MARKER_BASENAME, 'uni deliverable marker'],
  ]);
  const custom = basenameOf(env.ULTRON_DENY_SECRETS_PAUSA || '');
  if (custom && !names.has(custom)) names.set(custom, 'deny-secrets pause file');
  return names;
}

function controlFileOf(path, env) {
  return protectedNames(env).get(basenameOf(path)) || null;
}

/** Segmento `git ...` de solo lectura: opciones globales inocuas y subcomando de GIT_SAFE. */
function isReadOnlyGit(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const [flag] = words[i].split('=');
    if (GIT_GLOBAL_WITH_VALUE.has(flag)) i += words[i].includes('=') ? 1 : 2;
    else if (GIT_GLOBAL_FLAGS.has(flag)) i += 1;
    else return false;
  }
  if (!GIT_SAFE.has(String(words[i] || '').toLowerCase())) return false;
  return !words.slice(i + 1).some((w) => GIT_WRITING_OPTION.test(w));
}

function isReadOnlySegment(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const verb = words[0].replace(/^&/, '').replace(/^["']|["']$/g, '').toLowerCase();
  if (verb === 'git') return isReadOnlyGit(words);
  if (!READ_ONLY_VERBS.has(verb)) return false;
  const writing = READ_VERB_WRITING_OPTION.get(verb);
  return !writing || !words.slice(1).some((w) => writing.test(w));
}

// Apertura de `$(cat <<'EOF'` (delimitador entre comillas simples o dobles,
// con `<<-` opcional) al final de su linea.
const LITERAL_HEREDOC_OPEN = /\$\(\s*cat\s+<<(-?)\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*\n/;

/**
 * Sustituye por `_` cada `$(cat <<'EOF' ... EOF\n)` de un comando de Bash. Con
 * el delimitador entre comillas el cuerpo es literal y `cat` solo lo imprime:
 * es el mensaje multilinea de `git commit` de Claude Code, no codigo. Solo se
 * neutraliza cuando el contexto es inequivoco; si no, el comando se queda
 * igual y el freno sigue siendo conservador:
 * - lo anterior no tiene comillas simples, `<<`, comentarios (`#`) ni
 *   comillas invertidas, y el `$(` no va escapado;
 * - el cuerpo termina en la primera linea igual al delimitador (como Bash; con
 *   `<<-`, sin los tabuladores iniciales) y tras ella solo hay blancos y `)`.
 */
function neutralizeLiteralHeredocs(command) {
  let out = command;
  for (let guard = 0; guard < 16; guard += 1) {
    const open = LITERAL_HEREDOC_OPEN.exec(out);
    if (!open) return out;
    const prefix = out.slice(0, open.index);
    if (/['#`]|<<|\\$/.test(prefix)) return out;
    const stripTabs = open[1] === '-';
    const delimiter = open[3];
    const bodyStart = open.index + open[0].length;
    const lines = out.slice(bodyStart).split('\n');
    const end = lines.findIndex((line) => (stripTabs ? line.replace(/^\t+/, '') : line) === delimiter);
    if (end < 0) return out;
    const afterTerminator = bodyStart + lines.slice(0, end + 1).join('\n').length;
    const close = /^[ \t\n]*\)/.exec(out.slice(afterTerminator));
    if (!close) return out;
    out = `${prefix}_${out.slice(afterTerminator + close[0].length)}`;
  }
  return out;
}

/** El comando solo lee: sin redireccion de salida y cada segmento con verbo de lectura. */
function isReadOnlyCommand(command) {
  // Redirecciones que descartan la salida o duplican un descriptor: no
  // escriben nada. El destino nulo tiene que acabar ahi: `>/dev/null/../x`
  // es una ruta que la normalizacion de MSYS puede resolver a otro fichero.
  const plain = command.replace(/\d?>&\d|[12]?>\s*(?:\/dev\/null|\$null|nul)(?=$|[\s;|&)])/gi, ' ');
  if (/>/.test(plain)) return false;
  return plain.split(SEGMENT_SPLIT).every(isReadOnlySegment);
}

/**
 * Comando sin lo que la shell quita al reconstruir una palabra: comillas,
 * comillas invertidas (escape de PowerShell), barras invertidas, el `$` de
 * `$'...'`, el `+` de una concatenacion de PowerShell y los blancos.
 */
function squashed(command) {
  return command.toLowerCase().replace(/\$(?=['"])/g, '').replace(/[\s"'`\\+]+/g, '');
}

/** Expande las llaves de Bash (`a.{json,bak}`) con un tope de alternativas. */
function expandBraces(word, out = []) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!m) {
    out.push(word);
    return out;
  }
  for (const alt of m[1].split(',')) {
    if (out.length >= MAX_BRACE_ALTERNATIVES) break;
    expandBraces(word.slice(0, m.index) + alt + word.slice(m.index + m[0].length), out);
  }
  return out;
}

/** Comodin de shell o de PowerShell (`*`, `?`, `[...]`) traducido a RegExp. */
function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    const close = c === '[' ? glob.indexOf(']', i + 2) : -1;
    if (c === '*') source += '.*';
    else if (c === '?') source += '.';
    else if (close > 0) {
      const body = glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
      source += `[${body}]`;
      i = close;
    } else source += c.replace(/[.+^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function globMatches(glob, name) {
  const literals = glob.replace(/\[[^\]]*\]/g, '').replace(/json/g, '').replace(/[^a-z0-9_-]/g, '');
  if (literals.length < MIN_GLOB_LITERALS) return false;
  try {
    return globToRegExp(glob).test(name);
  } catch (_) {
    // Solo lanza con un rango invertido (`[z-a]`), que tampoco casa con nada
    // en bash ni en PowerShell: la shell deja la palabra literal o falla, y en
    // ningun caso llega al fichero de control. Devolver `true` aqui (hasta el
    // 2026-10-23, N4) bloqueaba comandos legitimos y los atribuia al primer
    // fichero de la lista, aunque no lo nombraran.
    return false;
  }
}

/** Nombres que salen de expandir llaves y separar las listas de PowerShell. */
function* candidateNames(command) {
  const plain = command.toLowerCase().replace(/\$(?=['"])/g, '').replace(/["'`]/g, '');
  for (const word of plain.split(WORD_SPLIT)) {
    if (!word) continue;
    for (const expanded of expandBraces(word)) {
      for (const part of expanded.split(',')) {
        const base = basenameOf(part);
        if (base) yield base;
      }
    }
  }
}

function shellControlFile(command, env) {
  const names = [...protectedNames(env)];
  const flat = squashed(command);
  for (const [name, kind] of names) {
    if (flat.includes(name)) return kind;
  }
  for (const base of candidateNames(command)) {
    const hasGlob = GLOB_CHARS.test(base);
    for (const [name, kind] of names) {
      if (base === name || (hasGlob && globMatches(base, name))) return kind;
    }
  }
  return null;
}

/**
 * Motivo de bloqueo si la llamada puede escribir, mover o borrar un fichero de
 * control de un guardian; null si no lo toca o solo lo lee.
 */
function classifyControlWrite(toolName, toolInput, env = process.env) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (WRITE_TOOLS.has(toolName)) {
    const kind = controlFileOf(toolInput.file_path || toolInput.notebook_path || '', env);
    return kind ? `write to the ${kind}` : null;
  }
  if (SHELL_TOOLS.has(toolName) && typeof toolInput.command === 'string') {
    // El nombre se busca en el comando entero (cuerpos incluidos); la lectura
    // se decide sin los cuerpos literales de los heredocs de Bash.
    const kind = shellControlFile(toolInput.command, env);
    const code = toolName === 'Bash' ? neutralizeLiteralHeredocs(toolInput.command) : toolInput.command;
    if (!kind || isReadOnlyCommand(code)) return null;
    return `command that can modify the ${kind}`;
  }
  return null;
}

module.exports = {
  PAUSA_BASENAME,
  MARKER_BASENAME,
  classifyControlWrite,
  isReadOnlyCommand,
  neutralizeLiteralHeredocs,
};
