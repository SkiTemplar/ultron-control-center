// templates.mjs — catalogo de plantillas locales y generadores externos,
// deteccion de binarios disponibles, e interpolacion/copia de ficheros de
// plantilla.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { CliError } from './errors.mjs';
import { TEMPLATES_DIR } from './paths.mjs';

export const GENERATORS = [
  {
    id: 'python-uv', label: 'Python (uv)',
    description: 'Proyecto Python inicializado con "uv init".',
    kinds: ['asignatura', 'personal'], requires: ['uv'],
  },
  {
    id: 'web-vite-react-ts', label: 'Web (Vite + React + TS)',
    description: 'Scaffold de Vite con la plantilla oficial react-ts.',
    kinds: ['asignatura', 'personal'], requires: ['npm'],
  },
  {
    id: 'rust-cargo', label: 'Rust (Cargo)',
    description: 'Proyecto Rust inicializado con "cargo new".',
    kinds: ['asignatura', 'personal'], requires: ['cargo'],
  },
];

export function isBinaryAvailable(bin) {
  // vcpkg rara vez esta en PATH: su instalacion estandar exporta VCPKG_ROOT,
  // que es ademas lo que usa el CMakePresets de la plantilla OpenGL.
  if (bin === 'vcpkg' && process.env.VCPKG_ROOT) {
    const exe = process.platform === 'win32' ? 'vcpkg.exe' : 'vcpkg';
    if (existsSync(resolve(process.env.VCPKG_ROOT, exe))) return true;
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [bin], { encoding: 'utf8' });
  return r.status === 0;
}

export function listLocalTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const metaPath = join(TEMPLATES_DIR, d.name, 'template.json');
      if (!existsSync(metaPath)) return null;
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      return { ...meta, dir: join(TEMPLATES_DIR, d.name) };
    })
    .filter(Boolean);
}

export function resolveTemplate(templateId) {
  const local = listLocalTemplates().find((t) => t.id === templateId);
  if (local) return { ...local, source: 'local' };
  const gen = GENERATORS.find((g) => g.id === templateId);
  if (gen) return { ...gen, source: 'generator' };
  return null;
}

export function cmdTemplates(flags) {
  if (flags.kind && !['asignatura', 'personal'].includes(flags.kind)) {
    throw new CliError('BAD_ARGS', `--kind debe ser "asignatura" o "personal", recibido: ${flags.kind}`);
  }
  const local = listLocalTemplates().map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    source: 'local',
    requires: t.requires || [],
    available: (t.requires || []).every(isBinaryAvailable),
    kinds: t.kinds || ['asignatura', 'personal'],
  }));
  const generators = GENERATORS.map((g) => ({
    ...g,
    source: 'generator',
    available: g.requires.every(isBinaryAvailable),
  }));
  let all = [...local, ...generators];
  if (flags.kind) all = all.filter((t) => t.kinds.includes(flags.kind));
  return { templates: all };
}

export function substituteVars(content, vars) {
  return content.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}

export function copyTemplateFiles(srcDir, destDir, vars, filesCreated) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, substituteVars(entry.name, vars));
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyTemplateFiles(srcPath, destPath, vars, filesCreated);
    } else {
      const raw = readFileSync(srcPath, 'utf8');
      writeFileSync(destPath, substituteVars(raw, vars), 'utf8');
      filesCreated.push(destPath);
    }
  }
}
