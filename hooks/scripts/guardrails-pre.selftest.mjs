/**
 * Selftest de guardrails-pre. Sin framework, como el resto de selftests de
 * hooks: `node guardrails-pre.selftest.mjs`, exit 1 si algo falla.
 *
 * Cubre las dos mitades que importan: que las reglas DISPAREN cuando deben y,
 * sobre todo, que NO disparen con comandos legitimos parecidos — un guardrail
 * con falsos positivos se acaba desactivando, y entonces no protege de nada.
 *
 * HERMETICO desde 2026-09-22 (antes quedaba fuera de CI): el catalogo de
 * agentes se leia del disco REAL (~/.claude/agents + la cache de plugins), asi
 * que en un runner limpio fallaba por ENTORNO y no por regresion — y en la
 * maquina del mantenedor fallaba igual en cuanto un plugin no estaba instalado
 * ("superpowers:code-reviewer"). Ahora se monta un HOME de pruebas con 24
 * agentes y un plugin de mentira, se apunta USERPROFILE/HOME ahi ANTES de
 * cargar el hook (el modulo resuelve os.homedir() al cargarse) y el catalogo
 * es siempre el mismo en cualquier maquina.
 */
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- HOME de pruebas (antes de require: el hook fija HOME al cargarse) -------
const HOME = mkdtempSync(join(tmpdir(), 'guardrails-pre-'));
const AGENTS = join(HOME, '.claude', 'agents');
mkdirSync(AGENTS, { recursive: true });
// 24 agentes > MIN_CATALOGO (20): por debajo la regla se desactiva a proposito
// (fail-open) y el caso negativo de agente fantasma no probaria nada.
const AGENTES = [
  'code-reviewer', 'debugger', 'senior-engineer', 'ui-designer', 'refactoring-specialist',
  'rust-engineer', 'typescript-engineer', 'python-engineer', 'test-writer', 'doc-writer',
  'security-auditor', 'perf-analyst', 'data-modeler', 'api-designer', 'devops',
  'release-manager', 'memory-curator', 'routing-tuner', 'hook-author', 'installer',
  'voice-engineer', 'kanban-keeper', 'research-assistant', 'changelog-writer',
];
for (const a of AGENTES) writeFileSync(join(AGENTS, `${a}.md`), `# ${a}\n`);
writeFileSync(join(AGENTS, 'README.md'), 'no es un agente\n');
// Agente de plugin: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/agents/*.md
const PLUGIN = join(HOME, '.claude', 'plugins', 'cache', 'mercado', 'superpowers', '1.0.0', 'agents');
mkdirSync(PLUGIN, { recursive: true });
writeFileSync(join(PLUGIN, 'code-reviewer.md'), '# code-reviewer\n');

process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// Estado de partida: las DENY de Bash APAGADAS, que es como se instala.
delete process.env.ULTRON_GUARDRAILS_BASH;

const require = createRequire(import.meta.url);
const g = require('./guardrails-pre.js');

let fallos = 0;
function comprueba(nombre, real, esperado) {
  const ok = real === esperado;
  if (!ok) {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${esperado} real=${real}`);
  } else {
    console.log(`ok     ${nombre}`);
  }
}

const decision = (tool, input) => {
  const v = g.classify(tool, input);
  return v ? `${v.decision}/${v.regla}` : 'pasa';
};
const bash = (command) => decision('Bash', { command });

// --- agente fantasma (siempre activo) ----------------------------------------
const catalogo = g.agentesValidos();
comprueba('el catalogo de agentes se lee del disco', catalogo.size >= 20, true);
comprueba('agente real pasa', decision('Agent', { subagent_type: 'code-reviewer' }), 'pasa');
comprueba('agente de plugin con prefijo pasa',
  decision('Agent', { subagent_type: 'superpowers:code-reviewer' }), 'pasa');
comprueba('agente inventado se bloquea',
  decision('Agent', { subagent_type: 'plan-document-reviewer' }), 'deny/agente-fantasma');
comprueba('Agent sin subagent_type pasa', decision('Agent', {}), 'pasa');

// --- force-push: ASK, siempre activo -----------------------------------------
comprueba('push normal pasa', bash('git push -u origin main'), 'pasa');
comprueba('push forzado pide confirmacion', bash('git push --force origin main'), 'ask/force-push');
comprueba('push -f pide confirmacion', bash('git push -f'), 'ask/force-push');

// --- CASO NEGATIVO: con el flag apagado, NINGUNA DENY de Bash dispara --------
// Es la mitad nueva del contrato (2026-09-22). Si alguien reactiva las reglas
// por descuido, estas cuatro lineas se ponen rojas.
comprueba('flag apagado por defecto', g.reglasBashActivas(), false);
comprueba('[apagado] python suelto PASA', bash('python analiza.py'), 'pasa');
comprueba('[apagado] pip install PASA', bash('pip install httpx'), 'pasa');
comprueba('[apagado] commit sin tipo PASA', bash('git commit -m "arreglado el juez"'), 'pasa');
comprueba('[apagado] skip-permissions PASA', bash('claude --dangerously-skip-permissions'), 'pasa');
comprueba('[apagado] el hook no emite decision',
  g.handle(JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pip install x' },
  })),
  null);

// --- de aqui abajo, con las reglas de Bash ENCENDIDAS ------------------------
process.env.ULTRON_GUARDRAILS_BASH = '1';
comprueba('flag encendido se lee en caliente', g.reglasBashActivas(), true);

// --- UV ----------------------------------------------------------------------
comprueba('uv run pasa', bash('uv run python analiza.py'), 'pasa');
comprueba('uv pip install pasa', bash('uv pip install httpx'), 'pasa');
comprueba('python suelto se bloquea', bash('python analiza.py'), 'deny/uv');
comprueba('python -m se bloquea', bash('python -m pytest'), 'deny/uv');
comprueba('pip install se bloquea', bash('pip install httpx'), 'deny/uv');
comprueba('python encadenado se bloquea', bash('cd /tmp && python x.py'), 'deny/uv');
comprueba('grep de la palabra python pasa', bash('grep -rn python src/'), 'pasa');
comprueba('fichero llamado python.md pasa', bash('cat docs/python.md'), 'pasa');

// --- formato de commit -------------------------------------------------------
comprueba('commit convencional pasa', bash('git commit -m "feat: enruta por LLM"'), 'pasa');
comprueba('commit con scope pasa', bash('git commit -m "fix(routing): timeout del juez"'), 'pasa');
comprueba('commit sin tipo se bloquea', bash('git commit -m "arreglado el juez"'), 'deny/commit-format');
comprueba('amend sin mensaje pasa', bash('git commit --amend --no-edit'), 'pasa');
comprueba('commit -F pasa', bash('git commit -F mensaje.txt'), 'pasa');
comprueba('here-string convencional pasa',
  bash("git commit -m @'\nchore: retira INDEX.json\n\nCuerpo del mensaje.\n'@"), 'pasa');
comprueba('here-string sin tipo se bloquea',
  bash("git commit -m @'\nretira INDEX.json\n'@"), 'deny/commit-format');

// --- permisos e historia -----------------------------------------------------
comprueba('skip-permissions se bloquea',
  bash('claude --dangerously-skip-permissions'), 'deny/skip-permissions');
comprueba('npx claude con la bandera se bloquea',
  bash('npx claude --dangerously-skip-permissions -p "hola"'), 'deny/skip-permissions');
// Regresion: la v1 bloqueaba cualquier comando que NOMBRARA la bandera, asi que
// no se podia ni documentar la norma que la prohibe.
comprueba('nombrar la bandera en un comentario pasa',
  bash('node -e "console.log(1)" # --dangerously-skip-permissions'), 'pasa');
comprueba('grep de la bandera pasa',
  bash('grep -rn -- --dangerously-skip-permissions docs/'), 'pasa');

// --- here-docs: el cuerpo son datos, no comandos -----------------------------
// Regresion: el terminador `PY` de un heredoc se leia como el launcher `py` y
// bloqueaba el propio comando que SI cumplia la norma.
comprueba('heredoc con uv run pasa',
  bash("uv run python - <<'PY'\nimport io\nprint('hola')\nPY"), 'pasa');
comprueba('heredoc sin uv se bloquea igual',
  bash("python - <<'PY'\nprint(1)\nPY"), 'deny/uv');
comprueba('commit que cita python en el cuerpo pasa',
  bash("git commit -m @'\nfix: arregla el runner\n\nAntes se llamaba con python script.py y ahora con uv run.\n'@"), 'pasa');

// --- contrato del hook -------------------------------------------------------
comprueba('evento que no es PreToolUse se ignora',
  g.handle(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'pip install x' } })),
  null);
comprueba('json invalido no rompe', g.handle('{no es json'), null);
const salida = JSON.parse(g.handle(JSON.stringify({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pip install x' },
})));
comprueba('la salida trae permissionDecision',
  salida.hookSpecificOutput.permissionDecision, 'deny');

try {
  rmSync(HOME, { recursive: true, force: true });
} catch (_) {
  /* limpieza best-effort */
}

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
