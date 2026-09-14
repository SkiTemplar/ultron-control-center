/**
 * ai-text-detector.selftest.mjs — check del veredicto por densidad y del rol
 * "aviso" del detector de texto IA (decidido por el usuario 2026-09-11).
 *
 * Gemelo de los tests `veredicto_tres_estados_desde_fixture` y
 * `rol_desde_fixture_no_cuenta_avisos_para_densidad` en tfg_lab.rs: ambos
 * lados leen el MISMO fixture (scripts/fixtures/catalog-cases.json,
 * secciones `veredicto_casos` y `rol_casos`), para que un cambio de umbral o
 * de rol que rompa la paridad se vea aquí y en Rust a la vez.
 *
 * Uso: node hooks/scripts/lib/ai-text-detector.selftest.mjs   (exit 0 = verde)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  scan,
  computeVerdict,
  detectarIdioma,
  MIN_WORDS,
  DENSITY_THRESHOLD,
  DENSITY_BAND,
} = require('./ai-text-detector.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(__dirname, '..', '..', '..');
const FIXTURE_PATH = path.join(RAIZ, 'scripts', 'fixtures', 'catalog-cases.json');
const CATALOG_PATH = path.join(RAIZ, 'docs', 'research', 'patrones-texto-ia.json');

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const catalogo = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')).patrones;

// --- Constantes: el punto de partida no se ha movido en silencio ------------
A(MIN_WORDS === 400, 'constantes: MIN_WORDS = 400', `MIN_WORDS=${MIN_WORDS}`);
A(DENSITY_THRESHOLD === 0.12, 'constantes: DENSITY_THRESHOLD = 0.12', `DENSITY_THRESHOLD=${DENSITY_THRESHOLD}`);
A(DENSITY_BAND === 0.03, 'constantes: DENSITY_BAND = 0.03', `DENSITY_BAND=${DENSITY_BAND}`);

// --- Los TRES estados, caso a caso desde el fixture compartido --------------
const veredictoCasos = fixture.veredicto_casos || [];
A(veredictoCasos.length >= 6, 'fixture: veredicto_casos tiene suficientes casos', `${veredictoCasos.length} casos`);
for (const caso of veredictoCasos) {
  const obtenido = computeVerdict(caso.words, caso.density);
  A(
    obtenido === caso.esperado,
    `veredicto[${caso.nombre}]: words=${caso.words} density=${caso.density} -> ${caso.esperado}`,
    `obtenido=${obtenido}`,
  );
}

// --- rol "aviso" vs "senal", contra el CATALOGO REAL -------------------------
const rolCasos = fixture.rol_casos || [];
A(rolCasos.length > 0, 'fixture: rol_casos no esta vacio', `${rolCasos.length} casos`);
for (const caso of rolCasos) {
  const report = scan(caso.texto, catalogo);
  const delPatron = report.matches.filter((m) => m.pattern === caso.patron);
  A(delPatron.length > 0, `rol[${caso.patron}]: dispara sobre "${caso.texto}"`, JSON.stringify(report.matches));
  const rolesVistos = new Set(delPatron.map((m) => m.rol));
  A(
    rolesVistos.size === 1 && rolesVistos.has(caso.rol_esperado),
    `rol[${caso.patron}]: rol == "${caso.rol_esperado}"`,
    `roles vistos: ${JSON.stringify([...rolesVistos])}`,
  );
  if (caso.rol_esperado === 'aviso') {
    A(report.senales_total === 0, `rol[${caso.patron}]: un aviso no cuenta como senal`, `senales_total=${report.senales_total}`);
    A(report.avisos_total > 0, `rol[${caso.patron}]: el aviso SI se lista en avisos_total`, `avisos_total=${report.avisos_total}`);
    A(report.density_per_100w === 0, `rol[${caso.patron}]: densidad 0 (el aviso no la infla)`, `density=${report.density_per_100w}`);
  } else {
    A(report.senales_total > 0, `rol[${caso.patron}]: cuenta como senal`, `senales_total=${report.senales_total}`);
  }
}

// --- Guarda: tricolon es "aviso" en el catalogo real (no se ha revertido) ---
const tricolon = catalogo.find((p) => p.nombre === 'Regla de tres (tricolon) obsesiva');
A(!!tricolon, 'catalogo: existe el patron tricolon', 'no encontrado');
A(tricolon && tricolon.rol === 'aviso', 'catalogo: tricolon tiene rol "aviso"', JSON.stringify(tricolon && tricolon.rol));

// --- Filtro por idioma (campo "idioma" del catalogo, 2026-09-14) -----------
// Catalogo sintetico con los tres casos: patron "es", patron "*" y patron SIN
// campo "idioma" (compatibilidad con catalogos viejos, debe tratarse como "*").
const MARCADOR = 'marcadorxyzunico';
const catalogoIdioma = [
  {
    nombre: 'Patron solo espanol',
    idioma: 'es',
    senales_ejecutables: [{ tipo: 'lexico', valor: MARCADOR }],
  },
  {
    nombre: 'Patron independiente de idioma',
    idioma: '*',
    senales_ejecutables: [{ tipo: 'lexico', valor: MARCADOR }],
  },
  {
    nombre: 'Patron sin campo idioma',
    senales_ejecutables: [{ tipo: 'lexico', valor: MARCADOR }],
  },
];
const TEXTO_CON_MARCADOR = `This is a sample sentence that contains the ${MARCADOR} token for testing.`;

// (a) patron "es" NO puntua sobre texto forzado a ingles, aunque el termino
// literal este presente.
{
  const r = scan(TEXTO_CON_MARCADOR, catalogoIdioma, { idioma: 'en' });
  const deEste = r.matches.filter((m) => m.pattern === 'Patron solo espanol');
  A(deEste.length === 0, 'idioma: patron "es" no dispara sobre texto en ingles', JSON.stringify(deEste));
}

// (b) patron "*" SI puntua en ambos idiomas.
{
  const rEs = scan(TEXTO_CON_MARCADOR, catalogoIdioma, { idioma: 'es' });
  const rEn = scan(TEXTO_CON_MARCADOR, catalogoIdioma, { idioma: 'en' });
  const hitEs = rEs.matches.some((m) => m.pattern === 'Patron independiente de idioma');
  const hitEn = rEn.matches.some((m) => m.pattern === 'Patron independiente de idioma');
  A(hitEs && hitEn, 'idioma: patron "*" dispara en es Y en en', `es=${hitEs} en=${hitEn}`);
}

// (c) patron SIN campo "idioma" sigue funcionando en cualquier idioma
// (compatibilidad: se trata como "*").
{
  const rEs = scan(TEXTO_CON_MARCADOR, catalogoIdioma, { idioma: 'es' });
  const rEn = scan(TEXTO_CON_MARCADOR, catalogoIdioma, { idioma: 'en' });
  const hitEs = rEs.matches.some((m) => m.pattern === 'Patron sin campo idioma');
  const hitEn = rEn.matches.some((m) => m.pattern === 'Patron sin campo idioma');
  A(hitEs && hitEn, 'idioma: patron sin campo "idioma" dispara igual (compat = "*")', `es=${hitEs} en=${hitEn}`);
}

// (d) deteccion de idioma: positivo en cada idioma y caso NEGATIVO (texto sin
// evidencia de ninguno de los dos cae al default "es", no se inventa "en").
{
  const es = detectarIdioma('El sistema analiza los datos y presenta los resultados de la investigación en el capítulo siguiente.');
  A(es === 'es', 'detectarIdioma: texto en español -> "es"', `obtenido=${es}`);

  const en = detectarIdioma('The system analyzes the data and presents the results of the research in the following chapter.');
  A(en === 'en', 'detectarIdioma: texto en ingles -> "en"', `obtenido=${en}`);

  const negativo = detectarIdioma('Qdrant E5-large RRF FTS5 CPU GPU JSON');
  A(negativo === 'es', 'detectarIdioma NEGATIVO: sin stopwords reconocibles cae al default "es", no a "en"', `obtenido=${negativo}`);
}

console.log(fail === 0 ? '\nSELFTEST ai-text-detector: VERDE' : `\nSELFTEST ai-text-detector: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
