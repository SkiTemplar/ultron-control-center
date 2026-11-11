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
    id: 'web-nextjs-supabase', label: 'Web/SaaS (Next.js + Supabase)',
    description: 'create-next-app (App Router, TS, Tailwind, src/, pnpm, AGENTS.md); Supabase se conecta despues con su CLI.',
    kinds: ['personal'], requires: ['npm', 'pnpm'],
  },
  {
    id: 'app-expo', label: 'App movil (Expo + React Native)',
    description: 'create-expo-app con la plantilla default (Expo Router, TS); sin AGENTS.md ni .claude/settings.json propios.',
    kinds: ['personal'], requires: ['npm'],
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

/** Nombre de proyecto -> identificador C++/C# valido en PascalCase ("Mi Juego" -> "MiJuego"). */
export function toIdentifier(name) {
  const parts = String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let id = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('');
  if (!id) id = 'Project';
  if (/^[0-9]/.test(id)) id = `P${id}`;
  return id;
}

const UNITY_FALLBACK_VERSION = '6000.0.60f1';

/** Version de editor de Unity mas reciente instalada en Unity Hub; si no hay ninguna, una LTS conocida. */
export function detectUnityVersion() {
  const dir = process.env.ULTRON_UNITY_EDITORS_DIR || 'C:/Program Files/Unity/Hub/Editor';
  try {
    const key = (v) => v.split(/[.f]/).map(Number);
    const versions = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name.split('-')[0])
      .filter((v) => /^\d+\.\d+\.\d+f\d+$/.test(v))
      .sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
        return 0;
      });
    return versions.length ? versions[versions.length - 1] : UNITY_FALLBACK_VERSION;
  } catch {
    return UNITY_FALLBACK_VERSION;
  }
}
