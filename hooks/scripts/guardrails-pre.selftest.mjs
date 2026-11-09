/**
 * Selftest de guardrails-pre. Sin framework, como el resto de selftests de
 * hooks: `node guardrails-pre.selftest.mjs`, exit 1 si algo falla.
 *
 * Cubre las dos mitades que importan: que las reglas DISPAREN cuando deben y,
 * sobre todo, que NO disparen con comandos legitimos parecidos — un guardrail
 * con falsos positivos se acaba desactivando, y entonces no protege de nada.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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
// Regresión 2026-09-29: claude-code-guide lo sirve el harness sin fichero en
// disco y el guardarraíl lo denegaba como agente fantasma.
comprueba('agente integrado claude-code-guide pasa',
  decision('Agent', { subagent_type: 'claude-code-guide' }), 'pasa');

// Fixtures de plugin verificadas en disco en esta maquina (2026-09-22), una
// por cada layout que Claude Code 2.1.278 usa de verdad. Regresion: la v1
// solo miraba plugins/cache/<mercado>/<plugin>/<version>/agents, arbol que
// aqui ni siquiera contiene la mayoria de plugins instalados — el catalogo
// los marcaba a todos como inexistentes.
comprueba('agente de plugin en marketplaces/<m>/plugins/<p>/agents pasa',
  decision('Agent', { subagent_type: 'pr-review-toolkit:code-reviewer' }), 'pasa');
comprueba('agente de skills/synced/<id>/<p>/agents pasa',
  decision('Agent', { subagent_type: 'ultron:dispatcher' }), 'pasa');

// Layouts que pueden no estar instalados en la maquina (el 2026-10-03 se
// desinstalo addy-agent-skills y no queda ningun plugin sincronizado con
// agentes): se cubren con un fixture temporal en vez de depender del disco.
{
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-pre-'));
  const escribe = (rel, contenido) => {
    const destino = path.join(fixture, '.claude', 'plugins', ...rel.split('/'));
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenido);
  };
  escribe('marketplaces/addy-agent-skills/agents/code-reviewer.md', '# agente\n');
  escribe('marketplaces/addy-agent-skills/.claude-plugin/plugin.json', '{"name":"agent-skills"}');
  escribe('synced/cuenta_org/brand-voice/agents/discover-brand.md', '# agente\n');
  try {
    const cat = g.agentesValidos(fixture);
    comprueba('agente de mercado mono-plugin (nombre de plugin.json != carpeta) pasa',
      cat.has('agent-skills:code-reviewer'), true);
    comprueba('el prefijo de carpeta del mercado mono-plugin tambien pasa (se aceptan los dos)',
      cat.has('addy-agent-skills:code-reviewer'), true);
    comprueba('agente de plugins/synced/<id>/<p>/agents pasa',
      cat.has('brand-voice:discover-brand'), true);
    comprueba('agente ausente del fixture no se da por valido',
      cat.has('brand-voice:agente-que-no-existe'), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

comprueba('agente inventado se bloquea',
  decision('Agent', { subagent_type: 'plan-document-reviewer' }), 'deny/agente-fantasma');
comprueba('plugin real con nombre de agente inventado se bloquea',
  decision('Agent', { subagent_type: 'pr-review-toolkit:agente-que-no-existe' }), 'deny/agente-fantasma');
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
comprueba('here-string con comillas dobles convencional pasa',
  bash('git commit -m @"\nfix: corrige el runner\n"@'), 'pasa');

// H24 (auditoria 2026-10-17): el formato estandar de Claude Code para commits
// multilinea es `-m "$(cat <<'EOF' ... EOF\n)"`. Se leia como mensaje la
// primera linea `$(cat <<'EOF'` y se denegaba un commit convencional.
const heredocCommit = (msg, abre = "<<'EOF'") =>
  `git commit -m "$(cat ${abre}\n${msg}\nEOF\n)"`;
comprueba('commit con heredoc en $(cat) convencional pasa',
  bash(heredocCommit('feat(hooks): cubre PowerShell\n\nCuerpo del mensaje.\n\nCo-Authored-By: X <x@example.com>')), 'pasa');
comprueba('commit con heredoc sin comillas en el delimitador pasa',
  bash(heredocCommit('fix: algo', '<<EOF')), 'pasa');
comprueba('commit con heredoc <<-"EOF" pasa',
  bash(heredocCommit('docs: algo', '<<-"EOF"')), 'pasa');
comprueba('commit con heredoc en $(cat) sin tipo se bloquea',
  bash(heredocCommit('arreglado el runner\n\nCuerpo.')), 'deny/commit-format');
comprueba('git add && commit con heredoc convencional pasa',
  bash(`git add a.js && ${heredocCommit('test: caso nuevo')}`), 'pasa');
comprueba('mensajeCommit extrae la primera linea del heredoc',
  (g.mensajeCommit(heredocCommit('chore: x\n\ncuerpo')) || '').split('\n')[0], 'chore: x');
// Una sustitucion que no se puede leer (mensaje en fichero) no se bloquea.
comprueba('commit con $(cat fichero) no legible pasa',
  bash('git commit -m "$(cat mensaje.txt)"'), 'pasa');
// Revision de H24: el asunto es el PRIMER -m tras `git commit`. El arreglo
// inicial leia el heredoc del segundo -m (cuerpo) y denegaba un commit valido.
comprueba('asunto convencional en -m y cuerpo en heredoc pasa',
  bash(`git commit -m "feat: algo" -m "$(cat <<'EOF'\ncuerpo sin tipo\nEOF\n)"`), 'pasa');
comprueba('asunto sin tipo y cuerpo en heredoc se bloquea',
  bash(`git commit -m "arreglado" -m "$(cat <<'EOF'\nfeat: cuerpo\nEOF\n)"`), 'deny/commit-format');
comprueba('el -m de python -m antes del commit no es el mensaje',
  bash('uv run python -m pytest && git commit -m "test: casos nuevos"'), 'pasa');
comprueba('mensaje en variable no legible pasa',
  bash('git commit -q -m "$msg$T"'), 'pasa');
comprueba('heredoc con linea en blanco inicial convencional pasa',
  bash(heredocCommit('\nfix: algo')), 'pasa');
comprueba('PowerShell: operador -f y git push sin forzar pasa',
  decision('PowerShell', { command: '"{0}" -f 1; git push' }), 'pasa');
comprueba('PowerShell: git push -f sigue pidiendo confirmacion',
  decision('PowerShell', { command: 'git push -f origin main' }), 'ask/force-push');

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

// H25 (auditoria 2026-10-17): en PowerShell el binario se invoca con el
// operador de llamada `&` y a menudo por ruta entre comillas.
const ps = (command) => decision('PowerShell', { command });
comprueba('PowerShell: claude con la bandera se bloquea',
  ps('claude --dangerously-skip-permissions'), 'deny/skip-permissions');
comprueba('PowerShell: & claude con la bandera se bloquea',
  ps('& claude --dangerously-skip-permissions -p "hola"'), 'deny/skip-permissions');
comprueba('PowerShell: & "ruta\\claude.exe" con la bandera se bloquea',
  ps('& "C:\\Program Files\\Claude\\claude.exe" --dangerously-skip-permissions'), 'deny/skip-permissions');
comprueba('PowerShell: ruta sin comillas a claude.exe se bloquea',
  ps('C:\\tools\\claude.exe --dangerously-skip-permissions'), 'deny/skip-permissions');
comprueba('PowerShell: & claude sin la bandera pasa',
  ps('& claude --version'), 'pasa');
comprueba('PowerShell: otro binario que nombra la bandera pasa',
  ps('& "C:\\x\\rg.exe" -- --dangerously-skip-permissions docs'), 'pasa');
comprueba('PowerShell: & python sin uv se bloquea', ps('& python script.py'), 'deny/uv');
comprueba('PowerShell: commit sin tipo se bloquea',
  ps('git commit -m "arreglado"'), 'deny/commit-format');
comprueba('PowerShell: commit convencional pasa',
  ps("git commit -m @'\nfeat: algo\n'@"), 'pasa');

// Paridad tool <-> matcher (H25): cada herramienta que el clasificador trata
// tiene que estar en el matcher del hook en la plantilla versionada; si no,
// el codigo existe pero el hook no se ejecuta nunca para esa herramienta.
{
  const plantilla = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'settings-hooks.json');
  const cfg = JSON.parse(fs.readFileSync(plantilla, 'utf8'));
  const entradas = (cfg.hooks?.PreToolUse || cfg.PreToolUse || [])
    .filter((m) => (m.hooks || []).some((h) => String(h.command || '').includes('guardrails-pre.js')));
  comprueba('plantilla: guardrails-pre registrado en PreToolUse', entradas.length, 1);
  const matcher = new Set(String(entradas[0]?.matcher || '').split('|'));
  for (const tool of g.TOOLS_CUBIERTAS) {
    comprueba(`plantilla: el matcher de guardrails-pre incluye ${tool}`, matcher.has(tool), true);
  }
  // Auditoria 2026-11-01: la lista se contrasta con los tipos del motor; si no,
  // una herramienta de shell nueva (Monitor) queda fuera sin que nada lo avise.
  const { herramientasShellDelMotor } = require('./lib/motor-shell-tools.js');
  for (const tool of herramientasShellDelMotor()) {
    comprueba(`tipos: TOOLS_CUBIERTAS incluye ${tool}`, g.TOOLS_CUBIERTAS.includes(tool), true);
  }
}

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

// --- variantes triviales (hooks-3, auditoria 2026-10-23) ----------------------
// Hasta esta version solo se detectaba la forma canonica de cada regla: un
// envoltorio de shell, una opcion global de git o una bandera equivalente
// bastaban para saltarla.
comprueba('permission-mode bypassPermissions se bloquea',
  bash('claude --permission-mode bypassPermissions -p "x"'), 'deny/skip-permissions');
comprueba('permission-mode=bypassPermissions se bloquea',
  bash('claude --permission-mode=bypassPermissions'), 'deny/skip-permissions');
comprueba('allow-dangerously-skip-permissions se bloquea',
  bash('claude --allow-dangerously-skip-permissions'), 'deny/skip-permissions');
comprueba('bash -c con la bandera se bloquea',
  bash('bash -c "claude --dangerously-skip-permissions -p hola"'), 'deny/skip-permissions');
comprueba('sh -c con comillas simples se bloquea',
  bash("sh -c 'claude --dangerously-skip-permissions'"), 'deny/skip-permissions');
comprueba('pwsh -c con la bandera se bloquea',
  ps('pwsh -NoProfile -c "claude --dangerously-skip-permissions"'), 'deny/skip-permissions');
comprueba('powershell -Command con la bandera se bloquea',
  ps('powershell.exe -Command "& claude --dangerously-skip-permissions"'), 'deny/skip-permissions');
comprueba('cmd /c con la bandera se bloquea',
  ps('cmd /c claude --dangerously-skip-permissions'), 'deny/skip-permissions');
{
  const enc = Buffer.from('claude --dangerously-skip-permissions', 'utf16le').toString('base64');
  comprueba('powershell -EncodedCommand con la bandera se bloquea',
    ps(`powershell -EncodedCommand ${enc}`), 'deny/skip-permissions');
}
comprueba('bash -c con un comando inocuo pasa', bash('bash -c "echo hola"'), 'pasa');
comprueba('permission-mode plan pasa', bash('claude --permission-mode plan -p "x"'), 'pasa');
comprueba('git -C <ruta> commit sin tipo se bloquea',
  bash('git -C /tmp/repo commit -m "arreglado"'), 'deny/commit-format');
comprueba('git -C "<ruta con espacios>" commit sin tipo se bloquea',
  bash('git -C "C:\\Mis cosas\\repo" commit -m "arreglado"'), 'deny/commit-format');
comprueba('git -c k=v commit sin tipo se bloquea',
  bash('git -c user.name=x commit -m "arreglado"'), 'deny/commit-format');
comprueba('git --no-pager commit sin tipo se bloquea',
  bash('git --no-pager commit -m "arreglado"'), 'deny/commit-format');
comprueba('git -C <ruta> commit convencional pasa',
  bash('git -C /tmp/repo commit -m "fix: algo"'), 'pasa');
comprueba('bash -c con commit sin tipo se bloquea',
  bash('bash -c \'git commit -m "arreglado"\''), 'deny/commit-format');
comprueba('git -C <ruta> push --force pide confirmacion',
  bash('git -C /tmp/repo push --force origin main'), 'ask/force-push');
comprueba('refspec +rama pide confirmacion', bash('git push origin +main'), 'ask/force-push');
comprueba('refspec +a:b pide confirmacion', bash('git push origin +HEAD:main'), 'ask/force-push');
comprueba('push --force-if-includes pide confirmacion',
  bash('git push --force-if-includes origin main'), 'ask/force-push');
comprueba('push -uf combinado pide confirmacion', bash('git push -uf origin main'), 'ask/force-push');
comprueba('push --mirror pide confirmacion', bash('git push --mirror origin'), 'ask/force-push');
comprueba('push --follow-tags pasa', bash('git push --follow-tags origin main'), 'pasa');
comprueba('push -o con opcion pasa', bash('git push -o ci.skip origin main'), 'pasa');
comprueba('git log --format de un +main no es un push', bash('git log +main..x'), 'pasa');

// --- separadores dentro de comillas (M3) -------------------------------------
comprueba('alternancia con py entre comillas pasa',
  bash("grep -oE '[a-z]+\\.(mjs|js|py|ps1)' docs/x.md"), 'pasa');
comprueba('punto y coma entre comillas pasa', bash("echo 'a; python x.py'"), 'pasa');
comprueba('salto de linea dentro de -m pasa',
  bash('git commit -m "fix: runner\n\npython x.py ya no se usa"'), 'pasa');
comprueba('separador real tras comillas cerradas se bloquea',
  bash('echo "ok"; python x.py'), 'deny/uv');
comprueba('comilla descompensada cae al split ingenuo y se bloquea',
  bash("echo it's; python x.py"), 'deny/uv');
comprueba('bash -c con separador dentro se sigue viendo',
  bash('bash -c "cd /tmp; python x.py"'), 'deny/uv');
comprueba('tuberia real tras alternancia entre comillas se bloquea',
  bash("grep -oE '(js|py)' f | python"), 'deny/uv');

// --- sustituciones, comentarios y escape por dialecto (revision 2026-10-26) --
// Casos negativos: con el troceo anterior (comillas sin sustituciones, `#` sin
// tratar y `\` como escape en PowerShell) todos pasaban.
const bypass = [
  ['sustitucion $() dentro de comillas dobles',
    bash('x="$(true; claude --dangerously-skip-permissions -p hi)"'), 'deny/skip-permissions'],
  ['sustitucion $() sin separador', bash('"$(claude --dangerously-skip-permissions)"'), 'deny/skip-permissions'],
  ['$() con cd y python dentro de comillas', bash('echo "$(cd /tmp; python x.py)"'), 'deny/uv'],
  ['backticks dentro de comillas dobles', bash('echo "`a; python x.py`"'), 'deny/uv'],
  ['sustitucion de proceso <()', bash('diff <(python x.py) b'), 'deny/uv'],
  ['$() sin cerrar cae al split ingenuo', bash('echo "$(python x.py"'), 'deny/uv'],
  ['case dentro de $() cae al split ingenuo', bash('echo "$(case x in a) true;; esac; python x.py)"'), 'deny/uv'],
  ['apostrofos en comentarios no abren comilla',
    bash("# don't touch\npython x.py\n# won't run twice"), 'deny/uv'],
  ['apostrofos en comentarios alrededor de claude',
    bash("# it's a test\nclaude --dangerously-skip-permissions -p hi\n# that's all"), 'deny/skip-permissions'],
  ['here-doc sin terminador (<< entre comillas) no oculta lineas', bash("echo '<<X'\npython x.py"), 'deny/uv'],
  ['& de segundo plano separa', bash('sleep 1 & python x.py'), 'deny/uv'],
  ['asignacion de entorno delante', bash('FOO=1 python x.py'), 'deny/uv'],
  ['PowerShell: \\ no escapa la comilla', ps('cd "C:\\tmp\\" ; python x.py ; echo "b\\"'), 'deny/uv'],
  ['PowerShell: \\ no escapa la comilla (claude)',
    ps('cd "C:\\tmp\\" ; claude --dangerously-skip-permissions ; echo "b\\"'), 'deny/skip-permissions'],
  ['PowerShell: subexpresion $() dentro de comillas', ps('Write-Host "$(python x.py)"'), 'deny/uv'],
  ['PowerShell: comentario de bloque con apostrofo', ps("<# it's\n#> python x.py"), 'deny/uv'],
];
for (const [nombre, real, esperado] of bypass) comprueba(nombre, real, esperado);
const legitimos = [
  ['$() entre comillas simples es texto', bash("echo '$(python x.py)'")],
  ['# en mitad de palabra no es comentario', bash('echo "a#b; python x.py"')],
  ['lo que va tras # es comentario', bash('echo x # ; python x.py')],
  ['commit con $(cat <<EOF) pasa',
    bash("git commit -m \"$(cat <<'EOF'\nfeat: x\n\npython x.py ya no\nEOF\n)\"")],
  ['PowerShell: ; dentro de comillas pasa', ps('Write-Host "uso: a; python x.py"')],
  ['PowerShell: backtick escapa dentro de comillas', ps('Write-Host "tab`there; python x.py"')],
  ['PowerShell: ruta con \\ final y git pasa', ps('cd "C:\\tmp\\"; git status')],
];
for (const [nombre, real] of legitimos) comprueba(nombre, real, 'pasa');

// --- fail-closed (segunda ronda 2026-10-26) ----------------------------------
// Casos negativos: con el troceo de la primera ronda todos pasaban, y HEAD
// (cf5d94a3, split ingenuo) los bloqueaba. Ahora cuentan como duda y se
// aplica ademas el split de HEAD.
const hondo = (n, dentro) => `x=${'$('.repeat(n)}${dentro}${')'.repeat(n)}`;
const failClosed = [
  ["ANSI-C $'\\'' (python)", bash("echo $'\\'' ; python x.py ; echo \\'"), 'deny/uv'],
  ["ANSI-C $'\\'' (claude)",
    bash("echo $'\\'' ; claude --dangerously-skip-permissions ; echo \\'"), 'deny/skip-permissions'],
  ['PowerShell: comillas tipograficas dobles', ps('echo "a” ; python x.py ; echo “b"'), 'deny/uv'],
  ['PowerShell: comillas tipograficas (claude)',
    ps('echo "a” ; claude --dangerously-skip-permissions ; echo “b"'), 'deny/skip-permissions'],
  ['PowerShell: comillas tipograficas simples', ps("echo 'a’ ; python x.py ; echo ‘b'"), 'deny/uv'],
  ['mas de 32 $( anidados (python)', bash(hondo(40, 'python x.py')), 'deny/uv'],
  ['mas de 32 $( anidados (claude)',
    bash(hondo(40, 'claude --dangerously-skip-permissions')), 'deny/skip-permissions'],
  ['PowerShell: --% y | tras comillas', ps('cmd --% "" " | python x.py "'), 'deny/uv'],
  ['cmd /c: la comilla simple no protege el &', ps("cmd /c echo 'a & python x.py'"), 'deny/uv'],
  ['<< entre comillas con terminador no es here-doc', bash("echo '<<X'\npython x.py\nX"), 'deny/uv'],
  ['<< en un comentario no es here-doc', bash('# ver <<X\npython x.py\nX'), 'deny/uv'],
  ['<<< here-string no es here-doc', bash('cat <<<EOF\npython x.py\nEOF'), 'deny/uv'],
  ['<< aritmetico no es here-doc', bash('(( a = 1 << b ))\npython x.py\nb'), 'deny/uv'],
  ['\\<< escapado no es here-doc', bash('echo \\<<X\npython x.py\nX'), 'deny/uv'],
  ["@' en bash no es here-string", bash("echo @'\nit's\npython x.py\n'@"), 'deny/uv'],
  ["@' que cierra una cadena no es here-string", bash("echo 'a@'\npython x.py\n'@\n'"), 'deny/uv'],
];
for (const [nombre, real, esperado] of failClosed) comprueba(nombre, real, esperado);
comprueba('anidacion bajo el tope sigue troceando', bash(hondo(31, 'python x.py')), 'deny/uv');
comprueba('alternancia entre comillas dobles pasa (caso seguro)', bash('grep -E "(mjs|js|py)" f'), 'pasa');

// Regresion contra HEAD (cf5d94a3): todo comando de shell que su selftest
// esperaba denegar (o confirmar) sigue igual. Extraido ejecutando ese selftest.
const T = { B: 'Bash', P: 'PowerShell' };
const HC = (m) => `git commit -m "$(cat <<'EOF'\n${m}\nEOF\n)"`;
const enc = Buffer.from('claude --dangerously-skip-permissions', 'utf16le').toString('base64');
const UV = 'deny/uv', CF = 'deny/commit-format', SK = 'deny/skip-permissions', FP = 'ask/force-push';
const regresionHead = [
  ['B', 'python analiza.py', UV], ['B', 'python -m pytest', UV], ['B', 'pip install httpx', UV],
  ['B', 'cd /tmp && python x.py', UV], ['B', 'git commit -m "arreglado el juez"', CF],
  ['B', "git commit -m @'\nretira INDEX.json\n'@", CF], ['B', HC('arreglado el runner\n\nCuerpo.'), CF],
  ['B', `git commit -m "arreglado" -m "$(cat <<'EOF'\nfeat: cuerpo\nEOF\n)"`, CF],
  ['P', 'git push -f origin main', FP], ['B', 'claude --dangerously-skip-permissions', SK],
  ['B', 'npx claude --dangerously-skip-permissions -p "hola"', SK],
  ['P', 'claude --dangerously-skip-permissions', SK],
  ['P', '& claude --dangerously-skip-permissions -p "hola"', SK],
  ['P', '& "C:\\Program Files\\Claude\\claude.exe" --dangerously-skip-permissions', SK],
  ['P', 'C:\\tools\\claude.exe --dangerously-skip-permissions', SK], ['P', '& python script.py', UV],
  ['P', 'git commit -m "arreglado"', CF], ['B', "python - <<'PY'\nprint(1)\nPY", UV],
  ['B', 'git push --force origin main', FP], ['B', 'git push -f', FP],
  ['B', 'claude --permission-mode bypassPermissions -p "x"', SK],
  ['B', 'claude --permission-mode=bypassPermissions', SK], ['B', 'claude --allow-dangerously-skip-permissions', SK],
  ['B', 'bash -c "claude --dangerously-skip-permissions -p hola"', SK],
  ['B', "sh -c 'claude --dangerously-skip-permissions'", SK],
  ['P', 'pwsh -NoProfile -c "claude --dangerously-skip-permissions"', SK],
  ['P', 'powershell.exe -Command "& claude --dangerously-skip-permissions"', SK],
  ['P', 'cmd /c claude --dangerously-skip-permissions', SK], ['P', `powershell -EncodedCommand ${enc}`, SK],
  ['B', 'git -C /tmp/repo commit -m "arreglado"', CF], ['B', 'git -C "C:\\Mis cosas\\repo" commit -m "arreglado"', CF],
  ['B', 'git -c user.name=x commit -m "arreglado"', CF], ['B', 'git --no-pager commit -m "arreglado"', CF],
  ['B', 'bash -c \'git commit -m "arreglado"\'', CF], ['B', 'git -C /tmp/repo push --force origin main', FP],
  ['B', 'git push origin +main', FP], ['B', 'git push origin +HEAD:main', FP],
  ['B', 'git push --force-if-includes origin main', FP], ['B', 'git push -uf origin main', FP],
  ['B', 'git push --mirror origin', FP],
];
comprueba('regresion HEAD: 40 casos', regresionHead.length, 40);
for (const [t, command, esperado] of regresionHead) {
  comprueba(`regresion HEAD: ${JSON.stringify(command).slice(0, 60)}`, decision(T[t], { command }), esperado);
}

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
