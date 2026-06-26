#!/usr/bin/env node
'use strict';
/**
 * deploy-variants.mjs — despliega las 3 variantes de un web-<slug> a Vercel y
 * desactiva la Vercel Authentication (deployment protection) de cada una, para
 * que las URLs sean publicas. Devuelve las 3 URLs.
 *
 * Proyectos Vercel creados/actualizados:
 *   <slug>     <- site/        (variante A)
 *   <slug>-b   <- variants/b/  (variante B)
 *   <slug>-c   <- variants/c/  (variante C)
 *
 * Requiere la CLI de Vercel instalada y con sesion (vercel login). El token se
 * lee de %APPDATA%\\com.vercel.cli\\Data\\auth.json.
 *
 * Uso:
 *   node scripts/deploy-variants.mjs <slug> [--dry-run]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, '..');
const PROJECTS = join(ULTRON, 'cockpit', 'projects');

function fail(msg) {
  console.error(`[deploy-variants] ERROR: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const rawSlug = argv.find((a) => !a.startsWith('--'));
if (!rawSlug) fail('uso: deploy-variants <slug> [--dry-run]');
// Sanear a [a-z0-9-]: el slug se interpola en comandos de shell (vercel) y en
// nombres de proyecto Vercel, asi que no puede contener metacaracteres.
const slug = rawSlug
  .replace(/^web-/, '')
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+|-+$/g, '');
if (!slug) fail(`slug invalido a partir de "${rawSlug}"`);
const projDir = join(PROJECTS, `web-${slug}`);
if (!existsSync(projDir)) fail(`no existe ${projDir}`);

const authPath = join(process.env.APPDATA || '', 'com.vercel.cli', 'Data', 'auth.json');
function vercelToken() {
  if (!existsSync(authPath)) fail(`auth.json no encontrado en ${authPath} (¿vercel login?)`);
  const t = JSON.parse(readFileSync(authPath, 'utf8')).token;
  if (!t) fail('token vacio en auth.json');
  return t;
}

const variants = [
  { dir: join(projDir, 'site'), project: slug },
  { dir: join(projDir, 'variants', 'b'), project: `${slug}-b` },
  { dir: join(projDir, 'variants', 'c'), project: `${slug}-c` },
];

const results = [];
for (const v of variants) {
  if (!existsSync(join(v.dir, 'index.html'))) {
    console.warn(`[skip] ${v.dir} sin index.html`);
    continue;
  }
  if (dryRun) {
    console.log(`[dry-run] ${v.project}: link + deploy ${v.dir} -> desactivar ssoProtection`);
    continue;
  }
  console.log(`\n=== ${v.project} ===`);
  execSync(`vercel link --yes --project ${v.project} --cwd "${v.dir}"`, { stdio: 'inherit' });
  const out = execSync(`vercel deploy --prod --yes --cwd "${v.dir}"`, { encoding: 'utf8' });
  const matches = out.match(/https:\/\/[^\s]+\.vercel\.app/g);
  const url = matches ? matches[matches.length - 1] : null;

  // desactivar deployment protection (si no, Vercel sirve un login)
  const pj = JSON.parse(readFileSync(join(v.dir, '.vercel', 'project.json'), 'utf8'));
  const uri = `https://api.vercel.com/v9/projects/${pj.projectId}?teamId=${pj.orgId}`;
  const resp = await fetch(uri, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${vercelToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ssoProtection: null }),
  });
  results.push({ project: v.project, url, protOff: resp.ok });
}

if (!dryRun) {
  console.log('\n[deploy-variants] URLs:');
  for (const r of results) {
    console.log(`  ${r.project.padEnd(30)} ${r.url}  (proteccion ${r.protOff ? 'OFF' : 'FALLO'})`);
  }
}
