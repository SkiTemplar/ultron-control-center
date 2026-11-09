#!/usr/bin/env node
/**
 * ULTRON HOOK · uni-deliverable-guard · v1.0
 *
 * PreToolUse (Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell). Bloqueo
 * REAL de escritura del entregable en modo trabajo universitario (decidido
 * 2026-09-14): en proyectos de asignatura, el texto evaluable (memoria,
 * informe, TFG, cuestionario) lo redacta el alumno — la IA senala problemas y
 * orienta, no lo escribe. socratic-gate.js (UserPromptSubmit) es el
 * recordatorio en cada prompt; este hook es el limite duro — sin el, "no
 * redactes el entregable" es solo una peticion de texto que un turno largo
 * puede olvidar.
 *
 * MARCADOR: `.ultron-trabajo.json` en la raiz del trabajo, formato
 *   { "protegidas": ["borrador", "entrega"] }
 * Se busca hasta 4 niveles por encima de la carpeta del DESTINO y, si no hay,
 * por encima del cwd de la sesion. Hasta el 2026-10-17 solo se miraba el cwd
 * (H27 de la auditoria): la sesion se abre en la asignatura y el marcador vive
 * en `trabajos/<X>/`, por debajo, asi que no se encontraba nunca. Una
 * escritura en `trabajos/<X>/borrador|entrega/` sin marcador no se bloquea,
 * pero avisa por systemMessage. Logica de marcador compartida con
 * socratic-gate.js en lib/uni-trabajo.js.
 *
 * ALCANCE REAL (medido el 2026-11-01): sin un `.ultron-trabajo.json` el limite
 * duro no existe, y hoy no hay ninguno en disco; crear los marcadores de los
 * trabajos ya abiertos es una decision del propietario. Mientras tanto una
 * escritura en `trabajos/<X>/borrador|entrega/` solo avisa.
 *
 * LIMITES DECLARADOS (heuristica conservadora, no exhaustiva):
 *  - Write/Edit/MultiEdit/NotebookEdit: EXACTO — lee tool_input.file_path
 *    (o notebook_path), sin ambiguedad posible.
 *  - Bash/PowerShell/Monitor (auditoria 2026-11-01): por cada comando que
 *    ejecuta la linea, tambien a traves de otra shell (lib/shell-wrappers.js):
 *    redirecciones de salida, pegadas o no (`>`, `>>`, no `>&N`), los verbos de
 *    VERBOS_* (cp, mv, rm, tee, touch, sed -i, dd of=, git mv/rm, Set-Content,
 *    Add-Content, Out-File, New-Item, Remove-Item…), `[IO.File]::Write*` y un
 *    `cd` previo en la misma linea. NO cubre: variables indirectas
 *    (`f=entrega/x.md; > $f`), escritura desde dentro de otro interprete
 *    (`python -c`, `node -e`, `perl -pi`), comandos de git que restauran ficheros
 *    (`git checkout`, `git restore`), ni symlinks que apunten a la carpeta
 *    protegida desde fuera. Es una barrera adicional sobre el recordatorio del
 *    gate socratico, no la unica linea de defensa.
 *
 * Cada decision deja `decision`, `rule` y `tool` en hook-timing.jsonl (nunca la
 * ruta): sin eso no se podia saber si habia disparado alguna vez.
 *
 * Desactivar a proposito: ULTRON_UNI_GUARD=off (vale para la sesion) o
 * retirar la carpeta de `protegidas` en el marcador.
 *
 * MARCADOR CORRUPTO (JSON invalido / `protegidas` con forma rara): no
 * bloquea (fail-open — no hay senal fiable de que proteger) NI pasa en
 * silencio: avisa en systemMessage y deja traza en logHookError (ni bloqueo
 * silencioso ni paso silencioso).
 *
 * Contrato: PreToolUse -> {hookSpecificOutput:{permissionDecision:'deny'}}
 * en bloqueo; sin hookSpecificOutput cuando solo avisa o cuando permite.
 * Fail-safe: cualquier error interno -> exit 0 sin decision (nunca bloquea
 * por un bug propio).
 */
'use strict';

const path = require('path');

if (require.main === module) {
  try {
    require('./lib/hook-obs.js').observe('uni-deliverable-guard');
  } catch (_) { /* la observabilidad jamas rompe un hook */ }
}

const { annotate, logHookError } = require('./lib/hook-obs');
const { comandosDe, palabras, variantes } = require('./lib/shell-wrappers');
const {
  findMarkerForTarget,
  matchProtected,
  trabajoSinMarcador,
  DEFAULT_PROTEGIDAS,
} = require('./lib/uni-trabajo');
const DEFAULT_PROTEGIDAS_TXT = DEFAULT_PROTEGIDAS.join(', ');

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_DIALECTS = Object.freeze({ Bash: ['bash'], PowerShell: ['ps'], Monitor: ['bash', 'ps'] });
// Destinos por comando: tope para que una linea enorme no cueste una busqueda de
// marcador por palabra (el hook es sincrono en cada llamada a la shell).
const MAX_CANDIDATOS = 32;

// El destino es el ultimo argumento (o el segundo en robocopy).
const VERBOS_COPIA = new Set(['cp', 'copy', 'move', 'mv', 'copy-item', 'cpi', 'move-item', 'mi', 'xcopy', 'rename-item', 'rni', 'ren']);
// Cada argumento que no es opcion es un fichero que se escribe o se borra.
const VERBOS_TODOS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'unlink', 'shred', 'truncate', 'touch', 'mkdir', 'md', 'tee']);
// Cmdlets: la ruta va en una opcion o es el primer posicional, y hay opciones con valor.
const VERBOS_CMDLET = new Set([
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni', 'remove-item', 'ri', 'tee-object',
]);
const OPCION_RUTA_CMDLET = /^-(?:path|literalpath|filepath|pspath|lp)$/i;
const OPCION_DESTINO = /^-(?:destination|dest)$/i;
const OPCION_DESTINO_UNIX = /^(?:-t|--target-directory)$/;
const RE_REDIRECCION = /"[^"]*"|'[^']*'|\d?>{1,2}(?!&)\s*("[^"]*"|'[^']*'|[^\s;&|)]+)/g;
const RE_DOTNET = /\[(?:System\.)?IO\.File\]::(?:Write|Append|Create|Delete|Move|Copy|Replace)\w*\(\s*("[^"]*"|'[^']*')(?:\s*,\s*("[^"]*"|'[^']*'))?/gi;
const RE_CD = /^(?:cd|chdir|pushd|set-location|sl|push-location)(?:\s+-\w+)*\s+(.+)$/i;

function stripQuotes(s) {
  return String(s || '').trim().replace(/^["']|["']$/g, '');
}

const noEsOpcion = (a) => !a.startsWith('-');

/** Valor tras la opcion que case con `re`, o null. `--op=valor` tambien. */
function valorDeOpcion(args, re) {
  for (let i = 0; i < args.length; i++) {
    const [nombre, pegado] = args[i].split(/=(.*)/s);
    if (re.test(nombre)) return pegado || args[i + 1] || null;
  }
  return null;
}

/** Destinos de cp/mv y parecidos. `cp -t dir a.md` y `-Destination` mandan sobre el orden. */
function destinosDeCopia(bin, args) {
  const explicito = valorDeOpcion(args, OPCION_DESTINO) || valorDeOpcion(args, OPCION_DESTINO_UNIX);
  if (explicito) return [explicito];
  const posicionales = args.filter(noEsOpcion);
  if (bin === 'robocopy') return posicionales.slice(1, 2);
  return posicionales.length >= 2 ? [posicionales[posicionales.length - 1]] : [];
}

/** Primer argumento posicional de un cmdlet, sin los valores de sus opciones. */
function destinosDeCmdlet(args) {
  const porOpcion = valorDeOpcion(args, OPCION_RUTA_CMDLET);
  if (porOpcion) return [porOpcion];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) i++;
    else return [args[i]];
  }
  return [];
}

/** Ficheros que escribe, mueve o borra un comando por su verbo. */
function destinosPorVerbo(bin, resto) {
  const args = palabras(resto);
  if (bin === 'robocopy' || VERBOS_COPIA.has(bin)) return destinosDeCopia(bin, args);
  if (VERBOS_TODOS.has(bin)) return args.filter(noEsOpcion);
  if (VERBOS_CMDLET.has(bin)) return destinosDeCmdlet(args);
  if (bin === 'sed' && args.some((a) => /^(?:-[a-zA-Z]*i|--in-place)/.test(a))) return args.filter(noEsOpcion).slice(1);
  if (bin === 'dd') return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
  return bin === 'git' ? destinosDeGit(args) : [];
}

/** `git [opciones globales] mv|rm …`: `-C` y `-c` llevan un valor aparte. */
function destinosDeGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += /^-[Cc]$/.test(args[i]) ? 2 : 1;
  const resto = args.slice(i + 1);
  if (args[i] === 'rm') return resto.filter(noEsOpcion);
  return args[i] === 'mv' ? destinosDeCopia('mv', resto) : [];
}

function redirecciones(texto) {
  return [...texto.matchAll(RE_REDIRECCION)].filter((m) => m[1] !== undefined).map((m) => stripQuotes(m[1]));
}

const esRelativa = (p) => !/^(?:[a-z]:|[\\/~]|\$|%)/i.test(p);

/** Candidatos de una linea ya desenvuelta, cada uno tras los `cd` que le preceden. */
function candidatosDeLinea(linea, dialectos) {
  const out = [];
  let dir = '';
  for (const { seg, real, bin, resto } of comandosDe(linea, dialectos)) {
    const cd = real.match(RE_CD);
    if (cd) {
      const destino = stripQuotes(cd[1]);
      dir = dir && esRelativa(destino) ? `${dir}/${destino}` : destino;
      continue;
    }
    for (const c of [...redirecciones(seg), ...destinosPorVerbo(bin, resto)]) {
      out.push(dir && esRelativa(c) ? `${dir}/${c}` : c);
    }
  }
  for (const m of linea.matchAll(RE_DOTNET)) {
    out.push(stripQuotes(m[1]));
    if (m[2]) out.push(stripQuotes(m[2]));
  }
  return out;
}

/**
 * Candidatos de ruta destino de un comando de shell (heuristica, ver cabecera).
 * @param {string} cmd
 * @param {string[]} [dialectos]
 */
function bashDestCandidates(cmd, dialectos = ['bash', 'ps']) {
  const out = variantes(String(cmd || ''), dialectos).flatMap((linea) => candidatosDeLinea(linea, dialectos));
  return [...new Set(out.filter(Boolean))].slice(0, MAX_CANDIDATOS);
}

function destPathsFor(toolName, toolInput) {
  if (FILE_TOOLS.has(toolName)) {
    const p = toolInput.file_path || toolInput.notebook_path;
    return p ? [p] : [];
  }
  const dialectos = SHELL_DIALECTS[toolName];
  return dialectos ? bashDestCandidates(toolInput.command || '', dialectos) : [];
}

/**
 * @param {object} data  payload PreToolUse completo (tool_name, tool_input, cwd)
 * @returns {{decision:'deny'|'warn', reason:string}|null}
 */
function classify(data) {
  if (process.env.ULTRON_UNI_GUARD === 'off') return null;
  const toolName = (data && data.tool_name) || '';
  const toolInput = (data && data.tool_input) || {};
  const cwd = (data && data.cwd) || process.cwd();

  const destPaths = destPathsFor(toolName, toolInput);
  if (!destPaths.length) return null;

  let aviso = null;
  for (const raw of destPaths) {
    let resolved;
    try {
      resolved = path.resolve(cwd, raw);
    } catch (_) {
      continue;
    }
    // El marcador se busca desde el DESTINO y, si no hay, desde el cwd (H27).
    const marker = findMarkerForTarget(resolved, cwd);
    if (!marker) {
      aviso = aviso || avisoSinMarcador(resolved);
      continue;
    }
    if (marker.corrupt) return avisoMarcadorCorrupto(marker);
    const folder = matchProtected(resolved, marker);
    if (folder) {
      return {
        decision: 'deny',
        reason:
          `escritura en "${resolved}" — carpeta protegida "${folder}" ` +
          `(marcador ${marker.markerPath}). Modo trabajo universitario: el ` +
          `entregable lo escribe el alumno, la IA senala problemas y orienta, ` +
          `no lo redacta. Desactivar a proposito: ULTRON_UNI_GUARD=off (esta ` +
          `sesion) o quita "${folder}" de "protegidas" en el marcador.`,
      };
    }
  }
  return aviso;
}

function avisoMarcadorCorrupto(marker) {
  logHookError(
    'uni-deliverable-guard',
    marker.error || new Error(`marcador ilegible: ${marker.markerPath}`),
  );
  return {
    decision: 'warn',
    reason:
      `marcador ${marker.markerPath} no es JSON valido (o "protegidas" no ` +
      `es una lista de carpetas) — este turno NO se bloquea, revisa el ` +
      `marcador (por defecto se asumiria: ${DEFAULT_PROTEGIDAS_TXT}).`,
  };
}

/**
 * Escritura en `trabajos/<X>/borrador|entrega/…` sin marcador: no se bloquea
 * (no hay senal de que el usuario quiera protegerlo), pero tampoco pasa en
 * silencio, porque sin marcador el limite duro del modo uni no existe.
 */
function avisoSinMarcador(resolved) {
  const trabajo = trabajoSinMarcador(resolved);
  if (!trabajo) return null;
  return {
    decision: 'warn',
    reason:
      `escritura en "${resolved}" (carpeta "${trabajo.carpeta}" de un trabajo) ` +
      `sin marcador .ultron-trabajo.json en "${trabajo.trabajoDir}": la ` +
      `carpeta NO esta protegida. Para protegerla, crea ahi el marcador con ` +
      `{"protegidas": ["borrador", "entrega"]}.`,
  };
}

function handle(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || '').replace(/^﻿/, ''));
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object' || data.hook_event_name !== 'PreToolUse') return null;

  let veredicto;
  try {
    veredicto = classify(data);
  } catch (exc) {
    // FAIL-SAFE: un fallo propio no puede bloquear el trabajo del usuario.
    process.stderr.write(`uni-deliverable-guard: classify() fallo, dejando pasar: ${exc}\n`);
    return null;
  }
  if (!veredicto) return null;

  annotate({ decision: veredicto.decision, rule: 'uni-deliverable', tool: String(data.tool_name || 'unknown') });
  if (veredicto.decision === 'warn') {
    return JSON.stringify({
      systemMessage: `ULTRON uni-deliverable-guard [AVISO]: ${veredicto.reason}`,
    });
  }

  return JSON.stringify({
    systemMessage: `ULTRON uni-deliverable-guard [BLOQUEADO]: ${veredicto.reason}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `BLOQUEADO (uni-deliverable-guard): ${veredicto.reason}`,
    },
  });
}

module.exports = { classify, handle, bashDestCandidates, destPathsFor };

if (require.main === module) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { stdin += c; });
  process.stdin.on('end', () => {
    const out = handle(stdin);
    if (out) process.stdout.write(`${out}\n`);
    process.exit(0);
  });
}
