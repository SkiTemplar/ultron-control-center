#!/usr/bin/env node
'use strict';
/**
 * new-web.mjs — scaffold de un proyecto-web de webponize.
 *
 * Crea cockpit/projects/web-<slug>/ con:
 *   - kanban.json (columnas de build + default_agent/prompt)
 *   - site/, variants/b/, variants/c/  (cada una con un index.html placeholder)
 * Registra el proyecto en cockpit/projects.json (status manual) para que
 * aparezca en la GUI de ULTRON, y crea la card en el pipeline webponize
 * (columna Prospecto) via kanban.mjs.
 *
 * Uso:
 *   node scripts/new-web.mjs <slug> "<Negocio>" [--tipo <sector>] [--maps <url>] [--tier front|front+backend]
 *
 * <slug> es el identificador del negocio en kebab-case SIN el prefijo "web-"
 * (el script lo anade). Ej:
 *   node scripts/new-web.mjs peluqueria-sol "Peluqueria Sol" --tipo peluqueria
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, '..');
const PROJECTS = join(ULTRON, 'cockpit', 'projects');
const REGISTRY = join(ULTRON, 'cockpit', 'projects.json');
const PIPELINE = 'webponize';

function fail(msg) {
  console.error(`[new-web] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opts[a.slice(2)] = argv[++i] ?? '';
    else pos.push(a);
  }
  return { pos, opts };
}

const { pos, opts } = parseArgs(process.argv.slice(2));
const rawSlug = pos[0];
const negocio = pos[1];
if (!rawSlug || !negocio) {
  fail('uso: new-web <slug> "<Negocio>" [--tipo <sector>] [--maps <url>] [--tier front|front+backend]');
}

const slug = rawSlug
  .replace(/^web-/, '')
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+|-+$/g, '');
if (!slug) fail(`slug invalido a partir de "${rawSlug}"`);

const projId = `web-${slug}`;
const projDir = join(PROJECTS, projId);
const tipo = opts.tipo || '';
const tier = opts.tier || 'front';

if (existsSync(projDir)) fail(`ya existe ${projDir}`);

// 1) kanban.json de construccion
const col = (n, name, order, role) => ({ id: `${slug}-col-${n}`, name, order, role });
const board = {
  project_id: projId,
  columns: [
    col(1, 'Contenido / research', 0, 'todo'),
    col(2, 'Theme / identidad', 1, 'doing'),
    col(3, 'Secciones', 2, 'doing'),
    col(4, 'Backend + panel', 3, 'doing'),
    col(5, 'Deploy Vercel', 4, 'doing'),
    col(6, 'QA', 5, 'blocked'),
    col(7, 'Hecho', 6, 'done'),
  ],
  cards: [],
  default_agent: 'frontend-developer',
  default_prompt_template:
    'Construye UNA web RESPONSIVE (mobile-first, menu hamburguesa en movil) clonando la identidad REAL del negocio (logo, colores de su marca/sector) y usando sus FOTOS PUBLICAS de Google Maps. Cero gradientes morados ni estetica generica de IA. Incluye un selector de disenos DEMO separable: 2-3 esteticas conmutables sobre el mismo contenido, en un bloque HTML/JS delimitado por comentarios para poder quitarlo en la version final. Backend (sistema de reservas + panel de administracion, via Supabase) solo si el tier lo pide.',
  schema_version: 1,
};
mkdirSync(projDir, { recursive: true });
writeFileSync(join(projDir, 'kanban.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');

// 2) site/ + variants/b + variants/c con placeholder desplegable
const placeholder = (label) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${negocio}</title></head>
<body style="font-family:system-ui;max-width:42rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a">
<h1>${negocio}</h1>
<p>Variante ${label} &mdash; pendiente de construir.</p>
</body></html>
`;
for (const [rel, label] of [['site', 'A'], ['variants/b', 'B'], ['variants/c', 'C']]) {
  const d = join(projDir, ...rel.split('/'));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'index.html'), placeholder(label), 'utf8');
}

// 3) registro en projects.json (para que salga en la GUI)
const today = new Date().toISOString().slice(0, 10);
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
registry.projects = registry.projects || [];
if (!registry.projects.some((p) => p.id === projId)) {
  registry.projects.unshift({
    auto_tags: [],
    deadline: null,
    id: projId,
    ide: 'vscode',
    language: 'HTML',
    last_active: today,
    name: negocio,
    path: projDir,
    status: 'manual',
    tags: ['oryntics', 'web'],
    type: 'web',
  });
  writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

// 4) card en el pipeline (reusa kanban.mjs, no duplica el schema)
const desc = [
  tipo && `tipo: ${tipo}`,
  opts.maps && `maps: ${opts.maps}`,
  `tier: ${tier}`,
  `web_slug: ${projId}`,
  'precio_setup: TBD',
  'precio_mantenimiento: TBD',
]
  .filter(Boolean)
  .join('\n');
const tags = [tipo, tier].filter(Boolean).join(',');
const kbArgs = ['scripts/kanban.mjs', 'add', PIPELINE, 'Prospecto', negocio, desc];
if (tags) kbArgs.push('--tags', tags);
execFileSync('node', kbArgs, { cwd: ULTRON, stdio: 'inherit' });

console.log(`
[new-web] OK
  proyecto:  ${projId}
  carpeta:   ${projDir}
  registro:  projects.json (status manual) -> visible en la GUI tras refrescar
  card:      "${negocio}" en ${PIPELINE} / Prospecto
  siguiente: construir las 3 variantes y luego:
             node scripts/deploy-variants.mjs ${slug}`);
