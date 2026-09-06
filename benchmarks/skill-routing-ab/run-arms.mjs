/**
 * run-arms.mjs — ejecuta los tres caminos de enrutado sobre el mismo corpus.
 *
 * BRAZOS
 *   det   : v2 determinista (reglas + tokens de SKILL.md), top-2.
 *   denso : E5 sobre `ultron_skills_lazy` con el floor 0.82 de produccion.
 *   juez  : LLM sobre el catalogo completo (cmd skill_judge del daemon).
 *
 * Los tres se guardan con su latencia, y las propuestas se deduplican y
 * barajan con semilla ANTES de llegar a la UI: quien vota no debe poder
 * deducir el brazo por la posicion ni por ver la misma lista dos veces.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ULTRON = path.join(os.homedir(), '.ultron');
const v2 = require(path.join(ULTRON, 'cockpit', 'skill-lazy', 'routing-dispatcher.v2.js'));
const { daemonRequest } = require(path.join(ULTRON, 'hooks', 'scripts', 'lib', 'ultron-memory-cli.js'));

const DIR = import.meta.dirname;
const SEMANTIC_FLOOR = 0.82;   // v3: SEMANTIC_RELEVANCE_FLOOR
const MAX_SUGERENCIAS = 2;     // v3: SEMANTIC_MAX_SUGGESTIONS / skill_llm: MAX_ELEGIDAS
const SEMILLA = Number(process.env.AB_SEED || 20260828);

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Descripciones de disco, solo para que la UI muestre que es cada skill. */
function descripciones() {
  const mapa = new Map();
  const raiz = path.join(os.homedir(), '.claude', 'skills');
  for (const e of fs.readdirSync(raiz, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = path.join(raiz, e.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    const m = t.match(/^description:\s*([\s\S]*?)\n[a-z_]+:/m) || t.match(/^description:\s*(.*)/m);
    mapa.set(e.name.replace(/\.disabled$/, ''), (m ? m[1] : '').replace(/\s+/g, ' ').slice(0, 160));
  }
  return mapa;
}

async function brazoDeterminista(prompt) {
  const t0 = Date.now();
  const ranked = v2.rankCandidates(prompt) || [];
  return {
    skills: ranked.slice(0, MAX_SUGERENCIAS).map((c) => c.id || c.name).filter(Boolean),
    ms: Date.now() - t0,
    confianza: ranked.length ? ranked[0].confidence ?? null : null,
  };
}

async function brazoDenso(prompt) {
  const t0 = Date.now();
  const hits = await daemonRequest({ cmd: 'skill_query', prompt, top: 5 }, 15000);
  const arr = Array.isArray(hits) ? hits : [];
  return {
    skills: arr.filter((h) => typeof h.score === 'number' && h.score >= SEMANTIC_FLOOR)
      .slice(0, MAX_SUGERENCIAS).map((h) => h.name),
    ms: Date.now() - t0,
    top_bruto: arr.slice(0, 3).map((h) => `${h.name}:${(h.score ?? 0).toFixed(3)}`),
  };
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espaciado entre consultas al juez. El tier gratis de Gemini limita por
 * peticiones/minuto: una bateria lanzada a pelo se come el 429 al cuarto caso,
 * el daemon lo castiga con 120 s de cooldown y los 36 restantes salen vacios
 * sin haber preguntado nada. En produccion los prompts llegan espaciados por
 * el humano, asi que este throttle reproduce el regimen real, no lo falsea.
 */
const THROTTLE_MS = Number(process.env.AB_THROTTLE_MS || 7000);
let ultimaConsulta = 0;

/**
 * Un fallo del proveedor deja al daemon en cooldown 120 s (skill_llm::
 * COOLDOWN_SECS) y a partir de ahi devuelve vacio en microsegundos. En una
 * bateria eso convierte un timeout suelto en 35 casos "sin propuesta" que no
 * son del juez, sino del castigo. Se detecta por la firma —vacio y demasiado
 * rapido para haber consultado— y se espera a que expire antes de reintentar.
 */
async function brazoJuez(prompt) {
  for (let intento = 0; intento < 2; intento++) {
    const espera = THROTTLE_MS - (Date.now() - ultimaConsulta);
    if (espera > 0) await dormir(espera);
    ultimaConsulta = Date.now();
    const t0 = Date.now();
    const r = await daemonRequest({ cmd: 'skill_judge', prompt }, 25000);
    const ms = Date.now() - t0;
    const skills = (r && Array.isArray(r.skills)) ? r.skills : [];
    const saltado = r && r.skipped;
    if (skills.length || saltado || ms > 400 || intento === 1) {
      return { skills, ms, cooldown: !skills.length && !saltado && ms <= 400 };
    }
    process.stdout.write(' [cooldown: esperando 125s] ');
    await dormir(125000);
  }
  return { skills: [], ms: 0, cooldown: true };
}

const { muestra } = JSON.parse(fs.readFileSync(path.join(DIR, 'prompts.json'), 'utf8'));
const desc = descripciones();
const rand = rng(SEMILLA);
const filas = [];

for (const [i, item] of muestra.entries()) {
  const [det, denso, juez] = [
    await brazoDeterminista(item.prompt),
    await brazoDenso(item.prompt),
    await brazoJuez(item.prompt),
  ];
  const brazos = { det, denso, juez };

  // Deduplicado: una propuesta identica de dos brazos se enseña UNA vez y el
  // voto cuenta para ambos. Enseñarla dos veces delataria el solapamiento.
  const porClave = new Map();
  for (const [nombre, r] of Object.entries(brazos)) {
    if (!r.skills.length) continue;
    const clave = r.skills.join('|');
    if (!porClave.has(clave)) porClave.set(clave, { skills: r.skills, brazos: [] });
    porClave.get(clave).brazos.push(nombre);
  }
  const opciones = [...porClave.values()].map((o, k) => ({
    key: `o${k}`,
    skills: o.skills,
    brazos: o.brazos,
    desc: o.skills.map((s) => desc.get(s) || ''),
  }));
  for (let j = opciones.length - 1; j > 0; j--) {
    const k = Math.floor(rand() * (j + 1));
    [opciones[j], opciones[k]] = [opciones[k], opciones[j]];
  }

  filas.push({ ...item, brazos, opciones });
  process.stdout.write(`\r${i + 1}/${muestra.length}  det=${det.skills.length} denso=${denso.skills.length} juez=${juez.skills.length} (${juez.ms}ms)   `);
}

fs.writeFileSync(path.join(DIR, 'arms.json'), JSON.stringify({ generado: new Date().toISOString(), semilla: SEMILLA, filas }, null, 2));
console.log(`\n-> ${path.join(DIR, 'arms.json')}`);

const lat = (n) => { const a = filas.map((f) => f.brazos[n].ms).sort((x, y) => x - y); return `p50=${a[Math.floor(a.length / 2)]}ms p95=${a[Math.floor(a.length * 0.95)]}ms`; };
for (const n of ['det', 'denso', 'juez']) {
  const vacios = filas.filter((f) => !f.brazos[n].skills.length).length;
  console.log(`${n.padEnd(6)} sin propuesta: ${vacios}/${filas.length}   ${lat(n)}`);
}
