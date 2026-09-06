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
 *   agente-fantasma  (Agent)  DENY  subagent_type que no existe en disco.
 *   uv               (Bash)   DENY  pip install / python suelto sin `uv run`.
 *   commit-format    (Bash)   DENY  git commit sin prefijo convencional.
 *   skip-permissions (Bash)   DENY  --dangerously-skip-permissions.
 *   force-push       (Bash)   ASK   push forzado (rescribe historia publicada).
 *
 * POR QUE agente-fantasma BLOQUEA Y NO AVISA: un `subagent_type` inexistente
 * no da error — Claude Code lo ignora en silencio y la delegacion se pierde
 * entera. Fue un KIRKARDO CRITICAL (sprint 2026-05-27) causado por una tabla
 * de agentes stale, y la unica senal era que el trabajo no aparecia.
 *
 * FAIL-OPEN DELIBERADO EN EL CATALOGO DE AGENTES: si las fuentes de disco dan
 * menos de MIN_CATALOGO nombres es que no supimos leerlas (plugins movidos,
 * permisos, otra maquina), no que el usuario tenga tres agentes. Bloquear con
 * un catalogo incompleto convertiria este hook en el fallo que pretende
 * evitar, asi que en ese caso deja pasar todo.
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

/**
 * Nombres invocables como `subagent_type`, reunidos de todas las fuentes que
 * Claude Code lee: agentes de usuario, agentes de plugin (con y sin prefijo
 * `plugin:`, porque ambos aparecen en la lista inyectada) y los del harness.
 *
 * @returns {Set<string>}
 */
function agentesValidos() {
  const out = new Set(AGENTES_BUILTIN);
  for (const f of ficherosMd(path.join(HOME, '.claude', 'agents'))) {
    out.add(f.replace(/\.md$/, ''));
  }
  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/agents/*.md
  const cache = path.join(HOME, '.claude', 'plugins', 'cache');
  let mercados = [];
  try {
    mercados = fs.readdirSync(cache);
  } catch (_) {
    mercados = [];
  }
  for (const m of mercados) {
    let plugins = [];
    try {
      plugins = fs.readdirSync(path.join(cache, m));
    } catch (_) {
      continue;
    }
    for (const p of plugins) {
      let versiones = [];
      try {
        versiones = fs.readdirSync(path.join(cache, m, p));
      } catch (_) {
        continue;
      }
      for (const v of versiones) {
        for (const f of ficherosMd(path.join(cache, m, p, v, 'agents'))) {
          const base = f.replace(/\.md$/, '');
          out.add(`${p}:${base}`);
          out.add(base);
        }
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
          decision: 'deny',
          regla: 'agente-fantasma',
          reason:
            `subagent_type "${tipo}" no existe en disco. Un tipo inexistente no ` +
            `da error: la delegacion se pierde en silencio.` +
            (cerca.length ? ` Cercanos: ${cerca.join(', ')}.` : ''),
        };
      }
    }
    return null;
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = input.command || '';
    const skip = reglaSkipPermissions(cmd);
    if (skip) return { decision: 'deny', regla: 'skip-permissions', reason: skip };
    const uv = reglaUv(cmd);
    if (uv) return { decision: 'deny', regla: 'uv', reason: uv };
    const commit = reglaCommitFormato(cmd);
    if (commit) return { decision: 'deny', regla: 'commit-format', reason: commit };
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
