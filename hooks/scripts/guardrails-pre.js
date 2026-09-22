#!/usr/bin/env node
/**
 * ULTRON HOOK · guardrails-pre · v1.0
 *
 * PreToolUse. Convierte en comprobacion determinista las condiciones que hasta
 * ahora vivian como prosa en CLAUDE.md y en rules/common. El texto en un
 * fichero de instrucciones es una peticion: el modelo puede no leerlo, puede
 * perderlo tras una compactacion y puede decidir que este caso es la
 * excepcion. Un hook no.
 *
 * REGLAS
 *   agente-fantasma  (Agent)  ASK   subagent_type que no aparece en el catalogo.
 *   force-push       (Bash)   ASK   push forzado (rescribe historia publicada).
 *   uv               (Bash)   DENY  pip install / python suelto sin `uv run`.   [apagada]
 *   commit-format    (Bash)   DENY  git commit sin prefijo convencional.        [apagada]
 *   skip-permissions (Bash)   DENY  --dangerously-skip-permissions.             [apagada]
 *
 * POR QUE LAS TRES DENY DE BASH VIENEN APAGADAS (2026-09-22, al registrar el
 * hook en la plantilla): las tres son heuristicas sobre TEXTO DE SHELL, y un
 * DENY es un bloqueo sin apelacion. Un falso positivo no avisa: para el
 * trabajo en seco y obliga a reescribir el comando a ciegas. Las dos que se
 * quedan activas no tienen esa forma — las dos PREGUNTAN. Para encenderlas:
 * ULTRON_GUARDRAILS_BASH=1 en el entorno de la sesion.
 *
 * POR QUE agente-fantasma AVISA Y NO BLOQUEA (2026-09-22): un `subagent_type`
 * inexistente no da error — Claude Code lo ignora en silencio y la delegacion
 * se pierde entera (KIRKARDO CRITICAL del sprint 2026-05-27, causado por una
 * tabla de agentes stale), asi que la comprobacion vale la pena. Pero nacio con
 * DENY y con UN SOLO arbol de plugins (`plugins/cache/...`), que en Claude Code
 * 2.1.278 no existe: el resultado medido en esta maquina era que TODOS los
 * agentes de plugin —`pr-review-toolkit:silent-failure-hunter`,
 * `brand-voice:discover-brand`— se bloqueaban sin apelacion. El catalogo ya
 * recorre los arboles reales (abajo), pero sigue siendo una lista de ficheros:
 * un agente que venga por un camino que no conocemos volveria a ser un falso
 * positivo, y un ASK avisa igual de bien sin poder parar una delegacion
 * legitima. Esa es la misma razon por la que se apagaron las tres DENY de Bash.
 *
 * DONDE VIVEN LOS AGENTES DE PLUGIN (comprobado en esta maquina, 2026-09-22):
 *   ~/.claude/plugins/marketplaces/<mercado>/plugins/<plugin>/agents/*.md
 *   ~/.claude/plugins/synced/<id>/<plugin>/agents/*.md
 *   ~/.claude/plugins/cache/<mercado>/<plugin>/<version>/agents/*.md  [heredado]
 * El nombre de la CARPETA del plugin no siempre es el prefijo invocable
 * (`customer-support~g2/` declara `"name": "customer-support"`), asi que se
 * aceptan los dos.
 *
 * FAIL-OPEN DELIBERADO EN EL CATALOGO DE AGENTES: si las fuentes de disco dan
 * menos de MIN_CATALOGO nombres es que no supimos leerlas (plugins movidos,
 * permisos, otra maquina), no que el usuario tenga tres agentes. Avisar con un
 * catalogo incompleto seria puro ruido, asi que en ese caso deja pasar todo.
 *
 * Contrato: PreToolUse -> {hookSpecificOutput:{permissionDecision}}. Cualquier
 * error interno sale por exit 0 sin decision: un guardrail roto no puede
 * bloquear el trabajo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Solo cuando corre como hook: importado desde el selftest no debe ensuciar la
// telemetria con ejecuciones que no son de produccion.
if (require.main === module) {
  try {
    require('./lib/hook-obs.js').observe('guardrails-pre');
  } catch (_) { /* la observabilidad jamas rompe un hook */ }
}

const HOME = os.homedir();

/** Por debajo de esto se asume catalogo mal leido y la regla se desactiva. */
const MIN_CATALOGO = 20;

/**
 * ¿Estan encendidas las reglas DENY sobre lineas de Bash (uv, commit-format,
 * skip-permissions)? Se lee en CADA llamada, no al cargar el modulo: asi el
 * selftest puede ejercitar los dos estados en el mismo proceso, y el flag se
 * puede poner por sesion sin reinstalar nada.
 */
function reglasBashActivas() {
  return process.env.ULTRON_GUARDRAILS_BASH === '1';
}

/** Tipos que sirve el propio harness y que no tienen fichero en disco. */
const AGENTES_BUILTIN = [
  'general-purpose', 'Explore', 'Plan', 'claude', 'fork',
  'statusline-setup', 'output-style-setup',
];

const TIPOS_COMMIT = [
  'feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'ci',
  'build', 'style', 'revert',
];

// ---------------------------------------------------------------------------
// Catalogo de agentes
// ---------------------------------------------------------------------------

function ficherosMd(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch (_) {
    return [];
  }
}

/** Subcarpetas de `dir` (lista vacia si no existe o no se deja leer). */
function subcarpetas(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      // Las junctions de Windows no son isDirectory(), y ~/.claude/plugins usa
      // enlaces de directorio: sin isSymbolicLink() se perderian arboles enteros.
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch (_) {
    return [];
  }
}

/**
 * Prefijos con los que se puede invocar un agente de este plugin. El prefijo
 * que usa Claude Code es el NOMBRE del plugin, que no siempre es el de su
 * carpeta: en esta maquina `synced/<id>/customer-support~g2/` declara
 * `"name": "customer-support"`. Se aceptan los dos — es gratis y evita avisar
 * por un sufijo de carpeta.
 */
function prefijosDePlugin(dirPlugin, nombreCarpeta) {
  const out = new Set([nombreCarpeta]);
  try {
    const raw = fs.readFileSync(path.join(dirPlugin, '.claude-plugin', 'plugin.json'), 'utf8');
    const nombre = JSON.parse(raw).name;
    if (typeof nombre === 'string' && nombre.trim()) out.add(nombre.trim());
  } catch (_) {
    /* sin manifiesto legible: vale el nombre de la carpeta */
  }
  return out;
}

/**
 * Anade a `out` los agentes de `<dirPlugin>/agents`, con prefijo y sin el
 * (ambas formas aparecen en la lista que se le inyecta al modelo).
 */
function agentesDePlugin(out, dirPlugin, nombreCarpeta) {
  const ficheros = ficherosMd(path.join(dirPlugin, 'agents'));
  if (ficheros.length === 0) return;
  const prefijos = prefijosDePlugin(dirPlugin, nombreCarpeta);
  for (const f of ficheros) {
    const base = f.replace(/\.md$/, '');
    out.add(base);
    for (const p of prefijos) out.add(`${p}:${base}`);
  }
}

/**
 * Nombres invocables como `subagent_type`, reunidos de todas las fuentes que
 * Claude Code lee: los del harness, los del usuario, los del repo abierto y los
 * de plugin en sus TRES layouts (ver cabecera). Hasta el 2026-09-22 solo se
 * miraba `plugins/cache`, que en 2.1.278 ya no se crea: el catalogo salia sin
 * un solo agente de plugin y la regla los marcaba todos como inexistentes.
 *
 * @returns {Set<string>}
 */
function agentesValidos() {
  const out = new Set(AGENTES_BUILTIN);

  // Agentes sueltos: los del usuario y los del repo que se tiene abierto
  // (<cwd>/.claude/agents, que Claude Code tambien carga y aqui faltaban).
  for (const dir of [
    path.join(HOME, '.claude', 'agents'),
    path.join(process.cwd(), '.claude', 'agents'),
  ]) {
    for (const f of ficherosMd(dir)) out.add(f.replace(/\.md$/, ''));
  }

  const raizPlugins = path.join(HOME, '.claude', 'plugins');

  // marketplaces/<mercado>/{plugins,external_plugins}/<plugin>/agents
  const marketplaces = path.join(raizPlugins, 'marketplaces');
  for (const mercado of subcarpetas(marketplaces)) {
    for (const grupo of ['plugins', 'external_plugins']) {
      const raiz = path.join(marketplaces, mercado, grupo);
      for (const p of subcarpetas(raiz)) agentesDePlugin(out, path.join(raiz, p), p);
    }
  }

  // synced/<id>/<plugin>/agents
  const synced = path.join(raizPlugins, 'synced');
  for (const id of subcarpetas(synced)) {
    const raiz = path.join(synced, id);
    for (const p of subcarpetas(raiz)) agentesDePlugin(out, path.join(raiz, p), p);
  }

  // cache/<mercado>/<plugin>/<version>/agents — layout heredado, se mantiene
  // por si una instalacion vieja todavia lo tiene.
  const cache = path.join(raizPlugins, 'cache');
  for (const mercado of subcarpetas(cache)) {
    for (const p of subcarpetas(path.join(cache, mercado))) {
      for (const v of subcarpetas(path.join(cache, mercado, p))) {
        agentesDePlugin(out, path.join(cache, mercado, p, v), p);
      }
    }
  }

  return out;
}

/** Sugerencias por distancia de edicion, para que el bloqueo sea accionable. */
function parecidos(nombre, catalogo, max) {
  const objetivo = String(nombre).toLowerCase();
  const dist = (a, b) => {
    const m = a.length;
    const n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = cur;
    }
    return prev[n];
  };
  return [...catalogo]
    .map((c) => ({ c, d: dist(objetivo, c.toLowerCase()) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, max || 3)
    .filter((x) => x.d <= Math.max(4, Math.floor(objetivo.length / 2)))
    .map((x) => x.c);
}

// ---------------------------------------------------------------------------
// Reglas sobre Bash
// ---------------------------------------------------------------------------

/**
 * Trocea una linea de shell en comandos sueltos. Las reglas miran el COMIENZO
 * de cada trozo: `grep python foo.txt` o `echo "python x.py"` no son
 * invocaciones de Python, y castigarlas seria ruido que acaba con el hook
 * desactivado.
 *
 * @param {string} cmd
 * @returns {string[]}
 */
function segmentos(cmd) {
  return sinHeredocs(cmd)
    .split(/\n|;|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Quita el CUERPO de los here-docs y here-strings, dejando solo la linea que
 * los abre. Lo de dentro son datos que van por stdin, no comandos: sin esto,
 * un `uv run python - <<'PY' … PY` se bloqueaba a si mismo porque el
 * terminador `PY` parecia una invocacion del launcher `py`, y el mensaje de un
 * commit que citara `python x.py` tambien saltaba.
 *
 * @param {string} cmd
 * @returns {string}
 */
function sinHeredocs(cmd) {
  const lineas = String(cmd || '').split('\n');
  const out = [];
  let cerrar = null;
  for (const linea of lineas) {
    if (cerrar) {
      if (linea.trim() === cerrar) cerrar = null;
      continue;
    }
    out.push(linea);
    const heredoc = linea.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (heredoc) { cerrar = heredoc[2]; continue; }
    if (/@['"]\s*$/.test(linea)) cerrar = linea.includes('@"') ? '"@' : "'@";
  }
  return out.join('\n');
}

/** Quita prefijos que no cambian que binario se acaba ejecutando. */
function sinPrefijos(seg) {
  return seg.replace(/^(?:sudo|nohup|time|env(?:\s+\w+=\S+)*)\s+/i, '').trim();
}

/**
 * CLAUDE.md: "UV siempre. Nunca `python -m`, `pip install`, ni
 * `python script.py`". Se comprueba por segmento y solo al principio.
 */
function reglaUv(cmd) {
  for (const bruto of segmentos(cmd)) {
    const seg = sinPrefijos(bruto);
    if (/^uv(\s|$)/i.test(seg)) continue;            // uv run / uv pip: correcto
    if (/^(python3?|py)(\.exe)?(\s|$)/i.test(seg)) {
      return `\`${seg.slice(0, 60)}\` invoca Python fuera de UV — usa \`uv run python ...\``;
    }
    if (/(^|\s)pip3?(\.exe)?\s+install(\s|$)/i.test(seg)) {
      return `\`${seg.slice(0, 60)}\` usa pip directo — usa \`uv pip install ...\``;
    }
  }
  return null;
}

/** Extrae el mensaje de un `git commit`, venga en -m o en here-string. */
function mensajeCommit(cmd) {
  const s = String(cmd || '');
  const heredoc = s.match(/-m\s+@'\r?\n([\s\S]*?)\r?\n'@/) || s.match(/-m\s+<<-?'?\w+'?\r?\n([\s\S]*?)\r?\n\w+/);
  if (heredoc) return heredoc[1];
  const comillas = s.match(/-m\s+"((?:[^"\\]|\\.)*)"/) || s.match(/-m\s+'((?:[^'\\]|\\.)*)'/);
  if (comillas) return comillas[1];
  const suelto = s.match(/-m\s+(\S+)/);
  return suelto ? suelto[1] : null;
}

/** rules/common/git-workflow.md: `<type>: <description>`. */
function reglaCommitFormato(cmd) {
  const s = String(cmd || '');
  if (!/(^|\s)git\s+(-\S+\s+)*commit(\s|$)/.test(s)) return null;
  if (/--amend/.test(s) && !/-m\s/.test(s)) return null;   // reusa el mensaje previo
  if (/\s-(F|-file)\b/.test(s)) return null;               // mensaje en fichero
  const msg = mensajeCommit(s);
  if (!msg) return null;                                   // no se pudo leer: no se bloquea
  const primera = msg.split(/\r?\n/)[0].trim();
  const re = new RegExp(`^(${TIPOS_COMMIT.join('|')})(\\([^)]+\\))?!?: .+`);
  if (re.test(primera)) return null;
  return `commit "${primera.slice(0, 60)}" no sigue \`<type>: <description>\` (${TIPOS_COMMIT.slice(0, 8).join(', ')}…)`;
}

/**
 * rules/common/hooks.md: "Never use dangerously-skip-permissions flag".
 *
 * Se exige que el segmento INVOQUE el binario `claude` con la bandera. La
 * primera version buscaba la cadena en cualquier parte del comando y bloqueó
 * un `node -e` que solo la nombraba dentro de la descripcion de un hook:
 * escribir el nombre de una bandera prohibida no es usarla, y un guardrail que
 * no distingue las dos cosas impide documentar la propia norma.
 */
function reglaSkipPermissions(cmd) {
  for (const bruto of segmentos(cmd)) {
    const seg = sinPrefijos(bruto).replace(/^npx\s+/i, '');
    if (!/^claude(\.exe)?(\s|$)/i.test(seg)) continue;
    if (/\s--dangerously-skip-permissions(\s|$|=)/.test(seg)) {
      return 'invocar claude con la bandera de saltarse permisos esta prohibido en las reglas del sistema';
    }
  }
  return null;
}

/** Reescribir historia ya publicada no se deshace: pide confirmacion. */
function reglaForcePush(cmd) {
  const s = String(cmd || '');
  if (!/(^|\s)git\s+push(\s|$)/.test(s)) return null;
  if (!/(\s--force(-with-lease)?\b|\s-f\b)/.test(s)) return null;
  return 'push forzado: reescribe historia ya publicada';
}

// ---------------------------------------------------------------------------
// Clasificador
// ---------------------------------------------------------------------------

/**
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {{decision:'deny'|'ask', regla:string, reason:string}|null}
 */
function classify(toolName, toolInput) {
  const input = toolInput || {};

  if (toolName === 'Agent' || toolName === 'Task') {
    const tipo = input.subagent_type;
    if (typeof tipo === 'string' && tipo.trim()) {
      const catalogo = agentesValidos();
      if (catalogo.size >= MIN_CATALOGO && !catalogo.has(tipo.trim())) {
        const cerca = parecidos(tipo.trim(), catalogo, 3);
        return {
          // ASK, no DENY: el catalogo es una lista de ficheros y siempre puede
          // quedarse corta (ver cabecera). Preguntar avisa igual y no puede
          // parar una delegacion legitima.
          decision: 'ask',
          regla: 'agente-fantasma',
          reason:
            `subagent_type "${tipo}" no aparece en el catalogo de agentes de este ` +
            `disco. Un tipo inexistente no da error: la delegacion se pierde en ` +
            `silencio. Si el agente existe de verdad, sigue adelante.` +
            (cerca.length ? ` Cercanos: ${cerca.join(', ')}.` : ''),
        };
      }
    }
    return null;
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = input.command || '';
    // Las tres DENY solo con ULTRON_GUARDRAILS_BASH=1 (ver cabecera).
    if (reglasBashActivas()) {
      const skip = reglaSkipPermissions(cmd);
      if (skip) return { decision: 'deny', regla: 'skip-permissions', reason: skip };
      const uv = reglaUv(cmd);
      if (uv) return { decision: 'deny', regla: 'uv', reason: uv };
      const commit = reglaCommitFormato(cmd);
      if (commit) return { decision: 'deny', regla: 'commit-format', reason: commit };
    }
    // El ASK de force-push va SIEMPRE: pregunta, no bloquea.
    const fpush = reglaForcePush(cmd);
    if (fpush) return { decision: 'ask', regla: 'force-push', reason: fpush };
  }

  return null;
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

  let veredicto;
  try {
    veredicto = classify(data.tool_name || '', data.tool_input || {});
  } catch (exc) {
    // FAIL-OPEN: a diferencia de deny-secrets, aqui un fallo del clasificador
    // no deja expuesto ningun secreto — solo se pierde una comprobacion de
    // higiene. Bloquear todo por un bug propio saldria mucho mas caro.
    process.stderr.write(`guardrails-pre: classify() fallo, dejando pasar: ${exc}\n`);
    return null;
  }
  if (!veredicto) return null;

  const etiqueta = veredicto.decision === 'deny' ? 'BLOQUEADO' : 'CONFIRMA';
  return JSON.stringify({
    systemMessage: `ULTRON guardrails [${veredicto.regla}]: ${veredicto.reason}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: veredicto.decision,
      permissionDecisionReason: `${etiqueta} (guardrails/${veredicto.regla}): ${veredicto.reason}`,
    },
  });
}

module.exports = {
  classify,
  handle,
  reglasBashActivas,
  agentesValidos,
  reglaUv,
  reglaCommitFormato,
  reglaSkipPermissions,
  reglaForcePush,
  mensajeCommit,
};

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    raw += c;
  });
  process.stdin.on('end', () => {
    const out = handle(raw);
    if (out) process.stdout.write(out + '\n');
    process.exit(0);
  });
}
