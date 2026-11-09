'use strict';
/**
 * lib/secret-env-dump.js — comandos que vuelcan variables de entorno con secretos.
 * Sale de deny-secrets.js (limite de 800 lineas por fichero).
 *
 * Volcar es lo que escribe valores en la salida: `export` o `declare -x` sin nada
 * mas, `reg query HKCU\Environment`, `echo $GROQ_API_KEY`. Asignar no lo es:
 * `export FOO=1`, `declare -x FOO=1` y `set -e` pasan.
 */

const { sinHeredocs } = require('./shell-segments');

// Variables de entorno con secretos (hooks-9): desde 5edf0ca7 las claves de
// Groq y Gemini viven en HKCU\Environment, fuera del .env, y `echo
// $GROQ_API_KEY` o `reg query HKCU\Environment` las volcaban sin freno. El
// nombre tiene que ACABAR en la parte secreta: `GITHUB_TOKEN` si,
// `TOKEN_COUNT` o `MAX_TOKENS` no. `ULTRON_KEY_*` es la familia de keys de la
// propia app: cuenta por el prefijo.
const SECRET_VAR = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET(?:_?KEY)?|PASSWORD|PASSWD|PAT|TOKEN)$|^ULTRON_KEY_/i;
// `$pat` o `$token` en minusculas y sin prefijo son variables locales de un bucle o
// de un script, no el entorno: `for pat in a b; do grep "$pat" f; done`.
const LOCAL_VAR = /^(?:pat|token|secret|password|passwd)$/;
const VAR_REFS = /\$\{?(?:env:)?([A-Za-z_]\w*)\}?|%([A-Za-z_]\w*)%|GetEnvironmentVariable\(\s*['"]([A-Za-z_]\w*)|(?<![$\w.])env:([A-Za-z_]\w*)/gi;
// Lo que puede seguir a un volcado: su redireccion y el cierre de un bloque.
const DUMP_TAIL = String.raw`(?:\s*\d*>[^]*)?[)}\x60\s]*$`;
const ENV_DUMP_SEGMENT = [
  new RegExp(String.raw`^(?:\S*[\\/])?printenv(?:\s+-\S+)*${DUMP_TAIL}`, 'i'),
  new RegExp(String.raw`^(?:\S*[\\/])?env(?:\s+-[0i])*${DUMP_TAIL}`, 'i'),
  // Distingue mayusculas: `SET` es cmd.exe y `Set` es Set-Variable de PowerShell.
  new RegExp(String.raw`^(?:set|SET|(?:export|declare|typeset)(?:\s+-[px]+)?)${DUMP_TAIL}`),
  /^(?:get-childitem|gci|ls|dir|get-item|gi)\b[^]*?(?<![$\w])env:/i,
];
// `printenv NOMBRE`, `declare -p NOMBRE` y `set NOMBRE` de cmd.exe: el argumento
// nombra la variable, sin `$` delante.
const NAMED_DUMP_ARGS = /^(?:(?:\S*[\\/])?printenv(?:\s+-\S+)*|(?:declare|typeset)\s+-[a-z]*p[a-z]*|set)\s+(.+)$/i;
// Prefijos que no cambian lo que se ejecuta. `env` no esta: suelto es el volcado.
const DUMP_PREFIX = /^(?:[(\x60]\s*|[{!]\s+|\$\(\s*|(?:sudo|nohup|time|exec|command|builtin|then|do|else|if)\s+|timeout\s+\S+\s+)+/i;
// Comprobar que una variable existe no la vuelca: `[ -n "$X" ]`, `-z "$X"`.
const VAR_EXISTENCE_TEST = /-[nz]\s+["']?\$\{?[A-Za-z_]\w*\}?["']?/g;
const ENV_DUMP_ANYWHERE = [
  /\bGetEnvironmentVariables\s*\(/i,
  // Admite la barra doblada (`reg query HKCU\\Environment`, la forma natural en
  // Git Bash) y la normal.
  /\b(?:HKCU|HKEY_CURRENT_USER|HKLM|HKEY_LOCAL_MACHINE):?[\\/]+(?:SYSTEM[\\/]+CurrentControlSet[\\/]+Control[\\/]+Session Manager[\\/]+)?Environment\b/i,
  // La rama entera tambien lleva `Environment` dentro.
  /\breg(?:\.exe)?\s+(?:query|export|save)\s+(?:HKCU|HKEY_CURRENT_USER)[\\/]*(?:\s|$)/i,
  /\bWin32_Environment\b|\bwmic(?:\.exe)?\s+environment\b/i,
  /\/proc\/(?:self|\d+|\$\$|\$\w+)\/environ\b/i,
  // `echo "$(env)"`: dentro de comillas el segmento no empieza por el verbo.
  /(?:\$\(|\x60)\s*(?:printenv|env|set|export|declare(?:\s+-[px]+)?|typeset(?:\s+-[px]+)?)\s*(?:\)|\x60)/i,
];
// Codigo de una linea: `node -p process.env.X`. Fuera de un interprete con codigo
// en linea, `process.env.X` es un patron de grep, no una lectura.
const INLINE_CODE = /(?:^|[\s;&|(])(?:node|bun|deno|python[\d.]*|py|ruby|perl|php)(?:\.exe)?\s(?:[^|;&\n]*\s)?(?:-[a-z]*[pec]|--eval|--print)\b/i;
const CODE_ENV_REF = /\bprocess\.env(?:\.([A-Za-z_]\w*)|\[\s*['"]([A-Za-z_]\w*)['"])|\bos\.environ(?:\.get\(\s*|\[\s*)['"]([A-Za-z_]\w*)|\bgetenv\(\s*['"]([A-Za-z_]\w*)/g;
const CODE_ENV_DUMP = /\bprocess\.env\b(?![.[\w])|\bos\.environ\b(?![.[\w])/;

function isSecretVar(name) {
  return SECRET_VAR.test(name) && !LOCAL_VAR.test(name);
}

/** Algun nombre de variable secreta leido por codigo en linea. */
function inlineCodeReadsEnv(command) {
  if (!INLINE_CODE.test(command)) return false;
  if (CODE_ENV_DUMP.test(command)) return true;
  return [...command.matchAll(CODE_ENV_REF)].some((m) => isSecretVar(m.slice(1).find(Boolean) || ''));
}

/**
 * Linea para trocearla en segmentos: una cadena con blancos u operadores dentro es un
 * argumento (`grep -E "a|export)"`, `node -e '…'`), no comandos, y se vacia. Del resto
 * se quitan comillas y escapes, para ver `e"xpo"rt` y `e\xport` como lo que ejecutan.
 * El cuerpo de un here-doc son datos; si lo lee una shell, es otra variante de la linea.
 */
function plainLine(command) {
  return sinHeredocs(command).texto
    .replace(/"[^"]*"|'[^']*'/g, (q) => (/[\s;&|()]/.test(q) ? '""' : q))
    .replace(/["'^]/g, '')
    .replace(/\\([A-Za-z0-9])/g, '$1');
}

function segmentDumpsEnv(raw) {
  const seg = raw.trim().replace(DUMP_PREFIX, '');
  if (ENV_DUMP_SEGMENT.some((re) => re.test(seg))) return true;
  const named = seg.match(NAMED_DUMP_ARGS);
  return Boolean(named) && named[1].split(/\s+/).some((a) => isSecretVar(a.replace(/["']/g, '')));
}

/** 'environment secret dump' si el comando vuelca variables de entorno con secretos. */
function classifyEnvDump(command) {
  // Sin comillas ni escapes de cmd: `reg query HKCU\"Environment"` y `$GR"O"Q_API_KEY`
  // leen lo mismo.
  const unquoted = command.replace(/["'^\x60]/g, '');
  for (const text of [command, unquoted]) {
    for (const m of text.replace(VAR_EXISTENCE_TEST, ' ').matchAll(VAR_REFS)) {
      if (isSecretVar(m.slice(1).find(Boolean) || '')) return 'environment secret dump';
    }
  }
  if (ENV_DUMP_ANYWHERE.some((re) => re.test(command) || re.test(unquoted))) return 'environment secret dump';
  if (inlineCodeReadsEnv(command)) return 'environment secret dump';
  return plainLine(command).split(/[\n;&|]+/).some(segmentDumpsEnv) ? 'environment secret dump' : null;
}

module.exports = { classifyEnvDump };
