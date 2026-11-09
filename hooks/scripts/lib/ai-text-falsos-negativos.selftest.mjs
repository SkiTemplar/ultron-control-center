/**
 * ai-text-falsos-negativos.selftest.mjs — falsos negativos del detector de
 * texto IA vistos en la auditoría del humanizer sobre el README (2026-10-18).
 *
 * El README de partida (scripts/fixtures/ai-text-falsos-negativos/
 * readme-antes.md) tiene 8 rayas largas, 16 negritas, un contraste
 * «no X: lo Y» y una frase que habla del propio documento, y el detector daba
 * `sin_indicios`: en destino .md se omitía el patrón del guion largo y la
 * negrita solo la medía «Artefactos de markup», que también se omite en .md.
 *
 * Contrato que fija este selftest:
 *   - Los cuatro patrones (rayas, negritas en prosa, contraste negativo y
 *     metacomentario) pesan por DENSIDAD: una aparición suelta no dispara y no
 *     cambia el veredicto de un texto humano.
 *   - La negrita de tablas, listas de definiciones («- **Clave**: valor») y
 *     bloques de código no cuenta.
 *   - readme-antes.md deja de dar `sin_indicios` y readme-despues.md da menos
 *     señales que readme-antes.md.
 *   - La muestra humana (fragmento congelado de papercuts.md) sigue en
 *     `sin_indicios`, también con una aparición suelta de cada patrón.
 *
 * Las entradas de los casos positivos son los ejemplos literales de la sección
 * «Falsos negativos del detector» del informe de la auditoría.
 *
 * Uso: node hooks/scripts/lib/ai-text-falsos-negativos.selftest.mjs (exit 0 = verde)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scan, MARKDOWN_NATIVE_PATTERNS } = require('./ai-text-detector.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(__dirname, '..', '..', '..');
const FIXTURES = path.join(RAIZ, 'scripts', 'fixtures', 'ai-text-falsos-negativos');
const CATALOG_PATH = path.join(RAIZ, 'docs', 'research', 'patrones-texto-ia.json');

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const catalogo = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')).patrones;
const leer = (nombre) => fs.readFileSync(path.join(FIXTURES, nombre), 'utf8');

const PATRON_GUION = 'Guion largo (em dash) sobreusado';
const PATRON_NEGRITA = 'Negrita decorativa en prosa';
const PATRON_CONTRASTE = "Contraste negativo 'no X: lo Y' / 'no es X, es Y'";
const PATRON_META = 'Metacomentario sobre el propio documento';
const NUEVOS = [PATRON_GUION, PATRON_NEGRITA, PATRON_CONTRASTE, PATRON_META];

/** Escaneo con el mismo ámbito que el CLI aplica a un destino .md. */
const scanMd = (texto) => scan(texto, catalogo, { skipPatterns: MARKDOWN_NATIVE_PATTERNS, idioma: 'es' });
const dispara = (report, patron) => report.matches.some((m) => m.pattern === patron);
const resumen = (r) => JSON.stringify(r.matches.map((m) => `${m.pattern}: ${m.evidence}`));

// Ejemplos literales del informe (sección «Falsos negativos del detector»).
const EJ_RAYA = '- **Memoria gobernada** — `brain.db` (SQLite) como unica fuente de verdad; todo';
const EJ_NEGRITA = '- **Recall hibrido** — denso (E5 1024d / Qdrant) + sparse (FTS5/BM25) fusionados';
const EJ_CONTRASTE = 'No reemplaza a Claude\nCode: lo envuelve con estado persistente, inspeccionable y versionable.';
const EJ_META =
  '> Esta documentacion\n> describe el sistema tal y como esta en el disco; no contiene secretos ni\n> datos personales.';

// --- Catálogo: los patrones existen y el guion largo ya no se omite en .md --
for (const nombre of NUEVOS) {
  const p = catalogo.find((x) => x.nombre === nombre);
  A(!!p, `catalogo: existe "${nombre}"`, 'no encontrado');
  A(p && (p.rol || 'senal') === 'senal', `catalogo: "${nombre}" cuenta para el veredicto (densidad en la heuristica)`, JSON.stringify(p && p.rol));
}
A(
  !MARKDOWN_NATIVE_PATTERNS.some((s) => 'guion largo (em dash) sobreusado'.includes(s)),
  'ambito .md: el guion largo ya no se omite (la raya no es sintaxis Markdown)',
  JSON.stringify(MARKDOWN_NATIVE_PATTERNS),
);

// --- Rayas y negritas: la lista literal de características dispara ----------
{
  const antes = leer('readme-antes.md');
  const lista = antes.slice(antes.indexOf('## Caracteristicas'));
  A(lista.includes(EJ_RAYA) && lista.includes(EJ_NEGRITA), 'fixture: la lista contiene los ejemplos literales del informe', 'faltan');
  const r = scanMd(lista);
  A(dispara(r, PATRON_GUION), 'rayas: la lista de características (7 rayas) dispara en .md', resumen(r));
  A(dispara(r, PATRON_NEGRITA), 'negritas: la lista de características (7 etiquetas en negrita) dispara en .md', resumen(r));
}

// --- Una aparición suelta no dispara -----------------------------------------
for (const [nombre, texto] of [['raya', EJ_RAYA], ['negrita', EJ_NEGRITA]]) {
  const r = scanMd(texto);
  A(!dispara(r, PATRON_GUION) && !dispara(r, PATRON_NEGRITA), `aparicion suelta (${nombre}): ni rayas ni negritas disparan`, resumen(r));
}
{
  const r = scanMd(EJ_CONTRASTE);
  A(!dispara(r, PATRON_CONTRASTE), 'contraste: el ejemplo literal suelto no dispara', resumen(r));
}
{
  const r = scanMd(EJ_META);
  A(!dispara(r, PATRON_META), 'metacomentario: el ejemplo literal suelto no dispara', resumen(r));
}

// --- Contraste negativo: dos o más en poco texto disparan ----------------------
const CONTRASTES = {
  'no X: lo Y (literal + otro)': `${EJ_CONTRASTE} No sustituye al editor: lo complementa con atajos propios.`,
  'no es X, es Y': 'La caché no es un adorno, es la pieza que sostiene el rendimiento. El índice no es un lujo, es lo que permite responder en 40 ms.',
  'no X, sino Y': 'El daemon no carga los modelos al arrancar, sino cuando llega la primera consulta. La interfaz no pregunta al disco, sino al daemon.',
};
for (const [nombre, texto] of Object.entries(CONTRASTES)) {
  const r = scanMd(texto);
  A(dispara(r, PATRON_CONTRASTE), `contraste: "${nombre}" dispara`, resumen(r));
}

// --- Metacomentario: dos o más en poco texto disparan --------------------------
const METAS = {
  'literal + a continuacion se': `${EJ_META}\n\nA continuación se detallan los pasos de instalación.`,
  'en esta seccion + este documento': 'En esta sección se describe el arranque del daemon. Este documento resume además las decisiones de diseño.',
};
for (const [nombre, texto] of Object.entries(METAS)) {
  const r = scanMd(texto);
  A(dispara(r, PATRON_META), `metacomentario: "${nombre}" dispara`, resumen(r));
}

// --- Negrita: tablas, listas de definiciones y código no cuentan ---------------
{
  const tabla = [
    '| Campo | Valor |',
    '|---|---|',
    ...['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'].map((x) => `| **${x}** | **valor ${x}** |`),
  ].join('\n');
  const definiciones = ['Version', 'Plataforma', 'Licencia', 'Autor', 'Estado', 'Idioma']
    .map((k) => `- **${k}**: dato de ${k.toLowerCase()}`)
    .join('\n');
  const codigo = ['```md', ...Array.from({ length: 6 }, (_, i) => `**negrita ${i}** en un ejemplo de código`), '```'].join('\n');
  const texto = `Datos del proyecto.\n\n${tabla}\n\n${definiciones}\n\n${codigo}\n`;
  const r = scanMd(texto);
  A(!dispara(r, PATRON_NEGRITA), 'negritas: tabla, lista de definiciones y bloque de código no cuentan', resumen(r));
}

// --- Documentos completos: antes / después -----------------------------------
const rAntes = scanMd(leer('readme-antes.md'));
const rDespues = scanMd(leer('readme-despues.md'));
A(rAntes.veredicto !== 'sin_indicios', `readme-antes.md: deja de dar sin_indicios (${rAntes.veredicto}, ${rAntes.senales_total} senales)`, resumen(rAntes));
A(dispara(rAntes, PATRON_GUION) && dispara(rAntes, PATRON_NEGRITA), 'readme-antes.md: disparan rayas y negritas', resumen(rAntes));
A(
  rDespues.senales_total < rAntes.senales_total,
  `readme-despues.md: menos senales que antes (${rDespues.senales_total} < ${rAntes.senales_total})`,
  resumen(rDespues),
);
A(rDespues.veredicto === 'sin_indicios', `readme-despues.md: sin_indicios (${rDespues.veredicto})`, resumen(rDespues));

// --- Caso negativo: muestra humana -------------------------------------------
{
  const humano = leer('humano-papercuts.md');
  const rayas = (humano.match(/—/g) || []).length;
  // La negrita del fixture cruza un salto de línea (prosa ajustada a 80 col.).
  const negritas = (humano.match(/\*\*[^*\n]+(?:\n[^*\n]+)?\*\*/g) || []).length;
  A(rayas === 1 && negritas === 1, 'fixture humano: una raya y una negrita (aparicion suelta)', `rayas=${rayas} negritas=${negritas}`);
  const r = scanMd(humano);
  A(r.veredicto === 'sin_indicios', `humano: sin_indicios (${r.words} palabras, ${r.senales_total} senales)`, resumen(r));
  A(!NUEVOS.some((p) => dispara(r, p)), 'humano: ningun patron nuevo dispara', resumen(r));

  // Una aparición suelta de cada patrón nuevo no cambia el veredicto.
  const conUnaDeCada =
    `${humano}\n2026-10-18 · el **build** tarda — sin motivo claro · no es un fallo del disco, es la caché fría · ultron\n` +
    '2026-10-18 · el daemon tarda en arrancar con el antivirus activo · este documento lo recoge para la próxima vez · ultron\n';
  const r2 = scanMd(conUnaDeCada);
  A(r2.veredicto === 'sin_indicios', `humano + una aparicion de cada patron: sigue sin_indicios (${r2.senales_total} senales)`, resumen(r2));
  A(!NUEVOS.some((p) => dispara(r2, p)), 'humano + una aparicion de cada patron: ningun patron nuevo dispara', resumen(r2));
}

console.log(fail === 0 ? '\nSELFTEST ai-text-falsos-negativos: VERDE' : `\nSELFTEST ai-text-falsos-negativos: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
