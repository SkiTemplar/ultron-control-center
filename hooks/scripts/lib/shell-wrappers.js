'use strict';
/**
 * lib/shell-wrappers.js — normaliza lo que una linea de shell ejecuta de verdad
 * (hooks-3, auditoria 2026-10-23; ampliado en la auditoria 2026-11-01). Lo
 * comparten guardrails-pre y deny-secrets.
 *
 * Hay dos problemas distintos:
 *
 *  1. Un comando que se ejecuta a traves de otra shell: `bash -c "…"`,
 *     `pwsh -NoProfile -Command "…"`, `powershell -EncodedCommand <base64>`,
 *     `cmd /c …`, `echo "…" | bash`, `bash <<EOF`, `eval "…"`, `iex "…"`. Las
 *     reglas miran el COMIENZO de cada segmento y ahi esta la shell, no el
 *     binario real. `variantes(cmd)` devuelve la linea original mas cada comando
 *     interior (hasta MAX_DEPTH niveles), y las reglas se aplican a todas.
 *  2. Prefijos que no cambian que binario se acaba ejecutando (`timeout 5 x`,
 *     `sudo -u r x`, `then x`, `Start-Process x`): `sinPrefijos` y `binarioDe`
 *     llegan al binario, y `comandosDe` anade el `-exec` de `find`.
 *
 * Una shell que solo aparece dentro de un argumento entre comillas no ejecuta
 * nada (`grep "bash -c python" a.md`, `git commit -m "… sh -c …"`) y el cuerpo de
 * un here-doc son datos salvo que lo lea una shell: ninguno de los dos cuenta.
 *
 * Limite declarado: no evalua la shell. `eval "$x"`, variables, sustituciones,
 * alias de git, un escape en el nombre del binario (`pyt\hon`), codigo dentro de
 * otro interprete (`node -e`, `base64 -d | bash`) y envoltorios fuera de
 * PREFIJOS (`parallel`, `fd -x`, `poetry run`) siguen sin verse.
 */

const { segmentos, sinHeredocs } = require('./shell-segments');

const MAX_DEPTH = 3;
const MAX_VARIANTS = 16;
// Topes de coste: el hook es sincrono en cada llamada a la shell, y una linea
// patologica (`sh -c ` repetido miles de veces) no puede acercarlo a su timeout.
const MAX_SHELLS_POR_LINEA = 8;
const MAX_TOKENS = 64;
const MAX_PREFIJOS = 8;

const SHELLS = 'bash|sh|zsh|dash|ksh|pwsh|powershell|cmd';
// Sin el acento grave: RE_SHELL lo admite como inicio y, si tambien cupiera en la
// ruta, una linea de acentos hacia cuadratico el escaneo (34 s medidos con 300 KB).
const RUTA_OPCIONAL = String.raw`(?:[^\s"';&|()\x60]*[\\/])?`;
const BIN_SHELL = String.raw`["']?${RUTA_OPCIONAL}(?:${SHELLS})(?:\.exe)?["']?`;

// Binario de shell como palabra de comando, opcionalmente por ruta, entre
// comillas o tras el operador de llamada `&` de PowerShell.
const RE_SHELL = new RegExp(
  String.raw`(?:^|[\s;&|(\x60])["']?${RUTA_OPCIONAL}(${SHELLS})(?:\.exe)?["']?(?=\s)`,
  'gi',
);
// `echo "…" | bash`: el argumento literal es lo que ejecuta la shell. Las
// alternativas son disjuntas, asi que el escaneo es lineal.
const RE_ECHO_A_SHELL = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:echo|printf)(?:\s+-[a-zA-Z]+)*\s+("[^"\n]{0,4000}"|'[^'\n]{0,4000}'|[^\s"'|;&\n][^|;&\n"']{0,4000})\s*\|\s*${BIN_SHELL}(?=\s|$)`,
  'gi',
);
const RE_TUBERIA_A_SHELL = new RegExp(String.raw`\|\s*${BIN_SHELL}(?=\s|$)`, 'i');
// `bash <<EOF` y `cat <<EOF | bash`, con el delimitador en el grupo 2 o el 4.
const RE_DOC_A_SHELL = new RegExp(
  String.raw`(?:^|[;&|(]\s*)${BIN_SHELL}(?:\s+-\S+)*\s*<<-?\s*(['"]?)([A-Za-z_]\w*)\1` +
    String.raw`|<<-?\s*(['"]?)([A-Za-z_]\w*)\3[^\n]*\|\s*${BIN_SHELL}(?=\s|$)`,
  'i',
);
// `bash <<< "…"`: el here-string es el programa.
const RE_HERESTRING_A_SHELL = new RegExp(
  String.raw`(?:^|[;&|(]\s*)${BIN_SHELL}\s*<<<\s*("[^"\n]*"|'[^'\n]*')`,
  'gi',
);

/**
 * Trocea respetando comillas (como mucho `max` tokens). Devuelve
 * `{ value, start, end }` por token: el valor sin comillas y su posicion en `text`.
 */
function tokens(text, max = MAX_TOKENS) {
  const out = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']+))/gy;
  let m;
  while (out.length < max && (m = re.exec(text)) && m[0].length > 0) {
    const value = m[1] != null ? m[1].replace(/\\(["\\])/g, '$1') : m[2] != null ? m[2] : m[3];
    out.push({ value, start: m.index + (m[0].length - m[0].trimStart().length), end: re.lastIndex });
  }
  return out;
}

const RE_PALABRA = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;

/**
 * Palabras de un comando como las ve el programa: `--fo"rce"`, `"--force"` y
 * `'-f'` llegan sin comillas. Una cadena con espacios sigue siendo una palabra,
 * asi que nombrar una bandera dentro de un texto (`-p "usa --force"`) no la usa.
 */
function palabras(text, max = MAX_TOKENS) {
  const out = [];
  for (const m of String(text || '').matchAll(RE_PALABRA)) {
    out.push(m[0].replace(/["']/g, ''));
    if (out.length >= max) break;
  }
  return out;
}

// --- binario real de un segmento ---------------------------------------------

const OPCIONES_START_PROCESS = /^-(?:windowstyle|workingdirectory|wo|verb|credential|redirectstandard\w+)$/i;

/**
 * Prefijos transparentes. `opcionesConValor`: opciones cuyo valor va aparte.
 * `valores`: argumentos posicionales antes del comando (`timeout 5 x`).
 * `consulta`: opciones con las que el prefijo no ejecuta el comando, solo lo
 * consulta (`command -v python`). `asignaciones`: admite `K=V` (`env K=V x`).
 */
const PREFIJOS = new Map([
  ['sudo', { opcionesConValor: /^-[ughpCTrt]$/ }],
  ['nohup', {}],
  ['time', {}],
  ['env', { opcionesConValor: /^-[uCS]$/, asignaciones: true }],
  ['timeout', { opcionesConValor: /^-[ks]$/, valores: 1 }],
  ['exec', { opcionesConValor: /^-a$/ }],
  ['command', { consulta: /^-[vV]$/ }],
  ['builtin', {}],
  ['nice', { opcionesConValor: /^-n$/ }],
  ['ionice', { opcionesConValor: /^-[cnp]$/ }],
  ['stdbuf', { opcionesConValor: /^-[ioe]$/ }],
  ['setsid', {}],
  ['xargs', { opcionesConValor: /^-[nILPEdsa]$/ }],
  ['start-process', { opcionesConValor: OPCIONES_START_PROCESS }],
  ['saps', { opcionesConValor: OPCIONES_START_PROCESS }],
  ['start', { opcionesConValor: /^\/d$/i, barra: true }],
  ['then', {}],
  ['do', {}],
  ['else', {}],
  ['elif', {}],
  ['if', {}],
  ['while', {}],
  ['until', {}],
]);

const RE_PRIMERA_PALABRA = /^(?:"[^"]*"|'[^']*'|[^\s"'])+/;

/** Primera palabra de `s` (`{ crudo, valor }`); null si no hay. */
function primeraPalabra(s) {
  const m = s.match(RE_PRIMERA_PALABRA);
  return m ? { crudo: m[0], valor: m[0].replace(/["']/g, '') } : null;
}

/** Nombre base en minusculas y sin extension ejecutable. */
function nombreBase(token) {
  return String(token)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1|com)$/, '');
}

/** Salta las opciones de un prefijo; devuelve lo que queda, o null si solo consulta. */
function saltaOpciones(spec, resto0) {
  let resto = resto0;
  let posicionales = spec.valores || 0;
  for (let i = 0; i < MAX_TOKENS; i++) {
    const w = primeraPalabra(resto);
    if (!w) return resto;
    if (spec.consulta && spec.consulta.test(w.valor)) return null;
    const esOpcion = w.valor.startsWith('-') || (spec.barra === true && w.valor.startsWith('/'));
    const esAsignacion = spec.asignaciones === true && /^\w+=/.test(w.valor);
    // `start "titulo" x` de cmd.exe: la primera cadena entre comillas es el titulo.
    const esTitulo = spec.barra === true && /^["']/.test(w.crudo) && (w.valor === '' || /\s/.test(w.valor));
    const salta = esOpcion || esAsignacion || esTitulo;
    if (!salta && posicionales === 0) return resto;
    if (!salta) posicionales--;
    resto = resto.slice(w.crudo.length).trimStart();
    if (esOpcion && spec.opcionesConValor && spec.opcionesConValor.test(w.valor)) {
      const valor = primeraPalabra(resto);
      if (valor) resto = resto.slice(valor.crudo.length).trimStart();
    }
  }
  return resto;
}

/** Quita un prefijo transparente con sus opciones; devuelve `s` si no hay ninguno. */
function quitaPrefijo(s) {
  const primera = primeraPalabra(s);
  const spec = primera && PREFIJOS.get(nombreBase(primera.valor));
  if (!spec) return s;
  const resto = saltaOpciones(spec, s.slice(primera.crudo.length).trimStart());
  return resto === null ? s : resto;
}

/**
 * Quita lo que no cambia que binario se ejecuta: el operador de llamada `&` de
 * PowerShell, la apertura de un subshell, grupo o negacion (`(`, `{`, `!`), la
 * cabecera de una funcion o de una rama de `case`, las asignaciones de entorno
 * (`FOO=1 python x.py`) y los prefijos de PREFIJOS.
 */
function sinPrefijos(seg) {
  let s = String(seg || '');
  for (let i = 0; i < MAX_PREFIJOS; i++) {
    const antes = s;
    s = s
      .replace(/^[\s&({!]+/, '')
      .replace(/^\w+\(\)\s*/, '')
      .replace(/^case\s.*?\sin\s+/, '')
      .replace(/^[^\s()"']+\)\s+/, '')
      .replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+)+/, '');
    s = quitaPrefijo(s);
    if (s === antes) break;
  }
  return s.trim();
}

/**
 * Separa el binario del resto del segmento. El binario puede venir por ruta y
 * entre comillas (`"C:\Program Files\X\claude.exe"`, habitual en PowerShell) o
 * partido por comillas (`p"ytho"n`): se devuelve su nombre base en minusculas y
 * sin extension ejecutable.
 *
 * @param {string} seg segmento ya pasado por sinPrefijos
 * @returns {{bin:string, resto:string}}
 */
function binarioDe(seg) {
  const primera = primeraPalabra(String(seg || ''));
  if (!primera) return { bin: '', resto: '' };
  return { bin: nombreBase(primera.valor), resto: seg.slice(primera.crudo.length) };
}

const RE_FIND_EXEC = /\s-(?:exec|execdir|ok|okdir)\s+(.+?)(?=\s+(?:\\;|';'|";"|\+)(?:\s|$)|$)/g;

/**
 * Comandos que ejecuta `cmd`: sus segmentos (ver lib/shell-segments.js) mas lo
 * que lanza `find -exec`, ya sin prefijos, con su binario y el segmento original.
 *
 * @returns {{seg:string, real:string, bin:string, resto:string}[]}
 */
function comandosDe(cmd, dialectos) {
  const out = [];
  for (const seg of segmentos(cmd, dialectos)) {
    const real = sinPrefijos(seg);
    const { bin, resto } = binarioDe(real);
    out.push({ seg, real, bin, resto });
    if (bin !== 'find') continue;
    for (const m of resto.matchAll(RE_FIND_EXEC)) {
      const interior = sinPrefijos(m[1]);
      out.push({ seg, real: interior, ...binarioDe(interior) });
    }
  }
  return out;
}

// --- comandos interiores -----------------------------------------------------

/** Comando interior de una shell de la familia sh: el argumento tras `-c` (o `-lc`, `-xc`…). */
function interiorSh(args) {
  const i = args.findIndex((t) => /^-[a-z]*c[a-z]*$/i.test(t.value));
  return i >= 0 && args[i + 1] ? args[i + 1].value : null;
}

// Opciones de PowerShell que llevan un valor aparte.
const RE_PWSH_CON_VALOR = /^[-/](?:ex|ep|executionpolicy|w|windowstyle|wd|workingdirectory|if|inputformat|of|outputformat|configurationname|psconsolefile|version|v|settingsfile|custompipename)$/i;
const RE_PWSH_FICHERO = /^[-/]f(?:i|il|ile)?$/i;

/** PowerShell acepta cualquier prefijo inequivoco de una opcion (`-Com`, `-encodedc`, `/enc`). */
function esOpcionPwsh(flag, nombre) {
  const n = flag.replace(/^[-/]/, '').toLowerCase();
  return n.length >= 1 && nombre.startsWith(n);
}

/** Comando interior de PowerShell: `-Command`, `-EncodedCommand` o el primer posicional. */
function interiorPwsh(args, rest) {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].value;
    if (!/^[-/]/.test(flag)) {
      return args.length === i + 1 ? flag : rest.slice(args[i].start).trim();
    }
    if (RE_PWSH_FICHERO.test(flag)) return null;
    if (esOpcionPwsh(flag, 'command') && args[i + 1]) {
      return args.length === i + 2 ? args[i + 1].value : rest.slice(args[i + 1].start).trim();
    }
    if ((esOpcionPwsh(flag, 'encodedcommand') || /^[-/]ec$/i.test(flag)) && args[i + 1]) {
      return Buffer.from(args[i + 1].value, 'base64').toString('utf16le');
    }
    if (RE_PWSH_CON_VALOR.test(flag)) i++;
  }
  return null;
}

/** Comando interior de cmd.exe: todo lo que sigue a `/c` o `/k` (tambien pegado: `/cdir`). */
function interiorCmd(args, rest) {
  const i = args.findIndex((t) => /^\/[ck]/i.test(t.value));
  if (i < 0) return null;
  if (args[i].value.length > 2) return rest.slice(args[i].start + 2).trim();
  if (!args[i + 1]) return null;
  return rest.slice(args[i + 1].start).trim().replace(/^"([\s\S]*)"$/, '$1');
}

/** Interior de la shell `shell` cuyos argumentos son `rest`. */
function interiorDeShell(shell, rest) {
  const args = tokens(rest);
  if (shell === 'pwsh' || shell === 'powershell') return interiorPwsh(args, rest);
  if (shell === 'cmd') return interiorCmd(args, rest);
  return interiorSh(args);
}

/** Rangos `[inicio, fin, comilla]` de las cadenas entre comillas de `text` en un dialecto. */
function rangosDeComillas(text, ps) {
  const rangos = [];
  const escape = ps ? '`' : '\\';
  let abre = -1;
  let comilla = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comilla === "'") {
      if (c === "'") {
        rangos.push([abre, i, "'"]);
        comilla = null;
      }
    } else if (c === escape) {
      i++;
    } else if (comilla === '"') {
      if (c === '"') {
        rangos.push([abre, i, '"']);
        comilla = null;
      }
    } else if (c === '"' || c === "'") {
      abre = i;
      comilla = c;
    } else if (c === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      const fin = text.indexOf('\n', i);
      if (fin < 0) break;
      i = fin;
    }
  }
  return rangos;
}

/**
 * true si la shell en `pos` (nombre de largo `largo`) esta dentro de un argumento
 * entre comillas: es texto, no se ejecuta. No cuenta si la comilla envuelve solo
 * al binario (`"C:\…\bash.exe" -c …`) ni si antes hay una sustitucion que la
 * cadena doble si ejecuta (`"$(bash -c …)"`).
 */
function esTextoCitado(text, pos, largo, rangos) {
  for (const [a, b, tipo] of rangos) {
    if (pos <= a || pos >= b) continue;
    if (text.slice(pos + largo, b).replace(/^\.exe$/i, '') === '') return false;
    return !(tipo === '"' && /\$\(|`/.test(text.slice(a, pos)));
  }
  return false;
}

/**
 * Filtro de argumentos citados segun los dialectos. Solo se descarta si TODOS
 * los dialectos posibles lo ven como texto: 'cmd' no tiene comillas simples, asi
 * que en un comando interior (dialecto desconocido) no se descarta nada. Una
 * duda aqui da un falso positivo, nunca oculta un comando.
 */
function filtroDeCitas(text, dialectos) {
  if (dialectos.includes('cmd')) return () => false;
  const porDialecto = dialectos.map((d) => rangosDeComillas(text, d === 'ps'));
  return (pos, largo) => porDialecto.every((r) => esTextoCitado(text, pos, largo, r));
}

/** Cuerpos de los here-docs que lee una shell (`bash <<EOF`, `cat <<EOF | bash`). */
function cuerposParaShell(raw) {
  const out = [];
  const lineas = raw.split('\n');
  for (let i = 0; i < lineas.length && out.length < MAX_SHELLS_POR_LINEA; i++) {
    const m = lineas[i].match(RE_DOC_A_SHELL);
    if (!m) continue;
    const fin = m[2] || m[4];
    const hasta = lineas.findIndex((l, j) => j > i && l.trim() === fin);
    if (hasta > i) out.push(lineas.slice(i + 1, hasta).join('\n'));
  }
  return out;
}

const sinComillas = (s) => s.replace(/^(["'])([\s\S]*)\1$/, '$2');

/** `echo "…" | bash` y `bash <<< "…"`: el texto que recibe la shell por stdin. */
function textosPorStdin(text) {
  const out = [];
  // Sin una tuberia a una shell no hay nada que buscar: `echo ` repetido miles de
  // veces hacia cuadratico el escaneo (7,9 s medidos con 100 KB, el hook es sincrono).
  const hayTuberia = RE_TUBERIA_A_SHELL.test(text);
  for (const re of hayTuberia ? [RE_ECHO_A_SHELL, RE_HERESTRING_A_SHELL] : [RE_HERESTRING_A_SHELL]) {
    for (const m of text.matchAll(re)) {
      if (out.length >= MAX_SHELLS_POR_LINEA) return out;
      out.push(sinComillas(m[1].trim()));
    }
  }
  return out;
}

/** `eval "…"`, `iex "…"`, `Invoke-Expression "…"` con un literal sin variables. */
function textosEvaluados(text, dialectos) {
  const out = [];
  for (const { bin, resto } of comandosDe(text, dialectos)) {
    if (bin !== 'eval' && bin !== 'iex' && bin !== 'invoke-expression') continue;
    const literal = sinComillas(resto.replace(/^\s*(?:-Command\s+)?/i, '').trim());
    if (literal && !literal.includes('$')) out.push(literal);
  }
  return out;
}

const DIALECTOS_DESCONOCIDOS = ['bash', 'ps', 'cmd'];

/**
 * Comandos interiores que lanza `cmd` a traves de otra shell (un nivel).
 *
 * @param {string} cmd
 * @param {Array<'bash'|'ps'|'cmd'>} [dialectos] de la linea; sin indicar, desconocido
 */
function interiores(cmd, dialectos = DIALECTOS_DESCONOCIDOS) {
  const raw = String(cmd || '');
  const text = sinHeredocs(raw, dialectos).texto;
  const citado = filtroDeCitas(text, dialectos);
  const out = [...cuerposParaShell(raw), ...textosPorStdin(text), ...textosEvaluados(raw, dialectos)];
  let vistas = 0;
  for (const m of text.matchAll(RE_SHELL)) {
    if (++vistas > MAX_SHELLS_POR_LINEA) break;
    const pos = m.index + m[0].toLowerCase().lastIndexOf(m[1].toLowerCase());
    if (citado(pos, m[1].length)) continue;
    const inner = interiorDeShell(m[1].toLowerCase(), text.slice(m.index + m[0].length));
    if (inner && inner.trim()) out.push(inner.trim());
  }
  return out.filter((c) => c.trim());
}

/**
 * La linea original mas cada comando interior, en anchura y sin repetir. La linea
 * va en sus dialectos; los interiores, cuyo dialecto no se sabe, en todos.
 *
 * @param {string} cmd
 * @param {Array<'bash'|'ps'|'cmd'>} [dialectos]
 * @returns {string[]}
 */
function variantes(cmd, dialectos = DIALECTOS_DESCONOCIDOS) {
  const raiz = String(cmd || '');
  const seen = new Set([raiz]);
  let frontier = [{ c: raiz, d: dialectos }];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const { c, d } of frontier) {
      for (const inner of interiores(c, d)) {
        if (seen.has(inner) || seen.size >= MAX_VARIANTS) continue;
        seen.add(inner);
        next.push({ c: inner, d: DIALECTOS_DESCONOCIDOS });
      }
    }
    frontier = next;
  }
  return [...seen];
}

module.exports = { variantes, interiores, tokens, palabras, sinPrefijos, binarioDe, comandosDe };
