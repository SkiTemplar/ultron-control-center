/**
 * adapters.mjs - un adaptador por `runner` (codex | agy | opencode | claude).
 *
 * Cada adaptador da:
 * - `bin`: el CLI que tiene que estar en el PATH;
 * - `command(ctx)`: `{ args, input }` (args = array SIN el binario; se lanza sin
 *   shell con el lanzador de launcher.mjs; input null = stdin cerrado). El
 *   modelo va pegado a su opcion (`--model=<m>`, lo admiten los cuatro CLI)
 *   para que nunca se lea como una opcion aparte;
 * - `watch(line, stream)`: motivo para abortar al ver un fallo terminal en la salida, o
 *   null (OpenCode se queda colgado cuando el proveedor falla);
 * - `parse(ctx)`: `{ reply, costUsd, failReason }` a partir de la salida.
 *
 * Seam de test: ULTRON_DELEGATE_FAKE_ENGINE (script node que sustituye al CLI;
 * recibe el prompt por stdin, corre con cwd = worktree y ve DELEGATE_ENGINE,
 * DELEGATE_RUNNER y DELEGATE_MODEL). El `watch` y el `parse` del runner se
 * aplican igual a su salida.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isSafeModel } from './config.mjs';
import { resolveLauncher } from './launcher.mjs';
import { UsageError, tail } from './proc.mjs';

export const BRIEF_FILE = '.delegate-brief.md';
const FILE_PROMPT = `Lee el fichero ${BRIEF_FILE} de este directorio y cumple sus instrucciones.`;
const CLAUDE_MAX_TURNS = 80;

/** Motivo de un fallo del proveedor a partir de un texto (sin volcarlo). */
export function classifyProviderError(text) {
  const s = String(text || '');
  if (/usage limit|insufficient balance|\b402\b|\b429\b|rate.?limit|quota/i.test(s)) return 'quota';
  if (/401 Unauthorized|Not logged in|Missing bearer|invalid api key/i.test(s)) return 'auth';
  return null;
}

/**
 * Errores de proveedor que OpenCode no arregla reintentando: el motivo sale del
 * primero que casa. `too-large`: la peticion supera el limite por minuto del
 * modelo (Groq: "Request too large", o "Limit N, Requested M" con M > N; el
 * rate limit normal lleva "Used" entre ambos y es reintentable).
 */
const OC_FATAL = Object.freeze([
  ['auth', /\b40[13]\b|Unauthorized|Forbidden|invalid.{0,10}api.?key|Missing bearer|Not logged in/i],
  ['quota', /insufficient (balance|credits|funds)|usage limit|payment required|\b402\b|key limit exceeded/i],
  ['too-large', /request too large/i],
  ['context', /context.{0,20}(length|window|limit|overflow)|maximum context|context_length_exceeded|prompt is too long/i],
]);

function tpmOverLimit(line) {
  const m = /Limit (\d+), Requested (\d+)/.exec(line);
  return Boolean(m) && Number(m[2]) > Number(m[1]);
}

/** Motivo de un error de proveedor no reintentable, o null si OpenCode puede reintentarlo. */
export function fatalOpencodeError(line) {
  const hit = OC_FATAL.find(([, re]) => re.test(line));
  if (hit) return hit[0];
  return tpmOverLimit(line) ? 'too-large' : null;
}

/**
 * Fallo FINAL de OpenCode: SOLO una linea de log de stderr (`level=ERROR`) del
 * modelo principal (`small=false`) con `message="stream error"` o
 * `AI_RetryError`, y que sea definitiva: reintentos agotados (`AI_RetryError`,
 * "Failed after N attempts") o un error no reintentable (OC_FATAL). Un "stream
 * error" reintentable (503, 429 aislado, "high demand") no aborta: OpenCode
 * reintenta solo. Nunca con `small=true` (titulo o resumen con el modelo
 * pequeno) ni con texto de stdout, que es la respuesta del modelo.
 */
export function watchOpencode(line, stream = 'stderr') {
  if (stream !== 'stderr' || !/\blevel=ERROR\b/.test(line) || !/\bsmall=false\b/.test(line)) return null;
  const exhausted = /AI_RetryError|Failed after \d+ attempts/.test(line);
  if (!exhausted && !/message="stream error"/.test(line)) return null;
  return fatalOpencodeError(line) || (exhausted ? 'retry-exhausted' : null);
}

/** JSON de una salida: entero o la ultima linea que lo sea. */
function lastJson(stdout) {
  const text = String(stdout || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const line = text.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
    try {
      return line ? JSON.parse(line) : null;
    } catch {
      return null;
    }
  }
}

/** Respuesta y fallo de `claude -p --output-format json`. */
export function parseClaude({ stdout, logFile }) {
  const j = lastJson(stdout);
  if (!j || typeof j !== 'object') return { reply: tail(logFile, 20), costUsd: null, failReason: null };
  const costUsd = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
  const reply = typeof j.result === 'string' ? j.result : '';
  const apiStatus = j.api_error_status ?? null;
  if (!j.is_error && apiStatus === null) return { reply, costUsd, failReason: null };
  const text = `${apiStatus ?? ''} ${j.subtype || ''} ${reply}`;
  const failReason = apiStatus === 429 ? 'quota' : classifyProviderError(text) || (apiStatus !== null ? `api-error ${apiStatus}` : j.subtype || 'is_error');
  return { reply, costUsd, failReason };
}

const logReply = ({ logFile }) => ({ reply: tail(logFile, 20), costUsd: null, failReason: null });

export const ADAPTERS = Object.freeze({
  codex: {
    bin: 'codex',
    command: ({ model, wt, lastFile, prompt }) => {
      // En Windows el sandbox "elevated" (el de ~/.codex/config.toml) rechaza todo
      // comando con helper_unknown_error (codex 0.162.1); el no elevado funciona.
      const winSandbox = process.platform === 'win32' ? ['-c', "windows.sandbox='unelevated'"] : [];
      return {
        args: ['exec', ...winSandbox, '-C', wt, '-s', 'workspace-write', `--model=${model}`, '--color', 'never', '-o', lastFile, '-'],
        input: prompt,
      };
    },
    watch: null,
    parse: ({ lastFile, logFile }) => {
      const last = existsSync(lastFile) ? readFileSync(lastFile, 'utf8') : '';
      return { reply: last || tail(logFile, 20), costUsd: null, failReason: null };
    },
  },
  agy: {
    bin: 'agy',
    // agy no lee el prompt de stdin: se le apunta al encargo escrito en el worktree.
    command: ({ model }) => ({
      args: [`--model=${model}`, '--mode', 'accept-edits', '--dangerously-skip-permissions', '--print-timeout', '0s', '-p', FILE_PROMPT],
      input: null,
    }),
    watch: null,
    parse: logReply,
  },
  opencode: {
    bin: 'opencode',
    // --title: sin el, OpenCode titula la sesion con un modelo pequeno de pago
    // (con la key de OpenRouter a 0 $ da "Key limit exceeded").
    command: ({ id, model, wt }) => ({
      args: ['run', '--pure', '--auto', '--print-logs', '--log-level', 'ERROR', '--title', id, `--model=${model}`, '--dir', wt, FILE_PROMPT],
      input: null,
    }),
    watch: watchOpencode,
    parse: logReply,
  },
  claude: {
    bin: 'claude',
    command: ({ model, prompt, engine }) => {
      const budget = Number(engine.maxBudgetUsd) > 0 ? ['--max-budget-usd', String(Number(engine.maxBudgetUsd))] : [];
      return {
        args: ['-p', '--safe-mode', `--model=${model}`, '--permission-mode', 'acceptEdits', '--output-format', 'json',
          '--no-session-persistence', '--max-turns', String(CLAUDE_MAX_TURNS), ...budget],
        input: prompt,
      };
    },
    watch: null,
    parse: parseClaude,
  },
});

export const adapterFor = (runner) => ADAPTERS[runner] || null;

/**
 * Comando efectivo `{ file, args, input }` (sin shell): el del adaptador con el
 * lanzador real del CLI, o el del motor falso de los tests. Un modelo con
 * caracteres fuera de la lista blanca se rechaza aqui tambien (defensa en
 * profundidad: availability.mjs ya lo da por no disponible).
 */
export function engineCommand(adapter, ctx) {
  if (!isSafeModel(ctx.model)) throw new UsageError(`modelo no valido: ${JSON.stringify(ctx.model)}`);
  const fake = process.env.ULTRON_DELEGATE_FAKE_ENGINE;
  if (fake) return { file: process.execPath, args: [fake], input: ctx.prompt };
  const launcher = resolveLauncher(adapter.bin);
  if (!launcher) throw new UsageError(`'${adapter.bin}' no se puede lanzar sin shell (no esta en el PATH o su shim .cmd no se reconoce)`);
  const { args, input } = adapter.command(ctx);
  return { file: launcher.file, args: [...launcher.prefixArgs, ...args], input };
}

export function buildPrompt(brief, check) {
  return [
    'Eres un agente delegado. Trabajas SOLO dentro de este directorio: un worktree git aislado.',
    'Reglas:',
    '- Cumple el encargo tal cual; no amplies el alcance ni refactorices lo que no se pide.',
    '- No hagas commit, push ni cambies de rama. No instales dependencias salvo que el encargo lo diga.',
    `- No modifiques ni borres ${BRIEF_FILE}.`,
    check
      ? `- Antes de terminar ejecuta la verificacion \`${check}\` y arregla lo que falle.`
      : '- El encargo no trae comando de verificacion: comprueba tu cambio como puedas.',
    '- Si no puedes cumplir algo, dilo en la respuesta final; no lo des por hecho.',
    '- Respuesta final en 15 lineas como maximo: ficheros cambiados, que verificaste y que queda pendiente.',
    '',
    '--- ENCARGO ---',
    brief,
  ].join('\n');
}
