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
 *   skip-permissions (Bash)   DENY  --dangerously-skip-permissions y equivalentes
 *                                   (--permission-mode bypassPermissions,
 *                                   --allow-dangerously-skip-permissions).
 *   force-push       (Bash)   ASK   push forzado (rescribe historia publicada):
 *                                   --force*, --mirror, -f y refspec `+rama`.
 *
 * Normalizacion (hooks-3, 2026-10-23; auditoria 2026-11-01): las reglas se
 * aplican a la linea y a cada comando que lanza a traves de otra shell (`bash -c`,
 * `pwsh -Command`, `-EncodedCommand`, `cmd /c`, `echo … | bash`, `bash <<EOF`,
 * `eval "…"`), sobre el binario real de cada comando (por ruta, tras `timeout`,
 * `then`, `Start-Process`, `find -exec`…) y con las banderas sin comillas.
 *
 * LIMITES DECLARADOS (falsos negativos conocidos, fijados como tales en
 * guardrails-pre.adversarial.selftest.mjs): no evalua la shell (`eval "$x"`,
 * `$cmd x.py`, `$(echo python) x.py`, `iex $x`), un escape dentro del nombre del
 * binario (`pyt\hon`), codigo dentro de otro interprete (`node -e "execSync(…)"`,
 * `base64 -d | bash`, un script escrito antes), envoltorios fuera de PREFIJOS de
 * lib/shell-wrappers.js (`parallel`, `fd -x`, `poetry run`, `ssh h git push -f`) y
 * alias de git (`git ci`). Es higiene determinista, no una frontera de seguridad.
 *
 * Las reglas de Bash valen igual para PowerShell y Monitor. Hasta el 2026-10-17 el
 * codigo trataba PowerShell pero el matcher vivo era `Bash|Agent|Task`, asi
 * que en la shell principal de Windows ninguna se ejecutaba (H25 de la
 * auditoria). TOOLS_CUBIERTAS es la lista que el selftest contrasta con el
 * matcher de la plantilla para que no vuelvan a divergir.
 *
 * POR QUE agente-fantasma BLOQUEA Y NO AVISA: un `subagent_type` inexistente
 * no da error — Claude Code lo ignora en silencio y la delegacion se pierde
 * entera. Fue un KIRKARDO CRITICAL (sprint 2026-05-27) causado por una tabla
 * de agentes stale, y la unica senal era que el trabajo no aparecia.
 *
 * DONDE VIVEN LOS AGENTES DE PLUGIN (comprobado en disco, 2026-09-22, Claude
 * Code 2.1.278): el layout legacy `plugins/cache/<mercado>/<plugin>/<version>/
 * agents` ya no es el unico. En esta maquina conviven ademas:
 *   plugins/marketplaces/<mercado>/{plugins,external_plugins}/<plugin>/agents
 *   plugins/marketplaces/<mercado>/agents        (mercado de un solo plugin,
 *                                                  p.ej. addy-agent-skills)
 *   plugins/synced/<id>/<plugin>/agents          (variantes con sufijo ~g2)
 *   skills/synced/<id>/<plugin>/agents           (skills con agentes propios)
 * El nombre de la CARPETA no siempre es el prefijo invocable: la carpeta
 * `addy-agent-skills` declara `"name": "agent-skills"` en su plugin.json, asi
 * que `agent-skills:code-reviewer` es el subagent_type real y
 * `addy-agent-skills:code-reviewer` no lo es. Se aceptan los dos nombres.
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

const { variantes, palabras, binarioDe, comandosDe } = require('./lib/shell-wrappers');

const HOME = os.homedir();

/** Por debajo de esto se asume catalogo mal leido y la regla se desactiva. */
const MIN_CATALOGO = 20;

/** Tipos que sirve el propio harness y que no tienen fichero en disco. */
const AGENTES_BUILTIN = [
  'general-purpose', 'Explore', 'Plan', 'claude', 'fork',
  'statusline-setup', 'output-style-setup', 'claude-code-guide',
];

/** Herramientas que trata classify(); el matcher del hook debe incluirlas todas. */
const TOOLS_CUBIERTAS = Object.freeze(['Bash', 'PowerShell', 'Monitor', 'Agent', 'Task']);

// Dialecto de la linea por herramienta de shell. `Monitor.command` es "Shell command
// or script" (tipos del motor) y su shell depende de la maquina: se miran los dos.
const DIALECTOS_POR_TOOL = Object.freeze({ Bash: ['bash'], PowerShell: ['ps'], Monitor: ['bash', 'ps'] });

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
      // Los enlaces de directorio de Windows no son isDirectory(): sin
      // isSymbolicLink() se perderian arboles enteros bajo ~/.claude/plugins.
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch (_) {
    return [];
  }
}

/**
 * Prefijos con los que se puede invocar un agente de este plugin. El prefijo
 * real es el `name` de plugin.json, que no siempre coincide con el nombre de
 * la carpeta (`addy-agent-skills/` declara `"name": "agent-skills"`, y
 * `brand-voice~g2/` declara `"name": "brand-voice"`). Se aceptan los dos —
 * es gratis y evita un falso "no existe" por un sufijo de carpeta.
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
 * Anade a `out` los agentes de `<dirPlugin>/agents`, con y sin prefijo de
 * plugin (ambas formas aparecen en la lista que se inyecta al modelo).
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
 * Claude Code lee: agentes de usuario, los del harness y los de plugin en
 * cada layout de disco que existe de verdad (ver cabecera). Hasta el
 * 2026-09-22 solo se miraba `plugins/cache`, que en Claude Code 2.1.278 ya no
 * es donde viven la mayoria de plugins instalados: el catalogo salia casi sin
 * agentes de plugin y la regla los marcaba a todos como inexistentes.
 *
 * @param {string} [home] raiz donde buscar `.claude/`; los selftests la apuntan a
 *   un fixture para cubrir layouts que no estan instalados en la maquina.
 * @returns {Set<string>}
 */
function agentesValidos(home = HOME) {
  const out = new Set(AGENTES_BUILTIN);
  for (const f of ficherosMd(path.join(home, '.claude', 'agents'))) {
    out.add(f.replace(/\.md$/, ''));
  }

  const raizPlugins = path.join(home, '.claude', 'plugins');

  // marketplaces/<mercado>/... : un mercado puede ser el plugin en si mismo
  // (agents/ en su propia raiz, p.ej. addy-agent-skills) o alojar varios en
  // plugins/ y external_plugins/.
  const marketplaces = path.join(raizPlugins, 'marketplaces');
  for (const mercado of subcarpetas(marketplaces)) {
    const dirMercado = path.join(marketplaces, mercado);
    agentesDePlugin(out, dirMercado, mercado);
    for (const grupo of ['plugins', 'external_plugins']) {
      const raiz = path.join(dirMercado, grupo);
      for (const p of subcarpetas(raiz)) agentesDePlugin(out, path.join(raiz, p), p);
    }
  }

  // synced/<id>/<plugin>/agents -- dos raices reales en esta maquina:
  // plugins/synced (paquetes con variantes "<nombre>~g2") y skills/synced
  // (skills que traen agentes propios, p.ej. ultron, the-creator).
  const raicesSynced = [
    path.join(raizPlugins, 'synced'),
    path.join(home, '.claude', 'skills', 'synced'),
  ];
  for (const raizSynced of raicesSynced) {
    for (const id of subcarpetas(raizSynced)) {
      const raiz = path.join(raizSynced, id);
      for (const p of subcarpetas(raiz)) agentesDePlugin(out, path.join(raiz, p), p);
    }
  }

  // cache/<mercado>/<plugin>/<version>/agents -- layout heredado; se conserva
  // porque algunos plugins (p.ej. superpowers en esta maquina) solo estan ahi.
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

// El troceo de la linea en comandos (comillas, sustituciones `$(...)` y
// backticks, comentarios, escape por dialecto y vuelta al split ingenuo ante
// la duda) vive en lib/shell-segments.js. `dialectos` es ['bash'] para la
// herramienta Bash, ['ps'] para PowerShell y los dos para los comandos
// interiores de un `bash -c`/`pwsh -Command`, cuyo dialecto no se sabe.

// `git` seguido de opciones globales: `-C <ruta>`, `-c k=v`, `--git-dir <d>`,
// `--no-pager`... Hasta el 2026-10-23 el patron era `git\s+(-\S+\s+)*commit`,
// que no admitia el argumento separado de `-C` ni de `-c`: `git -C <ruta> commit`
// (la forma habitual en worktrees) se saltaba commit-format y force-push (hooks-3).
const GIT_OPT_CON_ARG = '(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)';
const GIT_OPCIONES_GLOBALES =
  String.raw`(?:\s+${GIT_OPT_CON_ARG}\s+(?:"[^"]*"|'[^']*'|[^\s"']+)|\s+(?!${GIT_OPT_CON_ARG}\s)-[^\s]+)*`;
const GIT_PREFIJO =
  String.raw`(?:^|[\s;&|(])["']?(?:[^\s"';&|()]*[\\/])?git(?:\.exe)?["']?` + GIT_OPCIONES_GLOBALES;
const RE_GIT_COMMIT = new RegExp(String.raw`${GIT_PREFIJO}\s+commit(?=\s|$)`);
const RE_SUB_GIT = new RegExp(String.raw`^${GIT_OPCIONES_GLOBALES}\s+["']?([\w-]+)["']?(?=\s|$)`);

/**
 * Subcomando de git de un comando ya normalizado (ver comandosDe), o null. Mirar
 * la palabra de comando evita los falsos positivos de `echo "git commit -m x"` y
 * `grep "git push -f" a.md`. Limite declarado: un envoltorio fuera de PREFIJOS
 * (`ssh h git push -f`) y los alias de git (`git ci`) no se ven.
 *
 * @returns {{sub:string, args:string}|null}
 */
function subGit({ bin, resto }) {
  if (bin !== 'git') return null;
  const m = resto.match(RE_SUB_GIT);
  return m ? { sub: m[1].toLowerCase(), args: resto.slice(m[0].length) } : null;
}

const RE_BIN_PYTHON = /^(?:python[\d.]*|pythonw|py)$/;
const RE_BIN_PIP = /^pip[\d.]*$/;

/**
 * CLAUDE.md: "UV siempre. Nunca `python -m`, `pip install`, ni
 * `python script.py`". Se comprueba el binario de cada comando, tambien por ruta
 * (`.venv/Scripts/python.exe`) y tras un prefijo (`timeout 10 python`).
 */
function reglaUv(cmd, dialectos) {
  for (const { real, bin, resto } of comandosDe(cmd, dialectos)) {
    if (RE_BIN_PYTHON.test(bin)) {
      return `\`${real.slice(0, 60)}\` invoca Python fuera de UV — usa \`uv run python ...\``;
    }
    if (RE_BIN_PIP.test(bin) && palabras(resto)[0] === 'install') {
      return `\`${real.slice(0, 60)}\` usa pip directo — usa \`uv pip install ...\``;
    }
  }
  return null;
}

// La opcion del mensaje: `-m`, combinada (`-am`, `-qm`), pegada (`-m"x"`) o larga
// (`--message=x`, `--message x`, `--mess x`).
const RE_FLAG_MENSAJE = /(?:^|\s)(?:-[a-zA-Z]*m|--mes[a-z]*(?:=|(?=\s)))/;

/**
 * Extrae el mensaje de un `git commit`, venga en -m, en here-string de
 * PowerShell (`@'…'@` o `@"…"@`), en heredoc directo o en el formato estandar
 * de Claude Code para mensajes multilinea: `-m "$(cat <<'EOF' … EOF\n)"`.
 *
 * Devuelve null cuando el mensaje es una sustitucion o una variable que no se
 * puede leer (`-m "$(cat mensaje.txt)"`, `-m "$msg"`): sin mensaje legible no
 * se bloquea.
 *
 * Solo cuenta el PRIMER `-m`: git usa el primero como asunto y los demas como
 * parrafos del cuerpo, asi que `-m "feat: x" -m "$(cat <<'EOF' …)"` es valido
 * aunque el cuerpo no empiece por un tipo.
 */
function mensajeCommit(cmd) {
  // El `-m` se busca DESPUES de `git … commit`: en `python -m pytest && git
  // commit -m "…"` el primer `-m` es de Python, no el mensaje.
  const s0 = String(cmd || '');
  const commit = s0.search(RE_GIT_COMMIT);
  const tras = commit < 0 ? s0 : s0.slice(commit);
  const flag = tras.match(RE_FLAG_MENSAJE);
  if (!flag) return null;
  // Forma comun para lo que sigue: `-am "x"`, `-m"x"` y `--message=x` valen `-m x`.
  const s = `-m ${tras.slice(flag.index + flag[0].length).trimStart()}`;
  const hereString = s.match(/^-m\s+@(['"])\r?\n([\s\S]*?)\r?\n\1@/);
  if (hereString) return hereString[2];
  // `$(cat <<'EOF'` … `EOF` … `)`: el delimitador puede ir con comillas
  // simples, dobles o sin ellas, y con `<<-`.
  const catHeredoc = s.match(
    /^-m\s+["']?\$\(\s*cat\s+<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\r?\n([\s\S]*?)\r?\n[ \t]*\2[ \t]*(?:\r?\n|\)|$)/,
  );
  if (catHeredoc) return catHeredoc[3];
  const heredoc = s.match(/^-m\s+<<-?'?\w+'?\r?\n([\s\S]*?)\r?\n\w+/);
  if (heredoc) return heredoc[1];
  const comillas = s.match(/^-m\s+"((?:[^"\\]|\\.)*)"/) || s.match(/^-m\s+'((?:[^'\\]|\\.)*)'/);
  if (comillas) return /^\s*\$/.test(comillas[1]) ? null : comillas[1];
  const suelto = s.match(/^-m\s+(\S+)/);
  if (!suelto || /^["']?\$/.test(suelto[1])) return null;
  return suelto[1];
}

const RE_TIPO_COMMIT = new RegExp(`^(${TIPOS_COMMIT.join('|')})(\\([^)]+\\))?!?: .+`);

/** Motivo del deny si el mensaje del commit que empieza en `s` no es convencional. */
function formatoDelMensaje(s) {
  const msg = mensajeCommit(s);
  if (!msg) return null;                                   // no se pudo leer: no se bloquea
  // git descarta las lineas en blanco iniciales: el asunto es la primera con texto.
  const primera = (msg.split(/\r?\n/).find((l) => l.trim()) || '').trim();
  if (RE_TIPO_COMMIT.test(primera)) return null;
  return `commit "${primera.slice(0, 60)}" no sigue \`<type>: <description>\` (${TIPOS_COMMIT.slice(0, 8).join(', ')}…)`;
}

/**
 * Posiciones en la linea original del comando `seg`. El segmento es una copia
 * literal salvo las sustituciones, que el troceo deja como `$( )`, asi que se busca
 * lo que hay antes de la primera. Hacen falta todas: dos commits con heredoc dan
 * el mismo segmento y solo la linea original tiene sus mensajes.
 */
function posicionesEnLinea(linea, seg) {
  const marca = seg.search(/\$\( \)|` `/);
  const prefijo = marca < 0 ? seg : seg.slice(0, marca);
  const out = [];
  if (!prefijo) return out;
  for (let i = linea.indexOf(prefijo); i >= 0 && out.length < 16; i = linea.indexOf(prefijo, i + 1)) {
    out.push(i);
  }
  return out;
}

/**
 * rules/common/git-workflow.md: `<type>: <description>`. Se mira cada comando
 * `git commit` real de la linea: el texto que solo lo nombra (`echo "git commit -m
 * x"`, el cuerpo de un here-doc) no cuenta, y en dos commits encadenados valen los dos.
 */
function reglaCommitFormato(cmd, dialectos) {
  const linea = String(cmd || '');
  for (const c of comandosDe(linea, dialectos)) {
    const git = subGit(c);
    if (!git || git.sub !== 'commit') continue;
    if (/(?:^|\s)-(?:F|-file)(?:\s|=|\b)/.test(git.args)) continue;   // mensaje en fichero
    if (!RE_FLAG_MENSAJE.test(git.args)) continue;           // editor o --amend sin mensaje
    for (const inicio of posicionesEnLinea(linea, c.seg)) {
      const motivo = formatoDelMensaje(linea.slice(inicio));
      if (motivo) return motivo;
    }
  }
  return null;
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
// Equivalentes funcionales de la bandera (hooks-3): `--permission-mode
// bypassPermissions` activa el mismo modo y `--allow-dangerously-skip-permissions`
// lo deja disponible en la sesion.
// Se comparan palabras sin comillas (`claude "--bandera"`), no el texto: nombrar la
// bandera dentro de un prompt (`claude -p "… --bandera …"`) no es usarla.
const RE_BANDERA_BYPASS = /^--(?:allow-)?dangerously-skip-permissions(?:=|$)/i;
const RE_MODO_BYPASS = /^--permission-mode=bypassPermissions$/i;
const BINARIOS_CLAUDE = new Set(['claude', 'claude-code', '@anthropic-ai/claude-code']);
const RE_LANZADORES = /^(?:npx|bunx|pnpm\s+dlx)(?:\s+-\S+)*\s+/i;
const INTERPRETES_JS = new Set(['node', 'bun', 'deno']);
// `node …/cli.js`: el punto de entrada de la CLI instalada por npm.
const RE_SCRIPT_CLAUDE = /(?:^|[\\/])(?:cli\.m?js|claude(?:-code)?(?:\.m?js)?)$/i;

function usaBypass(args) {
  // `-ArgumentList "--bandera -p x"` de Start-Process: una cadena con varias
  // palabras que el proceso recibe separadas.
  const listaDeArgumentos = args.some((a) => /^-(?:argumentlist|args)$/i.test(a));
  const lista = listaDeArgumentos ? args.flatMap((a) => a.split(/\s+/)) : args;
  return lista.some((a, i) =>
    RE_BANDERA_BYPASS.test(a) ||
    RE_MODO_BYPASS.test(a) ||
    (/^--permission-mode$/i.test(a) && /^bypassPermissions$/i.test(lista[i + 1] || '')));
}

/** Argumentos que recibe la CLI de claude en este comando, o null si no la invoca. */
function argumentosDeClaude({ real }) {
  const { bin, resto } = binarioDe(real.replace(RE_LANZADORES, ''));
  if (BINARIOS_CLAUDE.has(bin) || /[\\/]claude-code$/.test(bin)) return palabras(resto);
  if (!INTERPRETES_JS.has(bin)) return null;
  const args = palabras(resto);
  const script = args.find((a) => !a.startsWith('-'));
  return script && RE_SCRIPT_CLAUDE.test(script) ? args : null;
}

function reglaSkipPermissions(cmd, dialectos) {
  for (const c of comandosDe(cmd, dialectos)) {
    const args = argumentosDeClaude(c);
    if (args && usaBypass(args)) {
      return 'invocar claude con la bandera de saltarse permisos esta prohibido en las reglas del sistema';
    }
  }
  return null;
}

const RE_PUSH_FORZADO = /^(?:--for[a-z-]*(?:=.*)?|--mir[a-z]*|-[A-Za-z0-9]*f[A-Za-z0-9]*|\+\S+)$/;

/**
 * Reescribir historia ya publicada no se deshace: pide confirmacion. Por comando:
 * con PowerShell en el matcher, el operador de formato `-f` (`"{0}" -f $x; git
 * push`) no puede contar como la bandera del push. Formas forzadas: --force, sus
 * variantes y abreviaturas (`--forc`), --mirror, una -f suelta o combinada (`-uf`)
 * y el refspec con `+` (`git push origin +main`), con o sin comillas.
 */
function reglaForcePush(cmd, dialectos) {
  for (const c of comandosDe(cmd, dialectos)) {
    const git = subGit(c);
    if (git && git.sub === 'push' && palabras(git.args).some((a) => RE_PUSH_FORZADO.test(a))) {
      return 'push forzado: reescribe historia ya publicada';
    }
  }
  return null;
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

  const propio = DIALECTOS_POR_TOOL[toolName];
  if (propio) {
    // La linea tal cual y cada comando que lanza a traves de otra shell
    // (`bash -c`, `pwsh -Command`, `cmd /c`...): ver lib/shell-wrappers.js.
    // La linea va en el dialecto de la herramienta; los interiores, cuyo
    // dialecto no se sabe (puede ser cmd.exe), en todos y con el split de HEAD.
    for (const [n, cmd] of variantes(input.command || '', propio).entries()) {
      const v = clasificaShell(cmd, n === 0 ? propio : ['bash', 'ps', 'cmd']);
      if (v) return v;
    }
  }

  return null;
}

/** Reglas de shell sobre un comando ya desenvuelto. */
function clasificaShell(cmd, dialectos) {
  const skip = reglaSkipPermissions(cmd, dialectos);
  if (skip) return { decision: 'deny', regla: 'skip-permissions', reason: skip };
  const uv = reglaUv(cmd, dialectos);
  if (uv) return { decision: 'deny', regla: 'uv', reason: uv };
  const commit = reglaCommitFormato(cmd, dialectos);
  if (commit) return { decision: 'deny', regla: 'commit-format', reason: commit };
  const fpush = reglaForcePush(cmd, dialectos);
  if (fpush) return { decision: 'ask', regla: 'force-push', reason: fpush };
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

  // Solo el nombre de la regla: sin esto no se podia saber si habia disparado alguna vez.
  try {
    require('./lib/hook-obs.js').annotate({ decision: veredicto.decision, rule: veredicto.regla, tool: String(data.tool_name || 'unknown') });
  } catch (_) { /* la observabilidad jamas rompe un hook */ }
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
  TOOLS_CUBIERTAS,
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
