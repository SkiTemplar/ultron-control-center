'use strict';
/**
 * lib/shell-segments.js — trocea una linea de shell en los comandos que
 * ejecuta, para las reglas de guardrails-pre (que miran el COMIENZO de cada
 * trozo: `grep python foo.txt` o `echo "python x.py"` no invocan Python).
 *
 * Que entiende (revision final 2026-10-26, hooks-kanban HIGH y MEDIUM):
 *   - separadores `\n ; & && || |` fuera de comillas; dentro de '...' o "..."
 *     no cortan (una alternancia `(js|py)` en un grep no es una tuberia);
 *   - sustituciones de comando: `$(...)`, `<(...)`, `>(...)` y, en bash, los
 *     backticks. Se extraen y se trocean aparte TAMBIEN dentro de comillas
 *     dobles, porque ahi bash (y PowerShell con `$(...)`) las ejecuta:
 *     `x="$(true; python x.py)"` lanza Python;
 *   - comentarios `#` solo fuera de comillas y al inicio de palabra (y
 *     `<# ... #>` en PowerShell): el apostrofo de `# don't` no abre comilla;
 *   - escape por dialecto: `\` en bash, backtick en PowerShell, donde `\` es
 *     un caracter normal (`"C:\tmp\"` es una cadena cerrada).
 *
 * FAIL-CLOSED (segunda ronda, 2026-10-26): el troceo con comillas solo manda
 * si la linea es SEGURA. Cuenta como duda: comilla, sustitucion o comentario
 * de bloque sin cerrar; un `case` dentro de `$(...)`; anidacion por encima de
 * MAX_ANIDACION; here-doc sin terminador; comillas ANSI-C de bash `$'...'`
 * (dentro, `\'` NO cierra); comillas tipograficas (en PowerShell 5.1 abren y
 * cierran cadenas); el `--%` de PowerShell; y cualquier comando interior
 * (dialecto 'cmd': cmd.exe no tiene comillas simples y su `&` separa). Ante
 * la duda se anaden ademas, sobre la linea entera, el split de HEAD
 * (cf5d94a3: `\n ; && || |`) y uno ingenuo que corta tambien por `& ( ) { }`
 * y backticks. Un error de este troceo puede dar un falso positivo, nunca
 * ocultar un comando que HEAD veia.
 *
 * Here-docs: solo se quita un cuerpo si la apertura es inequivoca (fuera de
 * comillas, comentarios y backticks, sin escape delante, sin `<<<` ni
 * aritmetica en la linea, y en el dialecto que la tiene: `<<` en bash,
 * `@'`/`@"` en PowerShell). Si no, el cuerpo queda a la vista.
 *
 * Limite declarado: no evalua la shell (`eval` de una variable, variables,
 * alias, llaves `{ ...; }` de bash con el comando tras la llave en la misma
 * palabra). En PowerShell `(...)` y `{...}` separan desde el 2026-11-01, asi que
 * definir un bloque sin ejecutarlo (`$x = { python y }`) cuenta como ejecutarlo.
 */

// Split de HEAD (cf5d94a3), tal cual: la red de regresion en caso de duda.
const SEPARADORES_HEAD = /\n|;|&&|\|\||\|/;
const SEPARADORES_INGENUOS = /[\n;&|(){}`]/;
// ‘ ’ ‚ ‛ “ ” „ ‟: PowerShell 5.1 los trata como comillas simples o dobles.
const COMILLAS_TIPOGRAFICAS = /[‘-‟]/;
// Mas aperturas de here-doc que esto en una linea de comando es sospechoso.
const MAX_HEREDOCS = 50;
const SEPARADORES = new Set(['\n', ';', '|', '&']);
// Terminadores de here-string de PowerShell y su largo.
const HERE_STRING_CIERRES = new Set(["'@", '"@']);
const cierreLargo = 2;
// Tope de anidamiento de sustituciones: `$(` repetido miles de veces agotaria
// la pila, classify() lanzaria y el hook dejaria pasar (es fail-open). Pasado
// el tope el resto se trata como texto y cuenta como duda (split ingenuo).
const MAX_ANIDACION = 32;

/** `dest.push(...src)` sin el limite de argumentos de una llamada. */
function agrega(dest, src) {
  for (const x of src) dest.push(x);
  return dest;
}

/** Recorre una linea de un dialecto acumulando trozos y sustituciones. */
class Escaner {
  /**
   * @param {string} s
   * @param {boolean} ps dialecto PowerShell (escape = backtick)
   * @param {number} nivel anidamiento de partida (backticks dentro de backticks)
   */
  constructor(s, ps, nivel = 0) {
    this.s = s;
    this.ps = ps;
    this.nivel = nivel;
    this.i = 0;
    this.dudoso = false;
    /** @type {string[]} trozos de las sustituciones, a cualquier profundidad */
    this.subs = [];
    // Estado del nivel mas interno al acabar el texto (para saber si un `<<`
    // esta fuera de comillas): comilla abierta, comentario o backtick abierto.
    /** @type {string|null|undefined} */
    this.finComilla = undefined;
    this.finComentario = false;
    this.finInvertida = false;
  }

  /**
   * Lee hasta `cierre` (')' de una sustitucion) o hasta el final (null).
   * @returns {string[]} trozos de este nivel
   */
  bloque(cierre) {
    const st = { trozos: [], actual: '', comilla: null, prof: 0, cierre };
    while (this.i < this.s.length) {
      if (this.paso(st)) {
        st.trozos.push(st.actual);
        return st.trozos;
      }
    }
    if (cierre || st.comilla) this.dudoso = true;
    if (this.finComilla === undefined) this.finComilla = st.comilla;
    st.trozos.push(st.actual);
    return st.trozos;
  }

  /** Consume uno o varios caracteres. @returns {boolean} true al cerrar el bloque */
  paso(st) {
    const c = this.s[this.i];
    if (st.comilla === "'") return this.literal(st, c, "'");
    if (this.escape(st, c)) return false;
    if (this.sustitucion(st, c)) return false;
    if (st.comilla === '"') return this.literal(st, c, '"');
    return this.fuera(st, c);
  }

  /** Dentro de comillas: acumula y cierra al encontrar la misma comilla. */
  literal(st, c, cierreComilla) {
    if (c === cierreComilla) st.comilla = null;
    st.actual += c;
    this.i++;
    return false;
  }

  escape(st, c) {
    const esc = this.ps ? '`' : '\\';
    if (c !== esc || this.i + 1 >= this.s.length) return false;
    st.actual += c + this.s[this.i + 1];
    this.i += 2;
    return true;
  }

  sustitucion(st, c) {
    const dos = this.s.slice(this.i, this.i + 2);
    const proceso = !st.comilla && (dos === '<(' || dos === '>(');
    const abre = dos === '$(' || proceso || (!this.ps && c === '`');
    if (abre && this.nivel >= MAX_ANIDACION) {
      this.dudoso = true;
      return false;
    }
    if (dos === '$(' || proceso) {
      const inicio = (this.i += 2);
      this.nivel++;
      agrega(this.subs, this.bloque(')'));
      this.nivel--;
      if (/\bcase\b/.test(this.s.slice(inicio, this.i))) this.dudoso = true;
      st.actual += `${dos} )`;
      return true;
    }
    if (!abre) return false;
    this.comillaInvertida();
    st.actual += '` `';
    return true;
  }

  /** Cuerpo de un backtick de bash: hasta el siguiente backtick sin escapar. */
  comillaInvertida() {
    let j = this.i + 1;
    while (j < this.s.length && this.s[j] !== '`') j += this.s[j] === '\\' ? 2 : 1;
    if (j >= this.s.length) this.dudoso = this.finInvertida = true;
    const cuerpo = this.s.slice(this.i + 1, j).replace(/\\([`\\$])/g, '$1');
    const interior = trocear(cuerpo, false, this.nivel + 1);
    agrega(this.subs, interior.trozos);
    if (interior.dudoso) this.dudoso = true;
    this.i = Math.min(j + 1, this.s.length);
  }

  fuera(st, c) {
    // `$'...'` de bash: dentro, `\'` es una comilla escapada que este
    // escaner leeria como cierre. No se modela: es duda.
    if (c === "'" && !this.ps && this.s[this.i - 1] === '$') this.dudoso = true;
    if (c === "'" || c === '"') {
      st.comilla = c;
      st.actual += c;
      this.i++;
      return false;
    }
    if (this.comentario(c)) return false;
    if (st.cierre && c === ')' && st.prof === 0) {
      this.i++;
      return true;
    }
    if (st.cierre && c === '(') st.prof++;
    if (st.cierre && c === ')') st.prof--;
    const dos = this.s.slice(this.i, this.i + 2);
    // En PowerShell `(…)` ejecuta su contenido tambien como argumento
    // (`echo (python x.py)`) y `{…}` es un bloque (`% { python x.py }`): separan.
    const grupoPs = this.ps && '(){}'.includes(c);
    const largo = dos === '&&' || dos === '||' ? 2 : SEPARADORES.has(c) || grupoPs ? 1 : 0;
    if (largo) {
      st.trozos.push(st.actual);
      st.actual = '';
      this.i += largo;
      return false;
    }
    st.actual += c;
    this.i++;
    return false;
  }

  /** Salta un comentario (sin consumir el `\n` final, que separa). */
  comentario(c) {
    const s = this.s;
    if (this.ps && s.startsWith('<#', this.i)) {
      const fin = s.indexOf('#>', this.i + 2);
      if (fin < 0) this.dudoso = this.finComentario = true;
      this.i = fin < 0 ? s.length : fin + 2;
      return true;
    }
    if (c !== '#' || (this.i > 0 && !/[\s;&|(]/.test(s[this.i - 1]))) return false;
    const fin = s.indexOf('\n', this.i);
    if (fin < 0) this.finComentario = true;
    this.i = fin < 0 ? s.length : fin;
    return true;
  }
}

/**
 * Trocea `texto` en un dialecto: trozos del nivel superior mas los de cada
 * sustitucion de comando.
 * @returns {{trozos: string[], dudoso: boolean}}
 */
function trocear(texto, ps, nivel = 0) {
  const e = new Escaner(String(texto || ''), ps, nivel);
  const trozos = e.bloque(null);
  return { trozos: agrega(trozos, e.subs), dudoso: e.dudoso };
}

/**
 * Quita el CUERPO de los here-docs y here-strings, dejando solo la linea que
 * los abre. Lo de dentro son datos que van por stdin, no comandos: sin esto,
 * un `uv run python - <<'PY' … PY` se bloqueaba a si mismo porque el
 * terminador `PY` parecia una invocacion del launcher `py`, y el mensaje de un
 * commit que citara `python x.py` tambien saltaba.
 *
 * Solo se quita lo que abre de forma inequivoca (ver cabecera): quitar es lo
 * unico que puede ocultar un comando, asi que ante la duda no se quita.
 *
 * @param {string} cmd
 * @param {Array<'bash'|'ps'|'cmd'>} [dialectos]
 * @returns {{texto: string, cerrado: boolean}} cerrado=false si un here-doc
 *   no encuentra su terminador o hay demasiados (duda)
 */
function sinHeredocs(cmd, dialectos = ['bash', 'ps']) {
  const lineas = String(cmd || '').split('\n');
  const out = [];
  let previo = '';
  let cerrar = null;
  let aperturas = 0;
  for (const linea of lineas) {
    let visible = linea;
    if (cerrar) {
      // El here-string de PowerShell cierra con `'@` en la columna 0 y puede
      // seguir codigo (`'@; Write-Host $x`): lo que va detras se queda a la vista.
      const cierraHereString = HERE_STRING_CIERRES.has(cerrar) && linea.startsWith(cerrar);
      if (linea.trim() !== cerrar && !cierraHereString) continue;
      cerrar = null;
      if (!cierraHereString) continue;
      visible = linea.slice(cierreLargo);
    }
    out.push(visible);
    previo = previo ? `${previo}\n${visible}` : visible;
    cerrar = aperturaHeredoc(previo, visible, dialectos);
    if (cerrar && ++aperturas > MAX_HEREDOCS) return { texto: String(cmd || ''), cerrado: false };
  }
  return { texto: out.join('\n'), cerrado: cerrar === null };
}

/**
 * Terminador del here-doc (bash) o here-string (PowerShell) que abre `linea`,
 * o null si no abre ninguno de forma inequivoca.
 * @param {string} previo texto visible hasta esta linea incluida
 */
function aperturaHeredoc(previo, linea, dialectos) {
  // Mismas expresiones y terminador que HEAD (cf5d94a3): lo que aqui se quita
  // es siempre un subconjunto de lo que HEAD quitaba.
  const base = previo.length - linea.length;
  const doc = linea.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
  if (doc) {
    const raro = /[<\\]/.test(linea[doc.index - 1] || '') || /<<<|\(\(|\[\[|\blet\b/.test(linea);
    const ok = dialectos.includes('bash') && !raro;
    return ok && fueraDeTodo(previo.slice(0, base + doc.index), false) ? doc[2] : null;
  }
  const str = linea.match(/@['"]\s*$/);
  if (!str || !dialectos.includes('ps') || linea[str.index - 1] === '`') return null;
  const fin = linea.includes('@"') ? '"@' : "'@";
  if (fin[0] !== linea[str.index + 1]) return null;
  return fueraDeTodo(previo.slice(0, base + str.index), true) ? fin : null;
}

/** true si al final de `prefijo` no queda comilla, comentario ni backtick abierto. */
function fueraDeTodo(prefijo, ps) {
  const e = new Escaner(prefijo, ps);
  e.bloque(null);
  return !e.finComilla && !e.finComentario && !e.finInvertida;
}

/** Duda que no depende del troceo: lo que el escaner no modela. */
function dudaLexica(texto, dialectos) {
  return dialectos.includes('cmd') || COMILLAS_TIPOGRAFICAS.test(texto) || texto.includes('--%');
}

/**
 * Comandos que ejecuta `cmd`, ya recortados y sin repetidos.
 *
 * @param {string} cmd
 * @param {Array<'bash'|'ps'|'cmd'>} [dialectos] uno o varios; con varios se
 *   une lo que da cada uno. 'cmd' (comandos interiores, dialecto desconocido)
 *   no tiene troceo con comillas: fuerza la duda.
 * @returns {string[]}
 */
function segmentos(cmd, dialectos = ['bash']) {
  const original = String(cmd || '');
  const { texto, cerrado } = sinHeredocs(original, dialectos);
  const lista = [];
  let dudoso = !cerrado || dudaLexica(texto, dialectos);
  for (const d of dialectos) {
    if (d === 'cmd') continue;
    const r = trocear(texto, d === 'ps');
    agrega(lista, r.trozos);
    dudoso = dudoso || r.dudoso;
  }
  if (dudoso) {
    const entero = cerrado ? texto : original;
    agrega(lista, entero.split(SEPARADORES_HEAD));
    agrega(lista, entero.split(SEPARADORES_INGENUOS));
  }
  return [...new Set(lista.map((s) => s.trim()).filter(Boolean))];
}

module.exports = { segmentos, trocear, sinHeredocs };
