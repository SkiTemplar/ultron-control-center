// generators.mjs — ejecucion de los generadores externos (uv, vite, cargo)
// que scaffoldean un proyecto sobre una carpeta ya creada.

import { spawnSync } from 'node:child_process';
import {
  dirname, basename, resolve,
} from 'node:path';
import { existsSync } from 'node:fs';

export function runGenerator(templateId, projectPath, nameLower) {
  const parent = dirname(projectPath);
  const leaf = basename(projectPath);
  let cmd;
  let args;
  if (templateId === 'python-uv') {
    cmd = 'uv';
    args = ['init', '--name', nameLower, leaf];
  } else if (templateId === 'web-vite-react-ts') {
    // En Windows `npm` es un .cmd y Node lo ejecuta a traves de cmd.exe aunque
    // shell sea false (CVE-2024-27980): se invoca npm-cli.js con el propio node.
    const npmArgs = ['create', 'vite@latest', leaf, '--', '--template', 'react-ts'];
    if (process.platform === 'win32') {
      const npmCli = resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!existsSync(npmCli)) throw new Error(`no se encontro npm-cli.js junto a node: ${npmCli}`);
      cmd = process.execPath;
      args = [npmCli, ...npmArgs];
    } else {
      cmd = 'npm';
      args = npmArgs;
    }
  } else if (templateId === 'rust-cargo') {
    cmd = 'cargo';
    args = ['new', leaf];
  } else {
    throw new Error(`generador desconocido: ${templateId}`);
  }
  const r = spawnSync(cmd, args, {
    cwd: parent, encoding: 'utf8', timeout: 5 * 60 * 1000, shell: false,
  });
  if (r.error) throw new Error(`"${cmd}" no se pudo ejecutar: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`"${cmd} ${args.join(' ')}" fallo (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  }
}
