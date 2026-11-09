'use strict';

/**
 * lib/codex-exec.js — una llamada de texto a Codex CLI en modo no interactivo
 * (`codex exec`), con la suscripcion de ChatGPT (coste 0 por uso) y contexto
 * grande. La usa session-summarize-previous.js como primer eslabon, antes de
 * la cadena Groq -> Gemini de lib/secondary-llm.js. NUNCA lanza `claude`.
 *
 * Invocacion (ver docs/delegacion-y-clis.md):
 *   codex exec --ephemeral --skip-git-repo-check --ignore-user-config
 *              --ignore-rules -s read-only -m <modelo>
 *              -c model_reasoning_effort="<effort>" --color never
 *              -C <dir vacio> -o <fichero> -
 *
 * - El prompt va SIEMPRE por stdin (`-`): por argumento, un digest de mas de
 *   32.767 caracteres rompe con ENAMETOOLONG en Windows.
 * - `-s read-only` + directorio de trabajo vacio y temporal: el agente no puede
 *   escribir en disco ni tiene un repo que explorar. `--ignore-user-config`
 *   evita arrancar los servidores MCP, plugins y el `notify` de
 *   ~/.codex/config.toml (la autenticacion sigue en CODEX_HOME).
 * - `-o <fichero>`: solo el mensaje final del agente; stdout de respaldo.
 * - En Windows no se lanza el shim `codex.cmd` (Node exige shell para un .cmd):
 *   se ejecuta `node <npm>/@openai/codex/bin/codex.js`. Al agotar el plazo se
 *   mata el arbol entero con `taskkill /T /F` (codex.js lanza codex.exe hijo).
 *
 * Errores: solo una clasificacion (no instalado, sin login, cuota, timeout,
 * exit N, respuesta vacia); nunca el stderr crudo ni el prompt.
 *
 * Seam de test: CODEX_EXEC_BIN fuerza el lanzador (un .js/.mjs/.cjs se ejecuta
 * con el node actual; cualquier otra ruta, directamente).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const STDERR_TAIL_BYTES = 16 * 1024;
const STDOUT_MAX_BYTES = 2 * 1024 * 1024;
const NODE_SCRIPT = /\.(c|m)?js$/i;

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** codex.js del paquete npm junto a un directorio de shims (…/npm). */
function npmCodexJs(dir) {
  return path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

/**
 * Lanzador de Codex: {file, prefixArgs} o null si no esta instalado.
 * Orden: CODEX_EXEC_BIN; en Windows el codex.js de %APPDATA%\npm y el del
 * primer directorio del PATH con codex.cmd, o codex.exe; fuera de Windows,
 * `codex` del PATH.
 */
function resolveCodexLauncher() {
  const forced = process.env.CODEX_EXEC_BIN;
  if (forced) {
    if (!isFile(forced)) return null;
    return NODE_SCRIPT.test(forced) ? { file: process.execPath, prefixArgs: [forced] } : { file: forced, prefixArgs: [] };
  }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      const js = npmCodexJs(path.join(process.env.APPDATA, 'npm'));
      if (isFile(js)) return { file: process.execPath, prefixArgs: [js] };
    }
    for (const d of dirs) {
      if (isFile(path.join(d, 'codex.cmd')) && isFile(npmCodexJs(d))) return { file: process.execPath, prefixArgs: [npmCodexJs(d)] };
      if (isFile(path.join(d, 'codex.exe'))) return { file: path.join(d, 'codex.exe'), prefixArgs: [] };
    }
    return null;
  }
  for (const d of dirs) {
    if (isFile(path.join(d, 'codex'))) return { file: path.join(d, 'codex'), prefixArgs: [] };
  }
  return null;
}

/** Argumentos de `codex exec` (sin el prompt: va por stdin). */
function buildExecArgs({ model, reasoningEffort, workDir, outFile }) {
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '-s',
    'read-only',
    '--color',
    'never',
    '-C',
    workDir,
    '-o',
    outFile,
  ];
  if (model) args.push('-m', model);
  if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  args.push('-');
  return args;
}

/** Motivo legible de un fallo a partir del stderr (sin volcarlo). */
function classifyFailure(code, stderrTail) {
  const s = String(stderrTail || '');
  if (/401 Unauthorized|Not logged in|Missing bearer/i.test(s)) return 'sin login (ejecutar `codex login`)';
  if (/\b429\b|usage limit|rate limit|quota/i.test(s)) return 'cuota agotada';
  return `exit ${code}`;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* el proceso ya salio */
  }
}

function readOutFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Ejecuta `codex exec` con `prompt` por stdin y devuelve el texto final.
 * @param {{prompt:string, model?:string, reasoningEffort?:string, timeoutMs?:number}} opts
 * @returns {Promise<{ok:true, text:string, model:string, ms:number}
 *                  |{ok:false, error:string, ms:number}>}
 */
function askCodex({ prompt, model, reasoningEffort, timeoutMs = 120000 }) {
  const t0 = Date.now();
  const label = model || 'default';
  const fail = (why) => ({ ok: false, error: `codex/${label}: ${why}`, ms: Date.now() - t0 });
  const launcher = resolveCodexLauncher();
  if (!launcher) return Promise.resolve(fail('no instalado'));

  let workDir;
  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-codex-'));
  } catch (e) {
    return Promise.resolve(fail(`sin directorio temporal (${(e && e.code) || 'error'})`));
  }
  const outFile = path.join(workDir, 'last-message.txt');
  const cleanup = () => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderrTail = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(value);
    };

    let child;
    try {
      child = childProcess.spawn(launcher.file, [...launcher.prefixArgs, ...buildExecArgs({ model, reasoningEffort, workDir, outFile })], {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      cleanup();
      resolve(fail(e && e.code === 'ENOENT' ? 'no instalado' : `no arranca (${(e && e.code) || 'error'})`));
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      if (stdout.length < STDOUT_MAX_BYTES) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderrTail = (stderrTail + c.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (e) => finish(fail(e && e.code === 'ENOENT' ? 'no instalado' : `no arranca (${(e && e.code) || 'error'})`)));
    child.on('close', (code) => {
      if (timedOut) return finish(fail(`timeout (${Math.round(timeoutMs / 1000)} s)`));
      if (code !== 0) return finish(fail(classifyFailure(code, stderrTail)));
      const text = (readOutFile(outFile) || stdout).trim();
      if (!text) return finish(fail('respuesta vacia'));
      return finish({ ok: true, text, model: label, ms: Date.now() - t0 });
    });

    child.stdin.on('error', () => {
      /* EPIPE si codex sale antes de leer todo el prompt: lo decide 'close' */
    });
    child.stdin.end(String(prompt || ''), 'utf8');
  });
}

module.exports = { askCodex, buildExecArgs, resolveCodexLauncher, classifyFailure };
