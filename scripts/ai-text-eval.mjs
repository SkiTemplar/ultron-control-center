#!/usr/bin/env node
/**
 * ai-text-eval.mjs — banco de medicion del detector de texto IA.
 *
 * Por que existe: el catalogo (docs/research/patrones-texto-ia.json) se venia
 * ampliando por intuicion, sin saber que patron aporta y cual no dispara nunca.
 * Medido el 2026-08-23 sobre 5.700 palabras de texto generado por IA en
 * espanol, solo 1 de los 31 patrones se activo. Un patron nuevo sin medir es
 * una hipotesis, no una mejora.
 *
 * Que mide, por PATRON:
 *   - cobertura        : documentos IA en los que dispara (recall del patron)
 *   - falsos positivos : documentos humanos en los que dispara
 *   - senales/1k       : densidad de senales por mil palabras en el corpus IA
 *
 * Que mide, por DOCUMENTO (decidido 2026-09-11 — "densidad + tricolon como
 * aviso + validacion"): el veredicto ya NO es "≥1 senal" sino tres estados
 * por DENSIDAD (senales/100 palabras, sin contar las de rol "aviso" como
 * tricolon — ver computeVerdict en ai-text-detector.js):
 *   - probable_ia     : densidad >= umbral + banda
 *   - sin_indicios    : densidad <  umbral - banda
 *   - no_concluyente  : menos de MIN_WORDS palabras, o densidad dentro de la
 *                       banda de duda alrededor del umbral
 *
 * Con un corpus tan pequeño, fijar el umbral y medirlo sobre los MISMOS datos
 * es hacer trampa (el numero solo describe lo que ya se vio). Este script
 * hace LEAVE-ONE-OUT: para cada documento se elige el mejor umbral con el
 * RESTO del corpus (maximizando F1 sobre los documentos decidibles del
 * pliegue) y se clasifica el documento que quedo fuera con ese umbral. El
 * resultado agregado es la unica cifra honesta con este tamano de muestra.
 *
 * El corpus vive fuera del repo (docs/research/corpus/, gitignorado): es texto
 * personal. Estructura, una carpeta por clase e idioma:
 *
 *   docs/research/corpus/ia/*.{md,txt}          -> texto IA en espanol
 *   docs/research/corpus/humano/*.{md,txt}      -> texto humano en espanol
 *   docs/research/corpus/ia-en/*.{md,txt}       -> texto IA en ingles
 *   docs/research/corpus/humano-en/*.{md,txt}   -> texto humano en ingles
 *
 * La extension importa: en `.md` el detector exime los patrones de markup, que
 * ahi son sintaxis legitima y no artefactos. Guarda cada muestra con la
 * extension del destino real donde ese texto viviria.
 *
 * Idioma (2026-09-14): el catalogo (docs/research/patrones-texto-ia.json)
 * declara un campo "idioma" por patron ("es"/"en"/"*"). `scan()` (en
 * ai-text-detector.js) solo ejecuta las senales_ejecutables de un patron
 * cuyo idioma coincide con el del documento o es "*" (independiente de
 * idioma). Este script le pasa el idioma real del documento (la carpeta del
 * corpus ya lo fija) en vez de dejar que `scan` lo adivine, para medir el
 * filtro sin la incertidumbre añadida de la heuristica de deteccion.
 *
 * Uso:
 *   node scripts/ai-text-eval.mjs                     # espanol (default, cifra historica)
 *   node scripts/ai-text-eval.mjs --lang en            # solo corpus ingles
 *   node scripts/ai-text-eval.mjs --lang all --docs    # ambos + agregado, tabla por documento
 *   node scripts/ai-text-eval.mjs --umbral 0.15         # otro umbral de densidad (gate "real")
 *   node scripts/ai-text-eval.mjs --banda 0.05          # otra banda de duda (gate "real")
 *   node scripts/ai-text-eval.mjs --min-palabras 300    # otro minimo de palabras (gate "real")
 *   node scripts/ai-text-eval.mjs --json                # salida cruda
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RAIZ = path.join(os.homedir(), '.ultron');
const { scan, loadCatalog, patternKey, MARKDOWN_NATIVE_PATTERNS, computeVerdict, MIN_WORDS, DENSITY_THRESHOLD, DENSITY_BAND } = require(
  path.join(RAIZ, 'hooks', 'scripts', 'lib', 'ai-text-detector.js')
);

// AI_TEXT_EVAL_CORPUS: override del directorio de corpus, solo para el
// selftest (ai-text-eval.selftest.mjs) — apunta a un corpus de fixtures en
// temporal para no leer ni mutar nunca el corpus real (personal, gitignorado).
const CORPUS = process.env.AI_TEXT_EVAL_CORPUS
  ? path.resolve(process.env.AI_TEXT_EVAL_CORPUS)
  : path.join(RAIZ, 'docs', 'research', 'corpus');
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const DOCS_FLAG = args.includes('--docs');
const flag = (nombre, porDefecto) => {
  const i = args.indexOf(nombre);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : porDefecto;
};
const UMBRAL = flag('--umbral', DENSITY_THRESHOLD);
const BANDA = flag('--banda', DENSITY_BAND);
const MIN_PALABRAS = flag('--min-palabras', MIN_WORDS);
// Compat: el --umbral antiguo era un conteo de señales (>=1). Si alguien lo
// sigue pasando como entero grande, seguiria funcionando como densidad (solo
// cambia la escala), asi que no hace falta migracion aparte.

// --- --lang: default "es" para no mover la cifra historica ------------------
const LANG_VALIDOS = ['es', 'en', 'all'];
const langIdx = args.indexOf('--lang');
const LANG_RAW = langIdx >= 0 ? args[langIdx + 1] : 'es';
if (!LANG_VALIDOS.includes(LANG_RAW)) {
  console.error(`--lang invalido: "${LANG_RAW}". Valores validos: ${LANG_VALIDOS.join(', ')}.`);
  process.exit(1);
}
const LANGS = LANG_RAW === 'all' ? ['es', 'en'] : [LANG_RAW];
const DIR_POR_LANG = {
  es: { ia: 'ia', humano: 'humano' },
  en: { ia: 'ia-en', humano: 'humano-en' },
};

const MIN_DOCS_POR_CLASE = 30;

function cargar(subdir, lang) {
  const dir = path.join(CORPUS, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(md|txt)$/i.test(f))
    .map((f) => {
      const ruta = path.join(dir, f);
      const texto = fs.readFileSync(ruta, 'utf8');
      return {
        nombre: f,
        lang,
        ext: path.extname(f).toLowerCase(),
        texto,
        palabras: texto.split(/\s+/).filter(Boolean).length,
      };
    })
    .filter((d) => d.palabras > 0);
}

// El catalogo se carga UNA vez: `scan` lo recompila en cada llamada si no se le
// pasa, y con un corpus grande eso multiplica el trabajo por documento.
const CATALOGO = loadCatalog();

/** Nombres de TODOS los patrones del catalogo, hayan disparado o no. */
const TODOS_LOS_PATRONES = (
  Array.isArray(CATALOGO) ? CATALOGO : CATALOGO.patrones || CATALOGO.patterns || []
).map((p) => p.id || p.nombre || p.name || '(sin id)');

/** Nombre -> rol ("senal"/"aviso"), para marcar la tabla por patron. */
const ROL_POR_PATRON = new Map(
  (Array.isArray(CATALOGO) ? CATALOGO : CATALOGO.patrones || CATALOGO.patterns || []).map((p) => [
    p.nombre,
    p.rol === 'aviso' ? 'aviso' : 'senal',
  ])
);

/** El catalogo declara idioma por patron? Desde 2026-09-14 SI (campo "idioma"
 * en cada patron: "es"/"en"/"*"). Se deja el check en vez de asumirlo para que
 * un catalogo viejo (sin el campo) siga midiendo sin romperse. */
const PATRONES_RAW = Array.isArray(CATALOGO) ? CATALOGO : CATALOGO.patrones || CATALOGO.patterns || [];
const CATALOGO_TIENE_IDIOMA = PATRONES_RAW.some((p) => p && typeof p.idioma !== 'undefined');

/** Ejecuta el detector con la misma semantica que el hook y el CLI. El filtro
 * de idioma vive DENTRO de `scan` (ver detectarIdioma/idioma en
 * ai-text-detector.js): aqui se le pasa `opts.idioma = doc.lang` porque el
 * corpus ya trae el idioma real de cada documento por la carpeta en la que
 * vive (ia/humano vs ia-en/humano-en) — mas fiable que re-detectarlo desde el
 * propio texto, que es lo que hace el hook en produccion cuando no lo sabe. */
function analizar(doc) {
  const res = scan(doc.texto, CATALOGO, {
    skipPatterns: doc.ext === '.md' ? MARKDOWN_NATIVE_PATTERNS : [],
    idioma: doc.lang,
  });
  const matches = res?.matches || res?.senales || [];
  const porPatron = new Map();
  for (const m of matches) {
    const k = m.pattern || m.id || m.regla || '(sin id)';
    porPatron.set(k, (porPatron.get(k) || 0) + 1);
  }
  return {
    total: matches.length,
    porPatron,
    palabras: res.words,
    densidad: res.density_per_100w,
    senalesTotal: res.senales_total,
    avisosTotal: res.avisos_total,
  };
}

/** Ejecuta el detector con la misma semantica que el hook y el CLI. */
function clasificar(doc, umbral, banda, minPalabras) {
  return computeVerdict(doc.palabras, doc.r.densidad, { densityThreshold: umbral, densityBand: banda, minWords: minPalabras });
}

function metricas(docs, umbral, banda, minPalabras) {
  let vp = 0, fn = 0, fp = 0, vn = 0, noconc = 0;
  for (const d of docs) {
    const v = clasificar(d, umbral, banda, minPalabras);
    if (v === 'no_concluyente') { noconc++; continue; }
    const esIa = v === 'probable_ia';
    if (d.clase === 'ia' && esIa) vp++;
    else if (d.clase === 'ia' && !esIa) fn++;
    else if (d.clase === 'humano' && esIa) fp++;
    else vn++;
  }
  const precision = vp + fp ? vp / (vp + fp) : 0;
  const recall = vp + fn ? vp / (vp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { vp, fn, fp, vn, noconc, precision, recall, f1 };
}

/**
 * Umbral que maximiza F1 sobre `subset` (banda y min. de palabras fijos: solo
 * se re-ajusta el centro, que es el hiperparametro que este corpus puede
 * permitirse estimar sin sobreajustar aun mas). Candidatos = puntos medios
 * entre densidades distintas de los documentos DECIDIBLES (>= minPalabras),
 * que es donde puede estar la frontera optima. Empate -> el mas cercano al
 * DENSITY_THRESHOLD de partida (0.12), para no elegir un extremo arbitrario.
 */
function mejorUmbral(subset, banda, minPalabras) {
  const elegibles = subset.filter((d) => d.palabras >= minPalabras);
  const densidades = [...new Set(elegibles.map((d) => d.r.densidad))].sort((a, b) => a - b);
  const candidatos = [0];
  for (let i = 0; i < densidades.length - 1; i++) candidatos.push((densidades[i] + densidades[i + 1]) / 2);
  candidatos.push((densidades[densidades.length - 1] || 0) + 0.1);

  let mejor = { umbral: DENSITY_THRESHOLD, f1: -1, errores: Infinity };
  for (const u of candidatos) {
    const m = metricas(subset, u, banda, minPalabras);
    const errores = m.fn + m.fp;
    const mejora =
      m.f1 > mejor.f1 ||
      (m.f1 === mejor.f1 && errores < mejor.errores) ||
      (m.f1 === mejor.f1 && errores === mejor.errores && Math.abs(u - DENSITY_THRESHOLD) < Math.abs(mejor.umbral - DENSITY_THRESHOLD));
    if (mejora) mejor = { umbral: u, f1: m.f1, errores };
  }
  return mejor.umbral;
}

/** Motivo de no_concluyente, con la MISMA regla que motivo_no_concluyente en
 * ai-text-detector.js pero contra el umbral/banda/min-palabras de ESTE banco
 * (que pueden venir de --umbral/--banda/--min-palabras, no siempre el default). */
function motivoNoConcluyente(doc, minPalabras) {
  return doc.palabras < minPalabras ? 'longitud' : 'banda';
}

/**
 * Construye el informe completo (tabla por patron, veredicto real,
 * leave-one-out y detalle por documento) para un conjunto ia/humano dado.
 * No imprime nada: es puro calculo, para poder reusarlo en es/en/all.
 */
function construirInforme(ia, humano, etiqueta) {
  const patrones = new Set();
  for (const d of [...ia, ...humano]) for (const k of d.r.porPatron.keys()) patrones.add(k);

  const palabrasIa = ia.reduce((a, d) => a + d.palabras, 0) || 1;
  const filas = [...patrones]
    .map((p) => {
      const docsIa = ia.filter((d) => d.r.porPatron.has(p)).length;
      const docsHum = humano.filter((d) => d.r.porPatron.has(p)).length;
      const senalesIa = ia.reduce((a, d) => a + (d.r.porPatron.get(p) || 0), 0);
      return {
        patron: p,
        rol: ROL_POR_PATRON.get(p) || 'senal',
        cobertura: ia.length ? docsIa / ia.length : 0,
        falsosPositivos: humano.length ? docsHum / humano.length : 0,
        senalesPor1k: (senalesIa / palabrasIa) * 1000,
        docsIa,
        docsHum,
      };
    })
    .sort((a, b) => b.cobertura - a.cobertura || b.senalesPor1k - a.senalesPor1k);

  const todos = [...ia, ...humano];
  const real = metricas(todos, UMBRAL, BANDA, MIN_PALABRAS);

  const umbralTodoElCorpus = mejorUmbral(todos, BANDA, MIN_PALABRAS);
  const pliegues = todos.map((_, i) => mejorUmbral(todos.filter((_, j) => j !== i), BANDA, MIN_PALABRAS));
  const mediaPliegues = pliegues.reduce((a, b) => a + b, 0) / (pliegues.length || 1);
  const desvPliegues = Math.sqrt(
    pliegues.reduce((a, b) => a + (b - mediaPliegues) ** 2, 0) / (pliegues.length || 1)
  );

  let looVp = 0, looFn = 0, looFp = 0, looVn = 0, looNoconc = 0;
  const looDetalle = [];
  for (let i = 0; i < todos.length; i++) {
    const held = todos[i];
    const resto = todos.filter((_, j) => j !== i);
    const umbralPliegue = mejorUmbral(resto, BANDA, MIN_PALABRAS);
    const v = clasificar(held, umbralPliegue, BANDA, MIN_PALABRAS);
    if (v === 'no_concluyente') looNoconc++;
    else if (held.clase === 'ia' && v === 'probable_ia') looVp++;
    else if (held.clase === 'ia' && v !== 'probable_ia') looFn++;
    else if (held.clase === 'humano' && v === 'probable_ia') looFp++;
    else looVn++;
    looDetalle.push({ nombre: held.nombre, lang: held.lang, clase: held.clase, palabras: held.palabras, densidad: Number(held.r.densidad.toFixed(3)), umbral_pliegue: Number(umbralPliegue.toFixed(3)), veredicto: v });
  }
  const looPrecision = looVp + looFp ? looVp / (looVp + looFp) : 0;
  const looRecall = looVp + looFn ? looVp / (looVp + looFn) : 0;
  const looF1 = looPrecision + looRecall ? (2 * looPrecision * looRecall) / (looPrecision + looRecall) : 0;

  const advertenciaMuestra = ia.length < MIN_DOCS_POR_CLASE || humano.length < MIN_DOCS_POR_CLASE;

  const detalleDocs = todos
    .map((d) => {
      const v = clasificar(d, UMBRAL, BANDA, MIN_PALABRAS);
      return {
        nombre: d.nombre,
        lang: d.lang,
        clase: d.clase,
        palabras: d.palabras,
        densidad: Number(d.r.densidad.toFixed(3)),
        veredicto: v,
        motivo: v === 'no_concluyente' ? motivoNoConcluyente(d, MIN_PALABRAS) : null,
      };
    })
    .sort((a, b) => a.clase.localeCompare(b.clase) || a.nombre.localeCompare(b.nombre));

  const vistos = new Set([...patrones].map(patternKey));
  const inertes = TODOS_LOS_PATRONES.filter((p) => !vistos.has(patternKey(p)));

  return {
    etiqueta,
    corpus: { ia: ia.length, humano: humano.length, palabrasIa, advertenciaMuestra, minDocsPorClase: MIN_DOCS_POR_CLASE },
    veredicto_real: real,
    patrones: filas,
    patrones_inertes: inertes,
    leave_one_out: {
      umbral_todo_el_corpus: umbralTodoElCorpus,
      estabilidad_pliegues: { min: Math.min(...pliegues), max: Math.max(...pliegues), media: mediaPliegues, desviacion: desvPliegues },
      resultado: { vp: looVp, fn: looFn, fp: looFp, vn: looVn, no_concluyente: looNoconc, precision: looPrecision, recall: looRecall, f1: looF1 },
      detalle: looDetalle,
    },
    detalle_docs: detalleDocs,
  };
}

const pct = (x) => `${(x * 100).toFixed(0)}%`.padStart(4);

function imprimirInforme(rep) {
  console.log(`\n=== Idioma: ${rep.etiqueta} ===`);
  console.log(`Corpus: ${rep.corpus.ia} doc IA (${rep.corpus.palabrasIa} palabras) · ${rep.corpus.humano} doc humano`);
  if (rep.corpus.advertenciaMuestra) {
    console.log(
      `ADVERTENCIA: menos de ${rep.corpus.minDocsPorClase} documentos en al menos una clase (IA=${rep.corpus.ia}, humano=${rep.corpus.humano}). ` +
        'El umbral ajustado aqui es la mejor cifra disponible, no una garantia estadistica — no tratarlo como definitivo.',
    );
  }
  if (rep.etiqueta !== 'es' && !CATALOGO_TIENE_IDIOMA) {
    console.log(
      'NOTA: el catalogo (patrones-texto-ia.json) NO distingue idioma por patron (sin campo "idioma"). ' +
        'Se aplican TODOS los patrones a este corpus, aunque la mayoria estan redactados pensando en espanol/calcos al espanol. ' +
        'La fila "falsoPos" de la tabla de abajo, sobre el corpus humano en ingles, es la medida real de ese ruido.',
    );
  }
  console.log(`\nVeredicto real (config desplegada): umbral=${UMBRAL} banda=${BANDA} min_palabras=${MIN_PALABRAS}\n`);
  console.log('PATRON                                          rol     cobertura  falsoPos  senales/1k');
  console.log('-'.repeat(92));
  for (const f of rep.patrones) {
    console.log(
      `${f.patron.slice(0, 46).padEnd(46)}  ${f.rol.padEnd(6)}  ${pct(f.cobertura)}      ${pct(f.falsosPositivos)}      ${f.senalesPor1k.toFixed(2)}`
    );
  }
  if (rep.patrones_inertes.length) {
    console.log(`\n--- ${rep.patrones_inertes.length} de ${TODOS_LOS_PATRONES.length} patrones sin un solo disparo en este corpus ---`);
    for (const p of rep.patrones_inertes) console.log(`   · ${String(p).slice(0, 70)}`);
  }
  if (rep.etiqueta !== 'es') {
    const ruido = rep.patrones.filter((f) => f.docsHum > 0);
    if (ruido.length) {
      console.log(`\n--- Patrones que disparan en humano-${rep.etiqueta === 'all' ? '*' : rep.etiqueta} (falsos positivos; con filtro de idioma, deberian ser sobre todo patrones "*") ---`);
      for (const f of ruido) console.log(`   · ${f.patron.slice(0, 60)} — ${f.docsHum} doc(s) humano`);
    }
  }
  console.log('\n--- Veredicto a nivel documento (config desplegada) ---');
  console.log(`  IA detectada      : ${rep.veredicto_real.vp}/${rep.corpus.ia}`);
  console.log(`  IA que se cuela   : ${rep.veredicto_real.fn}`);
  console.log(`  Humano acusado    : ${rep.veredicto_real.fp}/${rep.corpus.humano}`);
  console.log(`  No concluyente    : ${rep.veredicto_real.noconc}`);
  console.log(`  precision ${rep.veredicto_real.precision.toFixed(2)} · recall ${rep.veredicto_real.recall.toFixed(2)} · F1 ${rep.veredicto_real.f1.toFixed(2)}`);

  if (DOCS_FLAG) {
    console.log('\n--- Detalle por documento ---');
    console.log('IDIOMA  CLASE   PALABRAS  DENSIDAD  VEREDICTO         MOTIVO_NO_CONCLUYENTE     DOC');
    console.log('-'.repeat(100));
    for (const d of rep.detalle_docs) {
      console.log(
        `${d.lang.padEnd(6)}  ${d.clase.padEnd(6)}  ${String(d.palabras).padStart(8)}  ${d.densidad.toFixed(3).padStart(8)}  ${d.veredicto.padEnd(16)}  ${(d.motivo || '-').padEnd(24)}  ${d.nombre}`
      );
    }
    const noConc = rep.detalle_docs.filter((d) => d.veredicto === 'no_concluyente');
    const porLongitud = noConc.filter((d) => d.motivo === 'longitud').length;
    const porBanda = noConc.filter((d) => d.motivo === 'banda').length;
    console.log(`\n  No concluyentes: ${noConc.length} total (${porLongitud} por longitud < ${MIN_PALABRAS} palabras, ${porBanda} por densidad dentro de la banda)`);
  }

  console.log('\n--- Leave-one-out (umbral elegido SOLO con el resto del corpus, por documento) ---');
  console.log(`  Umbral con TODO el corpus : ${rep.leave_one_out.umbral_todo_el_corpus.toFixed(3)}`);
  console.log(
    `  Estabilidad entre pliegues: min ${rep.leave_one_out.estabilidad_pliegues.min.toFixed(3)} · max ${rep.leave_one_out.estabilidad_pliegues.max.toFixed(3)} ` +
      `· media ${rep.leave_one_out.estabilidad_pliegues.media.toFixed(3)} · desviacion ${rep.leave_one_out.estabilidad_pliegues.desviacion.toFixed(3)}`,
  );
  console.log(`  IA detectada      : ${rep.leave_one_out.resultado.vp}/${rep.corpus.ia}`);
  console.log(`  IA que se cuela   : ${rep.leave_one_out.resultado.fn}`);
  console.log(`  Humano acusado    : ${rep.leave_one_out.resultado.fp}/${rep.corpus.humano}`);
  console.log(`  No concluyente    : ${rep.leave_one_out.resultado.no_concluyente}`);
  console.log(`  precision ${rep.leave_one_out.resultado.precision.toFixed(2)} · recall ${rep.leave_one_out.resultado.recall.toFixed(2)} · F1 ${rep.leave_one_out.resultado.f1.toFixed(2)}\n`);
}

// --- Carga de corpus por idioma ---------------------------------------------
const datosPorLang = {};
for (const lang of LANGS) {
  const dirs = DIR_POR_LANG[lang];
  const ia = cargar(dirs.ia, lang).map((d) => ({ ...d, r: analizar(d), clase: 'ia' }));
  const humano = cargar(dirs.humano, lang).map((d) => ({ ...d, r: analizar(d), clase: 'humano' }));
  datosPorLang[lang] = { ia, humano };
}

const totalDocs = LANGS.reduce((a, l) => a + datosPorLang[l].ia.length + datosPorLang[l].humano.length, 0);
if (totalDocs === 0) {
  console.error(
    `Corpus vacio para idioma(s) [${LANGS.join(', ')}]. Anade muestras en:\n` +
      LANGS.map((l) => `  ${path.join(CORPUS, DIR_POR_LANG[l].ia)}\n  ${path.join(CORPUS, DIR_POR_LANG[l].humano)}`).join('\n'),
  );
  process.exit(2);
}

const informes = [];
for (const lang of LANGS) {
  const { ia, humano } = datosPorLang[lang];
  if (!ia.length && !humano.length) {
    console.error(`Aviso: corpus vacio para idioma "${lang}", se omite su informe.`);
    continue;
  }
  informes.push(construirInforme(ia, humano, lang));
}
if (LANG_RAW === 'all') {
  const iaTodo = LANGS.flatMap((l) => datosPorLang[l].ia);
  const humanoTodo = LANGS.flatMap((l) => datosPorLang[l].humano);
  informes.push(construirInforme(iaTodo, humanoTodo, 'all'));
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        config: { umbral: UMBRAL, banda: BANDA, minPalabras: MIN_PALABRAS, lang: LANG_RAW },
        catalogo_distingue_idioma: CATALOGO_TIENE_IDIOMA,
        informes,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

for (const rep of informes) imprimirInforme(rep);
