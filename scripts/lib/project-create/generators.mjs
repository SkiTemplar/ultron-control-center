// generators.mjs — ejecucion de los generadores externos (uv, vite, next,
// expo, cargo) que scaffoldean un proyecto sobre una carpeta ya creada.

import { spawnSync } from 'node:child_process';
import {
  dirname, basename, resolve, join,
} from 'node:path';
import {
  existsSync, readdirSync, renameSync, rmSync,
} from 'node:fs';

// Generadores que se generan sin instalar y se instalan ya en la carpeta final:
// pnpm crea enlaces con ruta absoluta en node_modules y moverlos los rompe.
const INSTALL_AFTER_MOVE = { 'web-nextjs-supabase': 'pnpm install' };

// Argumentos de `npm` por generador basado en npm. Todos son no interactivos.
const NPM_GENERATORS = {
  'web-vite-react-ts': (leaf) => ['create', 'vite@latest', leaf, '--', '--template', 'react-ts'],
  // git lo inicializa el propio creador; AGENTS.md apunta a la documentacion
  // de Next.js que viene con el paquete instalado.
  'web-nextjs-supabase': (leaf) => [
    'create', 'next-app@latest', leaf, '--',
    '--ts', '--tailwind', '--eslint', '--app', '--src-dir', '--import-alias', '@/*',
    '--use-pnpm', '--agents-md', '--no-agent-feedback', '--disable-git', '--skip-install', '--yes',
  ],
  // --no-agents-md: evita que create-expo-app escriba un .claude/settings.json
  // propio; las skills de Expo se enlazan desde la pool, fijadas y revisadas.
  'app-expo': (leaf) => [
    'create', 'expo-app@latest', leaf, '--', '--template', 'default', '--no-agents-md', '--yes',
  ],
};

// En Windows `npm` es un .cmd y Node lo ejecuta a traves de cmd.exe aunque
// shell sea false (CVE-2024-27980): se invoca npm-cli.js con el propio node.
function npmCommand(npmArgs) {
  if (process.platform !== 'win32') return { cmd: 'npm', args: npmArgs };
  const npmCli = resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error(`no se encontro npm-cli.js junto a node: ${npmCli}`);
  return { cmd: process.execPath, args: [npmCli, ...npmArgs] };
}

export function generatorCommand(templateId, leaf, nameLower) {
  if (templateId === 'python-uv') return { cmd: 'uv', args: ['init', '--name', nameLower, leaf] };
  if (templateId === 'rust-cargo') return { cmd: 'cargo', args: ['new', leaf] };
  const npmArgs = NPM_GENERATORS[templateId];
  if (npmArgs) return npmCommand(npmArgs(leaf));
  throw new Error(`generador desconocido: ${templateId}`);
}

/** Nombre de paquete npm valido (minusculas, sin espacios) derivado del nombre del proyecto. */
export function npmPackageName(nameLower) {
  const name = String(nameLower).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|-+$/g, '');
  return name || 'app';
}

function spawnChecked(cmd, args, cwd, shell = false) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout: 10 * 60 * 1000, shell,
  });
  if (r.error) throw new Error(`"${cmd}" no se pudo ejecutar: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`"${cmd} ${args.join(' ')}" fallo (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  }
}

// Los generadores npm toman el nombre del paquete de la carpeta y rechazan
// mayusculas o espacios: se generan en una subcarpeta con nombre npm valido y
// su contenido se sube a la carpeta del proyecto.
function runNpmGeneratorStaged(templateId, projectPath, nameLower) {
  const leaf = npmPackageName(nameLower);
  const staging = join(projectPath, leaf);
  if (existsSync(staging)) throw new Error(`la carpeta temporal del generador ya existe: ${staging}`);
  const { cmd, args } = generatorCommand(templateId, leaf, nameLower);
  try {
    spawnChecked(cmd, args, projectPath);
    for (const entry of readdirSync(staging)) renameSync(join(staging, entry), join(projectPath, entry));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const install = INSTALL_AFTER_MOVE[templateId];
  // Comando constante sin datos del usuario: shell solo para resolver el .cmd de pnpm en Windows.
  if (install) spawnChecked(install, [], projectPath, true);
}

export function runGenerator(templateId, projectPath, nameLower) {
  if (NPM_GENERATORS[templateId]) {
    runNpmGeneratorStaged(templateId, projectPath, nameLower);
    return;
  }
  const { cmd, args } = generatorCommand(templateId, basename(projectPath), nameLower);
  spawnChecked(cmd, args, dirname(projectPath));
}
