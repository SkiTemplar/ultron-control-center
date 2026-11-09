#!/usr/bin/env node
/**
 * delegate.mjs - delega una tarea cerrada en un motor de la cadena. Opus redacta
 * el encargo exacto; el motor lo ejecuta en un worktree git aislado y el resultado
 * queda en una rama `delegate/<id>` que Opus revisa y fusiona (o descarta). El
 * delegador no toca el arbol de trabajo del repo; un motor sin sandbox podria.
 *
 * Coste: el primer motor de la cadena vigente es `claude-p`, que gasta LA MISMA
 * cuota del plan que la sesion principal; el segundo, `anthropic-api`, creditos de
 * pago. Delegar ahorra contexto de la sesion, no cuota (docs/delegacion-contrato.md).
 *
 * Uso:
 *   node scripts/delegate.mjs run --brief <fichero.md> (--check "<comando>" | --no-check)
 *        [--engine auto|<id>] [--tier complex|standard|trivial] [--no-relay]
 *        [--scope "<glob>[,<glob>]"] [--model <id> (solo con --engine <id>)]
 *        [--repo <dir>] [--base <ref>] [--link <ruta-relativa>]... [--timeout <s>] [--force]
 *   node scripts/delegate.mjs status [--json]
 *   node scripts/delegate.mjs list
 *   node scripts/delegate.mjs merge <id> [--branch <rama>]
 *   node scripts/delegate.mjs clean <id>
 *   node scripts/delegate.mjs gc [--days N] [--dry-run]
 *
 * Motores: cockpit/ai-router/delegation.json (la del usuario, ignorada por git);
 * si falta o no parsea se usa cockpit/ai-router/delegation.default.json
 * (versionado) y la salida lo dice. Contrato: docs/delegacion-contrato.md.
 * Runners: codex, agy, opencode y claude (adaptadores en lib/delegate/adapters.mjs),
 * lanzados SIN shell y con el entorno sin keys ajenas (lib/delegate/env.mjs).
 *
 * `run` con `--engine auto` (por defecto) empieza en `tiers[tier].start` y
 * recorre la cadena dando la vuelta: salta el motor deshabilitado, sin CLI, sin
 * key o con cuota >= 95 %; si falla, agota el plazo o no cambia nada, pasa al
 * siguiente con un worktree nuevo; si el check sale rojo, tambien (con
 * `relayOnCheckFail`). Cada intento va al ledger cockpit/delegations.jsonl.
 * El plazo mata el arbol de procesos entero (taskkill /T /F en Windows) y, en
 * Windows, los descendientes que sobreviven a un motor que sale bien se matan
 * al terminar (lib/delegate/proc.mjs, reapOrphans). Si el checkout principal
 * cambia durante el intento, se marca `isolation-suspect` y el check cuenta; si
 * hay evidencia de que fue el motor o cambia la config de git, es engine-fail con
 * motivo `isolation` y el relevo se corta (isolation.mjs). `--link` es de solo
 * lectura por contrato. Un check que cambia lo que valida da `tree-changed`.
 *
 * `merge` exige la rama en el SHA validado, arbol limpio y base ancestro de HEAD,
 * deja el squash sin commit y registra `squash-prepared`; `merged` llega con el
 * commit (squash.mjs).
 *
 * Salida: 0 = cambios y check verde; 1 = check rojo sin relevo posterior;
 * 2 = ningun motor completo la tarea (vuelve a Opus); 3 = error de uso, cuota
 * de un motor forzado o git.
 *
 * Lanzarlo en segundo plano desde Claude Code: un motor puede tardar mas que el
 * tope de 10 min de una llamada a Bash en primer plano.
 *
 * Seams de test: ULTRON_DELEGATE_DIR, ULTRON_DELEGATE_FAKE_ENGINE,
 * ULTRON_DELEGATE_USAGE, ULTRON_DELEGATE_CONFIG, ULTRON_DELEGATE_DEFAULT_CONFIG, ULTRON_DELEGATE_LEDGER,
 * ULTRON_DELEGATE_BALANCE y ULTRON_DELEGATE_NO_REGISTRY (ver lib/delegate/*).
 */

import { cmdClean, cmdGc, cmdList, cmdMerge, cmdStatus } from './lib/delegate/manage.mjs';
import { UsageError } from './lib/delegate/proc.mjs';
import { cmdRun } from './lib/delegate/run.mjs';

const BOOLEAN_FLAGS = new Set(['force', 'no-check', 'no-relay', 'json', 'dry-run']);
const VALUE_FLAGS = new Set(['engine', 'tier', 'brief', 'check', 'model', 'repo', 'base', 'link', 'timeout', 'scope', 'branch', 'days']);

export function parseArgs(argv) {
  const opts = { _: [], link: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      opts[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new UsageError(`opcion desconocida: --${key}`);
    const val = argv[++i];
    if (val === undefined) throw new UsageError(`falta el valor de --${key}`);
    if (key === 'link') opts.link.push(val);
    else opts[key] = val;
  }
  return opts;
}

async function main(argv) {
  const [sub, ...rest] = argv;
  const opts = parseArgs(rest);
  if (sub === 'run') return cmdRun(opts);
  if (sub === 'status') return cmdStatus(opts);
  if (sub === 'list') return cmdList();
  if (sub === 'merge') return cmdMerge(opts._[0], opts);
  if (sub === 'clean') return cmdClean(opts._[0]);
  if (sub === 'gc') return cmdGc(opts);
  throw new UsageError('uso: delegate.mjs run|status|list|merge|clean|gc (ver la cabecera del script)');
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`delegate: ${e instanceof UsageError ? e.message : e.stack || e.message}`);
  process.exitCode = 3;
}
