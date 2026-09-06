/**
 * extract.mjs — corpus de prompts reales para la evaluacion ciega de routing.
 *
 * Fuente: ~/.claude/memory/inbox/*.md, donde save-user-prompt.js archiva cada
 * prompt del usuario con su cwd. Es el unico corpus que refleja como escribe
 * el usuario de verdad; una bateria inventada mide como creemos que escribe.
 *
 * Filtro: se descartan los prompts de menos de 4 palabras porque el juez ni
 * llega a consultarse con ellos (skill_llm::merece_consulta) y meterlos en la
 * comparacion mediria un camino que en produccion no existe.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const INBOX = path.join(os.homedir(), '.claude', 'memory', 'inbox');
const OUT = path.join(import.meta.dirname, 'prompts.json');
const MUESTRA = Number(process.env.AB_SAMPLE || 40);
const SEMILLA = Number(process.env.AB_SEED || 20260828);

/** PRNG con semilla: la muestra debe poder reproducirse tal cual. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function parseFichero(texto, fecha) {
  const out = [];
  const bloques = texto.split(/^## /m).slice(1);
  for (const b of bloques) {
    const lineas = b.split('\n');
    const hora = (lineas[0] || '').trim();
    const cwdMatch = b.match(/^\*cwd: `([^`]+)`\*/m);
    const cuerpo = b
      .replace(/^[^\n]*\n/, '')
      .replace(/^\*cwd: `[^`]+`\*\n?/m, '')
      .trim();
    if (!cuerpo) continue;
    out.push({
      id: `${fecha}T${hora}`,
      fecha,
      cwd: cwdMatch ? cwdMatch[1] : null,
      proyecto: cwdMatch ? path.basename(cwdMatch[1]) : 'desconocido',
      prompt: cuerpo,
    });
  }
  return out;
}

const ficheros = fs.readdirSync(INBOX).filter((f) => f.endsWith('.md')).sort();
let todos = [];
for (const f of ficheros) {
  todos = todos.concat(
    parseFichero(fs.readFileSync(path.join(INBOX, f), 'utf8'), f.replace('.md', '')),
  );
}

// Gate de produccion + deduplicado por texto normalizado.
const vistos = new Set();
const elegibles = todos.filter((p) => {
  if (p.prompt.split(/\s+/).length < 4) return false;
  // Los system-turn (resumenes, hooks) no son prompts del usuario.
  if (/^<[a-z-]+>/.test(p.prompt)) return false;
  const k = p.prompt.slice(0, 200).toLowerCase().replace(/\s+/g, ' ');
  if (vistos.has(k)) return false;
  vistos.add(k);
  return true;
});

// Estratificado por proyecto: sin esto la muestra la copan las rachas largas
// de un solo repo y el routing se mide sobre un dominio, no sobre el sistema.
const porProyecto = new Map();
for (const p of elegibles) {
  if (!porProyecto.has(p.proyecto)) porProyecto.set(p.proyecto, []);
  porProyecto.get(p.proyecto).push(p);
}
const rand = rng(SEMILLA);
for (const arr of porProyecto.values()) arr.sort(() => rand() - 0.5);

const muestra = [];
const claves = [...porProyecto.keys()].sort();
let ronda = 0;
while (muestra.length < MUESTRA) {
  let añadido = false;
  for (const k of claves) {
    const arr = porProyecto.get(k);
    if (arr.length > ronda) {
      muestra.push(arr[ronda]);
      añadido = true;
      if (muestra.length === MUESTRA) break;
    }
  }
  if (!añadido) break;
  ronda++;
}

fs.writeFileSync(OUT, JSON.stringify({ semilla: SEMILLA, total_inbox: todos.length, elegibles: elegibles.length, proyectos: claves.length, muestra }, null, 2));
console.log(`inbox=${todos.length} elegibles=${elegibles.length} proyectos=${claves.length} muestra=${muestra.length}`);
console.log(`-> ${OUT}`);
