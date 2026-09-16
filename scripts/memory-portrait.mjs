#!/usr/bin/env node
/**
 * memory-portrait.mjs — retrato del usuario a partir de su memoria.
 *
 * Decidido por el usuario 2026-09-16: el retrato ("qué sabe ULTRON de mí, qué
 * opina, cómo le trato, mis proyectos") vive en Memory -> Retrato, no en el
 * chat, y se va actualizando solo.
 *
 * Qué hace:
 *   1. Lee de brain.db (solo lectura) la memoria personal ACTIVA: user_profile,
 *      preference, scope global y decisiones/restricciones sin proyecto.
 *   2. Lee los ficheros de memoria de Claude Code (~/.claude/projects/*\/memory)
 *      de tipo user y feedback.
 *   3. Pide a `claude -p` (Sonnet, suscripción OAuth, sin hooks) un retrato en
 *      JSON con bloques de afirmaciones y sus fuentes, proyectos, opinión y trato.
 *   4. Fusiona con el retrato anterior: las afirmaciones confirmadas se
 *      conservan y las descartadas no vuelven.
 *   5. Escribe cockpit/memory-portrait/portrait.json (atómico, gitignorado:
 *      contiene datos personales) y una copia diaria en history/.
 *
 * Nunca escribe en brain.db: confirmar y descartar actúan desde la UI.
 *
 * Uso:
 *   node scripts/memory-portrait.mjs                    # regenera siempre
 *   node scripts/memory-portrait.mjs --if-older-than 7  # solo si tiene >= 7 días
 *   node scripts/memory-portrait.mjs --dry-run          # imprime el prompt, no llama
 *
 * Variables: MEMORY_PORTRAIT_CLAUDE_BIN (stub en tests), MEMORY_PORTRAIT_MODEL
 * (default sonnet), MEMORY_PORTRAIT_TIMEOUT_MS (default 240000).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
export const PORTRAIT_DIR = path.join(HOME, '.ultron', 'cockpit', 'memory-portrait');
export const PORTRAIT_PATH = path.join(PORTRAIT_DIR, 'portrait.json');
const BRAIN_DB = path.join(HOME, '.ultron', 'brain.db');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const MODEL = process.env.MEMORY_PORTRAIT_MODEL || 'sonnet';
const TIMEOUT_MS = Number(process.env.MEMORY_PORTRAIT_TIMEOUT_MS || 240000);
const MAX_FILE_CHARS = 900;

export const BLOCKS = [
  { id: 'quien_es', titulo: 'Quién eres' },
  { id: 'como_trabaja', titulo: 'Cómo trabajas' },
  { id: 'como_trata_al_asistente', titulo: 'Cómo me tratas' },
  { id: 'objetivos', titulo: 'Objetivos' },
  { id: 'preferencias', titulo: 'Preferencias y normas' },
];

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/** Memoria personal activa de brain.db (solo lectura). */
export function readPersonalMemories(dbPath = BRAIN_DB) {
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `select id, type, title, summary from memory_items
         where status = 'active'
           and (type in ('user_profile', 'preference') or scope = 'global'
                or (project_id is null and type in ('decision', 'constraint', 'lesson')))
         order by type, updated_at desc`,
      )
      .all();
  } finally {
    db.close();
  }
}

function requireSqlite() {
  // node:sqlite emite un ExperimentalWarning por stderr; se silencia solo ese.
  const original = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    if (String(w).includes('SQLite')) return;
    original.call(process, w, ...rest);
  };
  try {
    return process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

/** Ficheros de memoria de Claude Code de tipo user o feedback. */
export function readMemoryFiles(projectsDir = PROJECTS_DIR) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const memDir = path.join(projectsDir, d, 'memory');
    let files = [];
    try {
      files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && !f.startsWith('MEMORY'));
    } catch {
      continue;
    }
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(path.join(memDir, f), 'utf8');
      } catch {
        continue;
      }
      const type = (text.match(/^\s*type:\s*(\w+)/m) || [])[1] || '';
      if (type !== 'user' && type !== 'feedback') continue;
      const body = text.replace(/^---[\s\S]*?---\s*/, '').trim();
      out.push({ source: `file:${d}/${f}`, type, text: body.slice(0, MAX_FILE_CHARS) });
    }
  }
  return out;
}

/**
 * Semilla opcional (seed.json junto al retrato): hechos y resúmenes de proyecto
 * extraídos por una auditoría previa de la memoria, con sus fuentes. Se usa
 * como evidencia adicional; no es obligatoria.
 */
export function readSeed(seedPath = path.join(PORTRAIT_DIR, 'seed.json')) {
  try {
    const s = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    return { hechos: Array.isArray(s.hechos) ? s.hechos : [], proyectos: Array.isArray(s.proyectos) ? s.proyectos : [] };
  } catch {
    return null;
  }
}

export function readPrevious(portraitPath = PORTRAIT_PATH) {
  try {
    return JSON.parse(fs.readFileSync(portraitPath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt y fusión (puros, cubiertos por el selftest)
// ---------------------------------------------------------------------------

export function buildPrompt({ memories, files, previous, seed = null }) {
  const marcadas = [];
  for (const b of previous?.bloques || []) {
    for (const a of b.afirmaciones || []) {
      if (a.estado === 'confirmed') marcadas.push(`CONFIRMADA (mantener): ${a.texto}`);
      if (a.estado === 'discarded') marcadas.push(`DESCARTADA (no volver a incluir): ${a.texto}`);
    }
  }
  const mem = memories.map((m) => `[mem:${m.id}] (${m.type}) ${m.title} — ${m.summary || ''}`).join('\n');
  const fil = files.map((f) => `[${f.source}] (${f.type})\n${f.text}`).join('\n\n');
  return [
    'Eres ULTRON, el asistente personal del usuario. Escribe su retrato a partir de la',
    'memoria que tienes de él. Responde SOLO con un objeto JSON válido, sin Markdown,',
    'con esta forma exacta:',
    '{',
    '  "resumen": "2-3 frases: quién es el usuario",',
    `  "bloques": [${BLOCKS.map((b) => `{"id":"${b.id}","afirmaciones":[{"texto":"...","fuentes":["mem:<id>" o "file:<ruta>"]}]}`).join(', ')}],`,
    '  "proyectos": [{"nombre":"...","que_es":"una frase","estado":"activo|pausado|terminado|desconocido"}],',
    '  "opinion": "tu opinión subjetiva y honesta sobre él, 4-6 frases, tuteando, sin halagos vacíos; señala también contradicciones o riesgos",',
    '  "trato": "cómo te trata él a ti, 3-5 frases, tuteando"',
    '}',
    '',
    'Reglas:',
    '- Cada afirmación es un hecho concreto sustentado por 1-3 fuentes de la lista; no inventes nada.',
    '- Máximo 8 afirmaciones por bloque; fusiona duplicados.',
    '- Ignora lo trivial, lo técnico de un proyecto concreto y lo que atribuya al usuario rasgos de una persona o del asistente.',
    '- Español de España con ortografía completa.',
    '- Los tonos con insultos son un registro que él activa, no su forma de hablar por defecto.',
    marcadas.length ? `\nMarcas del usuario sobre el retrato anterior:\n${marcadas.join('\n')}` : '',
    previous?.opinion ? `\nOpinión anterior (actualízala, no la copies si ya no encaja):\n${previous.opinion}` : '',
    '\n--- MEMORIA PERSONAL (brain.db) ---',
    mem || '(vacía)',
    '\n--- FICHEROS DE MEMORIA (feedback y perfil) ---',
    fil || '(vacíos)',
    seed
      ? [
          '\n--- HECHOS EXTRAÍDOS DE LA MEMORIA DE PROYECTOS (con sus fuentes) ---',
          ...seed.hechos.map((h) => `(${h.bloque}) ${h.texto} [${(h.fuentes || []).join(', ')}]`),
          '\n--- PROYECTOS SEGÚN SU MEMORIA ---',
          ...seed.proyectos.map((p) => `${p.nombre} (${p.items} memorias): ${p.resumen}`),
        ].join('\n')
      : '',
  ].join('\n');
}

export function claimId(texto) {
  return crypto.createHash('sha1').update(String(texto).trim().toLowerCase()).digest('hex').slice(0, 10);
}

/** Extrae el primer objeto JSON de la respuesta del modelo. */
export function parseModelJson(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('la respuesta no contiene un objeto JSON');
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * Normaliza la salida del modelo y la fusiona con el retrato anterior: ids
 * estables por texto, las confirmadas se mantienen aunque el modelo las omita,
 * las descartadas se eliminan.
 */
export function mergePortrait(raw, previous, meta) {
  const prevClaims = new Map();
  for (const b of previous?.bloques || []) {
    for (const a of b.afirmaciones || []) prevClaims.set(a.id, { ...a, bloque: b.id });
  }
  const discarded = new Set([...prevClaims.values()].filter((a) => a.estado === 'discarded').map((a) => a.id));

  const bloques = BLOCKS.map(({ id, titulo }) => {
    const src = (raw?.bloques || []).find((b) => b && b.id === id);
    const seen = new Set();
    const afirmaciones = [];
    for (const a of src?.afirmaciones || []) {
      const texto = String(a?.texto || '').trim();
      if (!texto) continue;
      const cid = claimId(texto);
      if (discarded.has(cid) || seen.has(cid)) continue;
      seen.add(cid);
      const fuentes = Array.isArray(a.fuentes) ? a.fuentes.map(String).slice(0, 5) : [];
      afirmaciones.push({ id: cid, texto, fuentes, estado: prevClaims.get(cid)?.estado || 'none' });
    }
    for (const prev of prevClaims.values()) {
      if (prev.bloque === id && prev.estado === 'confirmed' && !seen.has(prev.id)) {
        const { bloque, ...claim } = prev;
        afirmaciones.push(claim);
        seen.add(prev.id);
      }
    }
    return { id, titulo, afirmaciones };
  });

  return {
    version: 1,
    generated_at: meta.generatedAt,
    model: meta.model,
    stats: meta.stats,
    resumen: String(raw?.resumen || '').trim(),
    bloques,
    proyectos: Array.isArray(raw?.proyectos)
      ? raw.proyectos
          .filter((p) => p && p.nombre)
          .map((p) => ({ nombre: String(p.nombre), que_es: String(p.que_es || ''), estado: String(p.estado || 'desconocido') }))
      : [],
    opinion: String(raw?.opinion || '').trim(),
    trato: String(raw?.trato || '').trim(),
  };
}

export function isFresh(portraitPath, days) {
  try {
    const age = Date.now() - fs.statSync(portraitPath).mtimeMs;
    return age < days * 24 * 3600 * 1000;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Llamada al modelo y escritura
// ---------------------------------------------------------------------------

function resolveClaudeBin() {
  if (process.env.MEMORY_PORTRAIT_CLAUDE_BIN) return process.env.MEMORY_PORTRAIT_CLAUDE_BIN;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidate = path.join(HOME, '.local', 'bin', exe);
  return fs.existsSync(candidate) ? candidate : 'claude';
}

/** Mismos flags que session-summarize-previous.js (ver su cabecera). */
function runClaude(promptText) {
  const env = { ...process.env, CLAUDE_NO_HOOKS: '1' };
  delete env.ANTHROPIC_API_KEY; // suscripción OAuth, no pago por token
  const res = spawnSync(
    resolveClaudeBin(),
    ['-p', '--model', MODEL, '--safe-mode', '--tools', '', '--no-session-persistence', '--output-format', 'json'],
    { cwd: os.tmpdir(), env, input: promptText, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.error) throw new Error(`claude -p no arrancó: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`claude -p status=${res.status}: ${String(res.stderr || '').slice(0, 300)}`);
  const parsed = JSON.parse(res.stdout);
  if (parsed.is_error || typeof parsed.result !== 'string') {
    throw new Error(`claude -p is_error: ${String(parsed.result || '').slice(0, 300)}`);
  }
  return parsed.result;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function countDeprecatedPersonal(dbPath = BRAIN_DB) {
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `select count(*) n from memory_items where status = 'deprecated'
           and (type in ('user_profile', 'preference') or scope = 'global' or project_id is null)`,
      )
      .get().n;
  } finally {
    db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const olderIdx = args.indexOf('--if-older-than');
  if (olderIdx >= 0 && isFresh(PORTRAIT_PATH, Number(args[olderIdx + 1] || 7))) return;

  const memories = readPersonalMemories();
  const files = readMemoryFiles();
  const previous = readPrevious();
  const seed = readSeed();
  const prompt = buildPrompt({ memories, files, previous, seed });
  if (args.includes('--dry-run')) {
    process.stdout.write(`${prompt}\n\n[memory-portrait] ${memories.length} memorias, ${files.length} ficheros, ${prompt.length} caracteres\n`);
    return;
  }

  const raw = parseModelJson(runClaude(prompt));
  const generatedAt = new Date().toISOString();
  const portrait = mergePortrait(raw, previous, {
    generatedAt,
    model: MODEL,
    stats: { memorias_personales: memories.length, ficheros: files.length, deprecadas_personales: countDeprecatedPersonal() },
  });
  writeAtomic(PORTRAIT_PATH, portrait);
  writeAtomic(path.join(PORTRAIT_DIR, 'history', `${generatedAt.slice(0, 10)}.json`), portrait);
  process.stdout.write(`[memory-portrait] retrato escrito: ${PORTRAIT_PATH}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    process.stderr.write(`[memory-portrait] error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
