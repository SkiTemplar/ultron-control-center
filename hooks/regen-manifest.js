#!/usr/bin/env node
/**
 * regen-manifest.js — regenera hooks/manifest.json desde la config VIVA
 * (~/.claude/settings.json) con checksums sha256 frescos de los ficheros reales.
 *
 * Motivo (Kirkardo Pass1 2026-06-10, cat9/H1): el manifest se editaba a mano y
 * acumulo 11/15 checksums desactualizados + 7 hooks vivos sin documentar.
 * La SoT de QUE corre es settings.json; el manifest es el espejo versionado y
 * auditado. Este script hace el espejo reproducible:
 *
 *   node hooks/regen-manifest.js                   # regenera manifest.json
 *   node hooks/regen-manifest.js --check           # exit 1 si el manifest esta desfasado (gate LOCAL)
 *   node hooks/regen-manifest.js --check-template  # exit 1 si plantilla y manifest divergen (gate CI)
 *
 * Por que DOS puertas (2026-09-22): `--check` lee ~/.claude/settings.json, que
 * es la config de UNA maquina. En un runner de CI ese fichero no existe, asi
 * que la puerta saldria en rojo por ENTORNO y no por regresion — justo el
 * motivo por el que kirkardo-eval quedo fuera del job de selftests. La mitad
 * que SI es auditable en cualquier maquina es la paridad entre lo que se
 * INSTALA (templates/settings-hooks.json) y el espejo versionado
 * (hooks/manifest.json): evento, matcher, timeout, async y que el script
 * exista en el repo. Esa es `--check-template`, y es la que corre en CI.
 * Los checksums NO entran ahi a proposito: reflejan los ficheros de la maquina
 * del mantenedor, y un runner limpio no tiene autoridad para juzgarlos.
 *
 * Metadatos que el settings.json no tiene (description, env_allowlist,
 * writes_memory, writer_path, version) se conservan del manifest anterior por
 * id; los hooks nuevos reciben placeholders marcados para completar a mano.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const MANIFEST = path.join(__dirname, 'manifest.json');
const TEMPLATE = path.join(__dirname, '..', 'templates', 'settings-hooks.json');
const REPO_ROOT = path.join(__dirname, '..');

function sha256(file) {
  try {
    // Normaliza CRLF->LF antes de hashear (card vrwxcf): con core.autocrlf=true los
    // hooks estan CRLF en el working tree pero LF en el indice, asi que hashear los
    // BYTES CRUDOS hacia fluctuar el checksum -> el gate de paridad fallaba en casi
    // cada commit. Hashear el contenido normalizado lo hace estable y portable
    // (mismo hash en Windows/Linux, con o sin autocrlf). latin1 preserva bytes 1:1.
    const normalized = fs.readFileSync(file).toString('latin1').replace(/\r\n/g, '\n');
    return crypto.createHash('sha256').update(normalized, 'latin1').digest('hex');
  } catch (_) {
    return 'FILE_MISSING';
  }
}

/** Despersonaliza rutas (repo publico, gate PII): C:/Users/<yo> -> ~. */
function dehome(s) {
  if (!s) return s;
  const homes = [HOME, HOME.replace(/\\/g, '/'), HOME.replace(/\//g, '\\')];
  let out = s;
  for (const h of homes) out = out.split(h).join('~');
  return out;
}

/** Re-expande ~ al HOME real (para leer ficheros al regenerar/checkear). */
function rehome(s) {
  return s && s.startsWith('~') ? HOME.replace(/\\/g, '/') + s.slice(1) : s;
}

// Extensiones que consideramos "un script" al buscar la ruta en la forma exec.
const SCRIPT_EXT_RE = /\.(?:js|mjs|cjs|py|ps1)$/i;

/** ¿Este token tiene pinta de ruta a un script (absoluta, ~, o relativa)? */
function looksLikeScriptPath(token) {
  const t = String(token || '').replace(/^["']+|["']+$/g, '');
  if (!SCRIPT_EXT_RE.test(t)) return false;
  return /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/]|\{[A-Z_]+\}[\\/])/.test(t) || t.includes('/');
}

/**
 * Extrae la ruta del script de una entrada de hook. Cubre las DOS formas:
 *
 *   shell: { command: "node C:/x/y.js" }              -> regex sobre el command
 *   exec:  { command: "node", args: ["C:/x/y.js"] }   -> la ruta va en args[0]
 *
 * La forma exec se paso por alto hasta 2026-09-22 y era una bomba de relojeria:
 * con ella `command` es solo "node", asi que TODOS los hooks colapsaban al id
 * "node" y el manifest perdia script, checksum, descripcion y metadatos de cada
 * uno de golpe. Con `uv run python X` en forma exec la ruta tampoco es args[0],
 * asi que tras mirar args[0] se recorren los demas argumentos.
 *
 * @param {string} command  el campo `command` de la entrada
 * @param {string[]} [args] el campo `args` (solo en la forma exec)
 */
function scriptPathOf(command, args) {
  if (Array.isArray(args) && args.length) {
    const first = String(args[0] || '').replace(/^["']+|["']+$/g, '');
    if (looksLikeScriptPath(first)) return first;
    for (const a of args) {
      const t = String(a || '').replace(/^["']+|["']+$/g, '');
      if (looksLikeScriptPath(t)) return t;
    }
  }
  const m = String(command || '').match(
    /(?:node|python|-File)\s+("?)([A-Za-z]:[^\s"]+|\/[^\s"]+|~[\\/][^\s"]+|\{[A-Z_]+\}[^\s"]+)\1/,
  );
  return m ? m[2] : null;
}

function idOf(scriptPath, command, args) {
  if (scriptPath) return path.basename(scriptPath).replace(/\.(js|mjs|cjs|py|ps1)$/, '');
  const full = Array.isArray(args) && args.length ? `${command} ${args.join(' ')}` : String(command || '');
  return full.slice(0, 40).replace(/\W+/g, '-');
}

/**
 * Aplana `settings.hooks` a una lista de entradas comparables. Compartido por
 * la regeneracion (config viva) y por la puerta de paridad (plantilla).
 * @returns {{event:string,matcher:string,id:string,script:string|null,timeout_s:number|null,async:boolean,raw:object}[]}
 */
function flattenHooks(settingsHooks) {
  const out = [];
  for (const [event, groups] of Object.entries(settingsHooks || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const h of group.hooks || []) {
        const sp = scriptPathOf(h.command, h.args);
        out.push({
          event,
          matcher: group.matcher || '*',
          id: idOf(sp, h.command, h.args),
          script: sp,
          timeout_s: h.timeout != null ? h.timeout : null,
          async: h.async === true,
          raw: h,
        });
      }
    }
  }
  return out;
}

function main() {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const old = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  const oldById = new Map((old.hooks || []).map((h) => [h.id, h]));

  const hooks = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of groups) {
      for (const h of group.hooks || []) {
        const sp = scriptPathOf(h.command, h.args);
        const id = idOf(sp, h.command, h.args);
        const prev = oldById.get(id) || {};
        hooks.push({
          id,
          event,
          matcher: group.matcher || '*',
          // Forma exec ({command:"node", args:[...]}): se guarda la linea
          // equivalente para que el manifest siga siendo legible de un vistazo.
          command: dehome(
            Array.isArray(h.args) && h.args.length ? `${h.command} ${h.args.join(' ')}` : h.command,
          ),
          script: dehome(sp),
          timeout_s: h.timeout != null ? h.timeout : null,
          // Semantica critica (ver rules/common/hooks.md): async=true corre
          // fire-and-forget y su stdout JSON SE DESCARTA — sin este campo el
          // manifest vendia como sincronos hooks que no pueden hablar al modelo.
          async: h.async === true,
          checksum_sha256: sp ? sha256(sp) : null,
          version: prev.version || '1.0.0',
          env_allowlist: prev.env_allowlist || [],
          failure_policy: prev.failure_policy || 'no_op',
          writes_memory: prev.writes_memory != null ? prev.writes_memory : false,
          writer_path: prev.writer_path || 'NONE',
          description: prev.description || 'TODO: describir (hook nuevo detectado por regen-manifest)',
        });
      }
    }
  }

  const manifest = {
    $schema: 'https://ultron.local/schemas/hooks-manifest-v2.json',
    manifest_version: 2,
    generated_at: new Date().toISOString().slice(0, 10),
    generated_by: 'hooks/regen-manifest.js (NO editar hooks[] a mano; editar settings.json y regenerar)',
    source_of_truth: '~/.claude/settings.json (config viva) -> scripts versionados en ~/.ultron',
    notes: [
      'Los hooks PROPONEN candidates; NUNCA escriben memoria directa. El unico escritor del SoT (brain.db) es MemoryService (sidecar ultron-memory).',
      'writer_path PROHIBIDO: qdrant_direct, mem0. Solo MemoryService o NONE.',
      'Regenerar tras cualquier cambio en settings.json: node hooks/regen-manifest.js',
      'Gate de paridad LOCAL (lee ~/.claude/settings.json): node hooks/regen-manifest.js --check',
      'Gate de paridad en CI (plantilla vs manifest, sin ~/.claude): node hooks/regen-manifest.js --check-template',
    ],
    writer_paths_allowed: ['MemoryService', 'NONE'],
    writer_paths_forbidden: ['qdrant_direct', 'mem0'],
    hooks,
    deregistered: old.deregistered || [],
  };

  const next = JSON.stringify(manifest, null, 2) + '\n';

  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8') : '';
    // Comparar ignorando generated_at (cambia cada dia sin drift real) y
    // line-endings: git en Windows (autocrlf) puede reescribir el manifest a
    // CRLF mientras next siempre es LF — eso NO es drift (card vrwxcf).
    const norm = (s) =>
      s.replace(/\r\n/g, '\n').replace(/"generated_at": "[^"]*"/, '"generated_at": "X"');
    if (norm(cur) !== norm(next)) {
      console.error('DRIFT: hooks/manifest.json no coincide con settings.json + checksums reales. Ejecuta: node hooks/regen-manifest.js');
      process.exit(1);
    }
    console.log('OK: manifest en paridad con settings.json (' + hooks.length + ' hooks)');
    return;
  }

  fs.writeFileSync(MANIFEST, next);
  const missing = hooks.filter((h) => h.checksum_sha256 === 'FILE_MISSING');
  const todo = hooks.filter((h) => h.description.startsWith('TODO'));
  console.log('manifest regenerado: ' + hooks.length + ' hooks');
  if (missing.length) console.log('AVISO scripts faltantes: ' + missing.map((h) => h.id).join(', '));
  if (todo.length) console.log('AVISO descripciones TODO: ' + todo.map((h) => h.id).join(', '));
}

// ---------------------------------------------------------------------------
// Puerta de paridad plantilla <-> manifest (la que corre en CI)
// ---------------------------------------------------------------------------

/** Ruta del script relativa al repo, o null si el token no apunta dentro de el. */
function templateScriptRel(scriptPath) {
  if (!scriptPath) return null;
  const norm = String(scriptPath).replace(/\\/g, '/');
  const m = norm.match(/^\{USERPROFILE\}\/\.(?:ultron|maria)\/(.+)$/);
  return m ? m[1] : null;
}

/**
 * Compara lo que se INSTALA (templates/settings-hooks.json) con el espejo
 * versionado (hooks/manifest.json). Devuelve la lista de problemas — vacia
 * significa paridad. Pura salvo la lectura de los dos ficheros y el
 * `existsSync` de cada script, asi que el selftest la ejercita con arboles
 * falsos sin tocar el repo.
 *
 * Lo que comprueba, por cada hook de la plantilla:
 *   1. que exista en el manifest con el mismo (evento, matcher, id);
 *   2. que coincidan `timeout` y `async` — `async: true` descarta el stdout
 *      del hook, asi que una divergencia aqui convierte en no-op silencioso
 *      un hook que habla al modelo (mandamiento 11);
 *   3. que el .js/.py referenciado exista en el repo (la promesa que el
 *      propio _comment de la plantilla ya hacia y nadie verificaba).
 *
 * Lo que NO comprueba, a proposito: los checksums. Reflejan los ficheros de la
 * maquina del mantenedor; un runner limpio no tiene autoridad sobre ellos.
 */
function templateParityProblems(template, manifest, repoRoot = REPO_ROOT, exists = fs.existsSync) {
  const problems = [];
  const byKey = new Map(
    (manifest.hooks || []).map((h) => [`${h.event}|${h.matcher || '*'}|${h.id}`, h]),
  );
  for (const t of flattenHooks(template.hooks)) {
    const key = `${t.event}|${t.matcher}|${t.id}`;
    const m = byKey.get(key);
    if (!m) {
      problems.push(`falta en el manifest: ${key} (anadelo a mano o regenera desde settings.json)`);
      continue;
    }
    if (t.timeout_s !== m.timeout_s) {
      problems.push(`${key}: timeout plantilla=${t.timeout_s} manifest=${m.timeout_s}`);
    }
    if (t.async !== m.async) {
      problems.push(`${key}: async plantilla=${t.async} manifest=${m.async}`);
    }
    const rel = templateScriptRel(t.script);
    if (!rel) {
      problems.push(`${key}: la plantilla no apunta a un script dentro del repo (${t.script})`);
    } else if (!exists(path.join(repoRoot, rel))) {
      problems.push(`${key}: el script referenciado no existe en el repo (${rel})`);
    }
  }
  return problems;
}

function checkTemplate() {
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const problems = templateParityProblems(template, manifest);
  if (problems.length) {
    console.error('DRIFT plantilla <-> manifest (' + problems.length + '):');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  const n = flattenHooks(template.hooks).length;
  console.log(`OK: templates/settings-hooks.json en paridad con hooks/manifest.json (${n} hooks)`);
}

// Exportado para hooks/regen-manifest.selftest.mjs.
module.exports = {
  scriptPathOf,
  idOf,
  flattenHooks,
  templateScriptRel,
  templateParityProblems,
  dehome,
};

if (require.main === module) {
  if (process.argv.includes('--check-template')) checkTemplate();
  else main();
}
