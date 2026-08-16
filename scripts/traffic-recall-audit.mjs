#!/usr/bin/env node
// traffic-recall-audit.mjs — cuanta memoria se calla el sistema sobre el
// trafico REAL del usuario.
//
// POR QUE EXISTE (2026-08-16). Los dos medidores que habia miden conjuntos
// escritos a mano: el oraculo golden son 29 queries limpias y el memory-bench
// otras 26 sinteticas. Ninguno de los dos vio venir los dos fallos de ese dia:
//
//   - el trust gate vaciaba el 66% de los packs reales (443 de 670 prompts)
//     porque un 'venga', una errata o el id de una tarjeta contaban como
//     termino informativo desconocido. El golden no lleva ni un 'venga'.
//   - la query 'qdrant' devolvia cero memorias por el corte del sparse fuerte.
//     Esa SI estaba en el golden, pero como una query entre 29: movio el
//     agregado tres milesimas y nadie la miro.
//
// Este audit no puntua relevancia — eso exige etiquetas y las etiquetas son
// trabajo humano. Mide algo mas basico y que ningun otro medidor cubre: con
// que frecuencia la memoria NO CONTESTA a lo que el usuario escribe de verdad,
// y por que causa. Un recall irrelevante es malo; un recall vacio es invisible.
//
// MODO POR DEFECTO (lectura, coste cero): lee ~/.claude/logs/orchestrate.jsonl,
// que ya guarda las memorias inyectadas en cada turno. Mide lo que REALMENTE
// paso, no una reconstruccion. Contrapartida: refleja el binario que corria
// entonces, asi que tras desplegar un cambio hay que esperar a que entre
// trafico nuevo (por eso la ventana por defecto es corta y reciente).
//
// MODO --replay N: re-ejecuta los N prompts mas recientes contra el binario
// ACTUAL via el daemon. Sirve para medir un cambio antes de que haya trafico,
// al precio de ~0,5-1 s por prompt.
//
// Uso:
//   node scripts/traffic-recall-audit.mjs [--window N] [--json] [--max-silenced P]
//   node scripts/traffic-recall-audit.mjs --replay 60

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const HOME = homedir();
const ORCH_LOG = join(HOME, '.claude', 'logs', 'orchestrate.jsonl');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

// Ventana por defecto: los 150 turnos mas recientes. Corta a proposito — el
// objetivo es detectar una regresion RECIENTE, no promediar meses de historia
// en los que el binario ha cambiado veinte veces.
const WINDOW = Number(flag('--window', 150));
const REPLAY = has('--replay') ? Number(flag('--replay', 60)) : 0;
const AS_JSON = has('--json');
// Umbral de fallo. Calibrado 2026-08-16: con la regla `unknown_terms_dominate`
// la simulacion sobre 670 prompts reales daba 11,5% de abstencion, asi que 20%
// deja margen de variacion normal del trafico y sigue disparando MUY por debajo
// del 66% que llego a estar en produccion sin que nadie lo viera.
const MAX_SILENCED = Number(flag('--max-silenced', 20));

// ---------------------------------------------------------------------------
// Clasificacion de la causa por la que un turno se quedo sin memoria. El orden
// importa: se queda con la primera que casa, de la mas especifica a la generica.
// ---------------------------------------------------------------------------
const CAUSAS = [
  { id: 'trust_gate', test: (w) => w.startsWith('recall abstained — el corpus no conoce'),
    desc: 'termino(s) que el corpus no conoce' },
  { id: 'confidence_floor', test: (w) => w.startsWith('recall abstained — ninguna entrada'),
    desc: 'ninguna entrada supero el floor de confianza' },
  { id: 'infra', test: (w) => w.startsWith('recall unavailable'),
    desc: 'el recall fallo (sqlite/qdrant)' },
  { id: 'dense_vacio', test: (w) => w.startsWith('dense recall empty'),
    desc: 'E5/Qdrant no devolvieron nada (sparse-only)' },
];

function clasificar(warnings) {
  for (const c of CAUSAS) {
    const hit = (warnings || []).find((w) => c.test(String(w)));
    if (hit) return { id: c.id, warning: hit };
  }
  return { id: 'sin_causa_declarada', warning: null };
}

/** Termino disparador del trust gate, si el warning lo nombra. */
function terminoDe(warning) {
  const m = String(warning || '').match(/no conoce '([^']+)'/);
  return m ? m[1] : null;
}

function leerTurnos() {
  if (!existsSync(ORCH_LOG)) return null;
  const filas = readFileSync(ORCH_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && typeof r.prompt === 'string' && r.prompt.trim());
  return filas;
}

async function replay(turnos) {
  const require = createRequire(import.meta.url);
  const { daemonRequest } = require(join(HOME, '.ultron', 'hooks', 'scripts', 'lib', 'ultron-memory-cli.js'));
  const out = [];
  for (const t of turnos) {
    const r = await daemonRequest(
      { cmd: 'orchestrate', prompt: t.prompt, project: t.project || undefined },
      120000
    );
    if (!r || r.error) {
      out.push({ ...t, memories: [], warnings: ['recall unavailable: daemon sin respuesta'] });
      continue;
    }
    out.push({ ...t, memories: r.memories || [], warnings: r.warnings || [] });
  }
  return out;
}

function analizar(turnos, listar) {
  const total = turnos.length;
  const mudos = turnos.filter((t) => (t.memories || []).length === 0);
  // --list: los prompts concretos que se quedaron sin memoria. Un porcentaje
  // agregado no dice si el silencio fue correcto ('hola') o un fallo ('qdrant');
  // eso solo se ve leyendo los prompts, asi que el audit los puede escupir.
  const listado = listar
    ? mudos.map((t) => ({
        causa: clasificar(t.warnings).id,
        prompt: String(t.prompt).replace(/\s+/g, ' ').slice(0, 100),
      }))
    : [];
  const porCausa = {};
  const terminos = {};
  for (const t of mudos) {
    const c = clasificar(t.warnings);
    porCausa[c.id] = (porCausa[c.id] || 0) + 1;
    const term = terminoDe(c.warning);
    if (term) terminos[term] = (terminos[term] || 0) + 1;
  }
  const cuentas = turnos.map((t) => (t.memories || []).length).sort((a, b) => a - b);
  const pct = (n) => (total ? (100 * n) / total : 0);
  return {
    total,
    silenced: mudos.length,
    silenced_pct: Number(pct(mudos.length).toFixed(1)),
    memories_p50: cuentas.length ? cuentas[Math.floor(cuentas.length / 2)] : 0,
    memories_media: cuentas.length
      ? Number((cuentas.reduce((a, b) => a + b, 0) / cuentas.length).toFixed(2))
      : 0,
    por_causa: porCausa,
    terminos_disparadores: Object.entries(terminos)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([t, n]) => ({ termino: t, veces: n })),
    ventana: { desde: turnos[0]?.ts ?? null, hasta: turnos[turnos.length - 1]?.ts ?? null },
    silenciados: listado,
  };
}

const todos = leerTurnos();
if (todos === null) {
  const err = { ok: false, error: `no existe ${ORCH_LOG}` };
  console.log(AS_JSON ? JSON.stringify(err) : `[traffic-audit] ${err.error}`);
  process.exit(2);
}
if (!todos.length) {
  const err = { ok: false, error: 'orchestrate.jsonl sin turnos parseables' };
  console.log(AS_JSON ? JSON.stringify(err) : `[traffic-audit] ${err.error}`);
  process.exit(2);
}

const n = REPLAY || WINDOW;
const ventana = todos.slice(-n);
const turnos = REPLAY ? await replay(ventana) : ventana;
const r = analizar(turnos, has('--list'));
r.modo = REPLAY ? 'replay (binario actual)' : 'log (lo que realmente paso)';
r.ok = r.silenced_pct <= MAX_SILENCED;
r.max_silenced = MAX_SILENCED;

if (AS_JSON) {
  console.log(JSON.stringify(r));
} else {
  console.log(`traffic-recall-audit · ${r.modo} · ${r.total} turnos`);
  console.log('');
  console.log(`  turnos SIN memoria : ${r.silenced}/${r.total} (${r.silenced_pct}%)  [umbral ${MAX_SILENCED}%]`);
  console.log(`  memorias por turno : mediana ${r.memories_p50} · media ${r.memories_media}`);
  if (Object.keys(r.por_causa).length) {
    console.log('');
    console.log('  causa del silencio:');
    for (const [id, cnt] of Object.entries(r.por_causa).sort((a, b) => b[1] - a[1])) {
      const d = CAUSAS.find((c) => c.id === id);
      console.log(`    ${String(cnt).padStart(4)}  ${id.padEnd(20)} ${d ? d.desc : 'el pack salio vacio sin warning que lo explique'}`);
    }
  }
  if (r.terminos_disparadores.length) {
    console.log('');
    console.log('  terminos que dispararon el trust gate:');
    console.log(
      '    ' + r.terminos_disparadores.map((t) => `${t.termino} (${t.veces})`).join(', ')
    );
  }
  if (r.silenciados.length) {
    console.log('');
    console.log('  prompts que se quedaron sin memoria:');
    for (const s of r.silenciados) {
      console.log(`    [${s.causa}] ${s.prompt}`);
    }
  }
  console.log('');
  console.log(`  ${r.ok ? 'OK' : 'FALLA'} — ${r.ok ? 'dentro del umbral' : `${r.silenced_pct}% supera el ${MAX_SILENCED}% permitido`}`);
}

process.exit(r.ok ? 0 : 1);
