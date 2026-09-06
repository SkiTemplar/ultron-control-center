/**
 * Selftest de guardrails-pre. Sin framework, como el resto de selftests de
 * hooks: `node guardrails-pre.selftest.mjs`, exit 1 si algo falla.
 *
 * Cubre las dos mitades que importan: que las reglas DISPAREN cuando deben y,
 * sobre todo, que NO disparen con comandos legitimos parecidos — un guardrail
 * con falsos positivos se acaba desactivando, y entonces no protege de nada.
 */
import { createRequire } from 'node:module';
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

// --- agente fantasma ---------------------------------------------------------
const catalogo = g.agentesValidos();
comprueba('el catalogo de agentes se lee del disco', catalogo.size >= 20, true);
comprueba('agente real pasa', decision('Agent', { subagent_type: 'code-reviewer' }), 'pasa');
comprueba('agente de plugin con prefijo pasa',
  decision('Agent', { subagent_type: 'superpowers:code-reviewer' }), 'pasa');
comprueba('agente inventado se bloquea',
  decision('Agent', { subagent_type: 'plan-document-reviewer' }), 'deny/agente-fantasma');
comprueba('Agent sin subagent_type pasa', decision('Agent', {}), 'pasa');

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
comprueba('push normal pasa', bash('git push -u origin main'), 'pasa');
comprueba('push forzado pide confirmacion', bash('git push --force origin main'), 'ask/force-push');
comprueba('push -f pide confirmacion', bash('git push -f'), 'ask/force-push');

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

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
