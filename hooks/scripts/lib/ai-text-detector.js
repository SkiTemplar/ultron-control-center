// hooks/scripts/lib/ai-text-detector.js — matcher Node del detector de texto IA.
//
// MISMA fuente de verdad que el Lab del Control Center (tfg_lab.rs):
// `~/.ultron/docs/research/patrones-texto-ia.json`. Este módulo NO define
// patrones propios: ejecuta las `senales_ejecutables` (lexico/regex) que el
// catálogo declara, con la misma semántica de compilación que el Rust:
//   - "lexico" de UNA palabra  → \b<término>\b case-insensitive
//   - "lexico" multi-palabra   → contains case-insensitive
//   - "regex"                  → tal cual, ADAPTADA de sintaxis Rust a JS
//     (el catálogo escribe regex de Rust: el prefijo inline `(?i)` no existe
//     en JS y se traduce al flag 'i'; una regex intraducible se salta en
//     silencio, igual que el Rust degrada las que no compilan).
//
// Consumidor: ai-text-warn.js (hook PostToolUse) y cualquier skill que quiera
// analizar/reescribir bajo demanda.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { HEURISTICS, runHeuristic } = require('./ai-text-heuristics');

// Resolución del catálogo: instalación real primero (~/.ultron), y si no
// existe, el propio repo (este fichero vive en hooks/scripts/lib/ → tres
// niveles arriba está la raíz). Sin el fallback, los selftests del CI morían
// con ENOENT en un runner limpio (checkout fuera de ~/.ultron) — el módulo no
// era hermético aunque el catálogo viajara en el repo (visto 2026-08-17).
const CATALOG_PATH = [
  path.join(os.homedir(), '.ultron', 'docs', 'research', 'patrones-texto-ia.json'),
  path.join(__dirname, '..', '..', '..', 'docs', 'research', 'patrones-texto-ia.json'),
].find((p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}) || path.join(__dirname, '..', '..', '..', 'docs', 'research', 'patrones-texto-ia.json');

/**
 * Cap de matches que se DEVUELVEN: el aviso resume, no inventaría.
 *
 * OJO — antes este cap rompía el bucle de reglas, no solo la lista: un texto
 * largo agotaba las 50 plazas con los primeros patrones y los demás no llegaban
 * a ejecutarse nunca. Medido el 2026-08-15 sobre 3.276 palabras de texto de
 * LLM: 3 patrones y densidad 1,53 con el cap, frente a 19 patrones y 8,16 sin
 * él. Es decir, cuanto más largo el texto, más se dormía el detector — justo al
 * revés de lo que debe pasar. Ahora se cuentan todos y se recorta la lista.
 */
const MAX_MATCHES = 50;
const EVIDENCE_CONTEXT = 30;

/**
 * Veredicto por DENSIDAD (decidido por el usuario 2026-09-11, sustituye al
 * "≥1 señal = IA" anterior). Gemelo de `calcular_veredicto` en tfg_lab.rs.
 *
 * MIN_WORDS: un texto corto no da margen estadístico ni al catálogo ni al
 * autor — por debajo se declara `no_concluyente` en vez de arriesgar un
 * "limpio" o un "IA" sin base.
 *
 * DENSITY_THRESHOLD y DENSITY_BAND: ajustados con leave-one-out sobre el
 * corpus propio (docs/research/corpus/, gitignorado; ver
 * `scripts/ai-text-eval.mjs`) el 2026-09-11 — 23 documentos IA / 6 humanos,
 * AMBOS por debajo de 30: la cifra es la mejor disponible, no una garantía.
 * El umbral que maximiza F1 en leave-one-out cae en 0,116-0,145 (media
 * 0,118) según qué documento se deja fuera — banda muy estable, pero nace de
 * solo 3 humanos con ≥ MIN_WORDS palabras. DENSITY_THRESHOLD=0.12 es ese
 * ajuste redondeado; DENSITY_BAND=0.03 cubre el rango de inestabilidad entre
 * pliegues (0,09-0,15) como zona de duda explícita en vez de forzar un
 * "limpio" o un "IA" donde el propio experimento no está seguro.
 */
const MIN_WORDS = 400;
const DENSITY_THRESHOLD = 0.12;
const DENSITY_BAND = 0.03;

/**
 * Tres estados a partir de palabras y densidad (señales/100 palabras SIN
 * contar las de rol "aviso", ver `compileRules`). `opts` permite overrides
 * puntuales (banco de medición, CLI) sin tocar los valores por defecto.
 */
function computeVerdict(words, densityPer100w, opts) {
  const minWords = (opts && opts.minWords) ?? MIN_WORDS;
  const threshold = (opts && opts.densityThreshold) ?? DENSITY_THRESHOLD;
  const band = (opts && opts.densityBand) ?? DENSITY_BAND;
  if (words < minWords) return 'no_concluyente';
  if (densityPer100w >= threshold + band) return 'probable_ia';
  if (densityPer100w < threshold - band) return 'sin_indicios';
  return 'no_concluyente';
}

function loadCatalog(catalogPath) {
  const p = catalogPath || CATALOG_PATH;
  const raw = fs.readFileSync(p, 'utf8');
  const doc = JSON.parse(raw);
  const patrones = Array.isArray(doc && doc.patrones) ? doc.patrones : [];
  return patrones;
}

/** Traduce una regex del catálogo (sintaxis Rust) a RegExp de JS, o null. */
function toJsRegex(source) {
  let src = String(source || '');
  let flags = 'gu';
  // Rust escribe los modificadores como prefijo inline `(?i)`, `(?m)`, `(?s)` o
  // combinados `(?im)`; JS no los soporta a nivel de patrón y se traducen a
  // flags. Antes solo se contemplaba `(?i)`: cualquier patrón con `(?m)` no
  // compilaba y se saltaba EN SILENCIO, de modo que vivía en el Lab (Rust sí
  // soporta el prefijo) y estaba muerto en el hook. Eso le pasaba al patrón
  // "Gerundio calcado del inglés", 0/2 en el audit de cobertura (2026-08-14).
  // Flags de Rust sin equivalente en JS (`x` extendido, `U` swap-greedy) siguen
  // cayendo al camino intraducible en vez de compilar algo que no es lo escrito.
  const inline = src.match(/^\(\?([a-zA-Z]+)\)/);
  if (inline) {
    const soportados = { i: 'i', m: 'm', s: 's' };
    const pedidos = [...inline[1]];
    if (pedidos.every((f) => soportados[f])) {
      src = src.slice(inline[0].length);
      for (const f of pedidos) {
        if (!flags.includes(soportados[f])) flags += soportados[f];
      }
    }
  }
  try {
    return new RegExp(src, flags);
  } catch {
    try {
      // Fallback sin flag unicode (algunos escapes de Rust chocan con 'u').
      return new RegExp(src, flags.replace('u', ''));
    } catch {
      return null; // intraducible: se degrada en silencio (mismo contrato que Rust)
    }
  }
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Vuelve un término léxico insensible a las tildes: cada vocal (acentuada o
 * no) pasa a una clase con todas sus variantes. Motivo medido (2026-08-15): el
 * catálogo escribía "en conclusión" y el texto real —borradores, material
 * pegado desde un PDF, gente que escribe sin tildes— decía "en conclusion", y
 * la señal no disparaba. Era la causa común de varios falsos negativos, no un
 * fallo de cada patrón por separado. La eñe NO se toca: convertirla en [nñ]
 * confundiría "ano" con "año".
 */
function acentoInsensible(src) {
  const CLASES = [
    ['a', '[aáàâä]'], ['e', '[eéèêë]'], ['i', '[iíìîï]'],
    ['o', '[oóòôö]'], ['u', '[uúùûü]'],
  ];
  let out = '';
  for (const ch of src) {
    // toLowerCase() Unicode antes de quitar el diacrítico: así "Á" y "á" caen
    // en la misma clase (el gemelo Rust hace lo mismo con to_lowercase()).
    const base = ch
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    const clase = CLASES.find(([letra]) => letra === base && /\p{L}/u.test(ch));
    out += clase ? clase[1] : ch;
  }
  return out;
}

/**
 * Detección de idioma del texto de entrada (heurística de ratio de
 * stopwords, sin dependencias nuevas). Objetivo único: decidir qué
 * subconjunto de `senales_ejecutables` marcadas "es"/"en"/"*" en el catálogo
 * tiene sentido ejecutar sobre ESTE texto (ver campo "idioma" del catálogo,
 * añadido 2026-09-14). NO es un detector de idioma de propósito general: no
 * reconoce mezcla real de idiomas ni terceros idiomas, y con texto corto o
 * sin stopwords reconocibles cae a "es" — el catálogo nació pensando en TFG
 * en español y ese es el sesgo más seguro cuando no hay evidencia clara (más
 * vale ejecutar de más un patrón "es" sobre un texto ambiguo que dejar de
 * ejecutarlo sobre un TFG real). Gemelo de `detectar_idioma` en tfg_lab.rs.
 */
const STOPWORDS_ES = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'en', 'y', 'a', 'que', 'un', 'una',
  'unos', 'unas', 'es', 'son', 'por', 'para', 'con', 'no', 'se', 'su', 'sus',
  'como', 'más', 'mas', 'pero', 'este', 'esta', 'estos', 'estas', 'al', 'lo',
  'le', 'les', 'muy', 'también', 'tambien', 'entre', 'sobre', 'sin', 'ya',
  'o', 'porque', 'cuando', 'donde', 'sí', 'si', 'nos', 'una', 'ha', 'han',
]);
const STOPWORDS_EN = new Set([
  'the', 'of', 'and', 'a', 'to', 'in', 'is', 'are', 'that', 'for', 'on',
  'with', 'as', 'this', 'it', 'by', 'an', 'be', 'was', 'were', 'from', 'or',
  'but', 'not', 'have', 'has', 'at', 'their', 'which', 'these', 'those',
  'its', 'we', 'you', 'they', 'been', 'can', 'will', 'into',
]);

/** Ratio de stopwords ES vs EN sobre las palabras del texto. Empate o sin
 * evidencia -> "es" (ver comentario de arriba). */
function detectarIdioma(text) {
  const tokens = String(text || '').toLowerCase().match(/\p{L}+/gu) || [];
  let es = 0;
  let en = 0;
  for (const t of tokens) {
    if (STOPWORDS_ES.has(t)) es += 1;
    else if (STOPWORDS_EN.has(t)) en += 1;
  }
  return en > es ? 'en' : 'es';
}

/** Compila las senales_ejecutables del catálogo. Una vez por escaneo. */
function compileRules(patrones) {
  const rules = [];
  patrones.forEach((patron, idx) => {
    const senales = Array.isArray(patron && patron.senales_ejecutables)
      ? patron.senales_ejecutables
      : [];
    // "rol" vive en el patrón, no en cada señal suelta: el catálogo declara
    // UNA vez que un patrón entero es contextual (p. ej. tricolon), no señal
    // a señal. Por defecto "senal" (cuenta para la densidad del veredicto).
    const rol = (patron && patron.rol) === 'aviso' ? 'aviso' : 'senal';
    // "idioma" vive igual en el patrón entero: "es"/"en" restringe la señal a
    // ese idioma del texto, "*" (o ausente, compatibilidad con catálogos
    // viejos) la deja correr siempre. Ver scan() para el filtrado real.
    const idioma = (patron && patron.idioma) || '*';
    // "alerta": el patrón se comunica al autor aunque sea rol "aviso" y no haya
    // señales (caracteres invisibles). No toca densidad ni veredicto; solo lo
    // lee el hook ai-text-warn.js.
    const alerta = Boolean(patron && patron.alerta);
    for (const senal of senales) {
      const tipo = (senal && senal.tipo) || '';
      const valor = (senal && senal.valor) || '';
      if (!valor) continue;
      let re = null;
      let label = '';
      if (tipo === 'lexico') {
        const esc = acentoInsensible(escapeForRegex(valor));
        const src = valor.trim().split(/\s+/).length === 1 ? `\\b${esc}\\b` : esc;
        re = toJsRegex(`(?i)${src}`);
        label = `lexico:${valor}`;
      } else if (tipo === 'regex') {
        re = toJsRegex(valor);
        const nota = (senal && senal.nota) || '';
        label = `regex:${nota || valor}`;
      } else if (tipo === 'heuristica') {
        // Señal estructural: no es un regex sino una regla sobre la forma del
        // texto (longitudes, puntuación, cadenas de sinónimos). Ver
        // ai-text-heuristics.js; la misma id existe en tfg_lab.rs.
        if (!HEURISTICS[valor]) continue; // id desconocida: se degrada en silencio
        rules.push({
          patternIdx: idx,
          pattern: (patron && patron.nombre) || `patron-${idx}`,
          correction: (patron && patron.correccion) || '',
          label: `heuristica:${valor}`,
          heuristic: valor,
          rol,
          idioma,
          alerta,
        });
        continue;
      } else {
        continue; // tipo desconocido: el catálogo manda
      }
      if (re) {
        rules.push({
          patternIdx: idx,
          pattern: (patron && patron.nombre) || `patron-${idx}`,
          correction: (patron && patron.correccion) || '',
          label,
          re,
          rol,
          idioma,
          alerta,
        });
      }
    }
  });
  return rules;
}

/** Normaliza un nombre de patrón para comparar sin depender de tildes/mayúsculas. */
function patternKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[áàäâ]/g, 'a')
    .replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u');
}

/**
 * Escanea `text` contra el catálogo. Devuelve la misma forma que TfgReport:
 * { matches, patterns_hit, total_patterns_scanned, words, density_per_100w,
 *   senales_total, avisos_total, veredicto, motivo_no_concluyente }.
 *
 * `opts.skipPatterns` desactiva patrones por nombre (substring normalizado).
 * Los patrones saltados NO cuentan para `total_patterns_scanned` ni para la
 * densidad: el informe describe lo que de verdad se miró. Se usa para el
 * destino Markdown, donde la negrita y el guion largo son sintaxis legítima y
 * no artefactos de haber pegado la salida de un chatbot.
 *
 * `opts.minWords`/`opts.densityThreshold`/`opts.densityBand` pasan a
 * `computeVerdict` (overrides puntuales; ver esa función para los valores por
 * defecto y de dónde salen).
 *
 * `opts.idioma` fuerza el idioma del texto ("es"/"en") en vez de detectarlo
 * con `detectarIdioma` (uso: tests y bancos de medición que ya conocen el
 * idioma real del corpus). Solo corren las señales cuyo patrón declara
 * `idioma ∈ {idiomaTexto, "*"}`; las de otro idioma se descartan igual que un
 * `skipPatterns`, ANTES de contar `total_patterns_scanned`.
 */
function scan(text, patrones, opts) {
  const src = String(text || '');
  const cat = patrones || loadCatalog();
  const skip = ((opts && opts.skipPatterns) || []).map(patternKey).filter(Boolean);
  const idiomaTexto = (opts && opts.idioma) || detectarIdioma(src);
  let rules = compileRules(cat);
  rules = rules.filter((r) => r.idioma === '*' || r.idioma === idiomaTexto);
  if (skip.length) {
    rules = rules.filter((r) => !skip.some((s) => patternKey(r.pattern).includes(s)));
  }
  const scannedPatterns = new Set(rules.map((r) => r.patternIdx));
  const hitPatterns = new Set();
  const matches = [];
  let totalSenal = 0; // hallazgos de rol "senal": cuentan para densidad/veredicto
  let totalAviso = 0; // hallazgos de rol "aviso": se listan, no cuentan

  const push = (rule, start, end) => {
    if (rule.rol === 'aviso') totalAviso += 1;
    else totalSenal += 1;
    hitPatterns.add(rule.patternIdx);
    if (matches.length >= MAX_MATCHES) return;
    matches.push({
      pattern: rule.pattern,
      rule: rule.label,
      evidence: src.slice(Math.max(0, start - EVIDENCE_CONTEXT), Math.min(src.length, end + EVIDENCE_CONTEXT)).trim(),
      start,
      end,
      correction: rule.correction,
      rol: rule.rol,
      alerta: rule.alerta,
    });
  };

  // Ninguna regla se salta: el cap recorta la lista, no la exploración.
  for (const rule of rules) {
    if (rule.heuristic) {
      for (const span of runHeuristic(rule.heuristic, src) || []) {
        push(rule, span.start, span.end);
      }
      continue;
    }
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src)) !== null) {
      if (m[0] === '') { rule.re.lastIndex++; continue; } // nunca bucle infinito
      push(rule, m.index, m.index + m[0].length);
    }
  }

  const words = src.trim() ? src.trim().split(/\s+/).length : 0;
  const total = totalSenal + totalAviso;
  // La densidad se calcula sobre el TOTAL de señales (rol "senal"), no sobre
  // la lista recortada ni sobre los avisos: si no, un texto largo salía con
  // menos densidad que uno corto igual de malo, y un tricolon suelto inflaba
  // el veredicto de un texto humano.
  const density_per_100w = words > 0 ? (totalSenal * 100) / words : 0;
  const veredicto = computeVerdict(words, density_per_100w, opts);
  const motivo_no_concluyente =
    veredicto === 'no_concluyente' ? (words < ((opts && opts.minWords) ?? MIN_WORDS) ? 'pocas_palabras' : 'densidad_ambigua') : null;

  return {
    matches,
    matches_total: total,
    matches_truncated: total > matches.length,
    patterns_hit: hitPatterns.size,
    total_patterns_scanned: scannedPatterns.size,
    words,
    senales_total: totalSenal,
    avisos_total: totalAviso,
    density_per_100w,
    veredicto,
    motivo_no_concluyente,
    idioma_detectado: idiomaTexto,
  };
}

// Patrones que describen "he pegado la salida del chatbot en un formato que NO
// es Markdown". En un destino .md son sintaxis legitima, no artefactos.
const MARKDOWN_NATIVE_PATTERNS = ['artefactos de markup', 'guion largo'];

module.exports = {
  loadCatalog,
  compileRules,
  scan,
  patternKey,
  detectarIdioma,
  MARKDOWN_NATIVE_PATTERNS,
  CATALOG_PATH,
  computeVerdict,
  MIN_WORDS,
  DENSITY_THRESHOLD,
  DENSITY_BAND,
};
