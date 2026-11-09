// scheduler-tasks.selftest.mjs — install-scheduler.ps1 solo toca sus tareas.
//
// El instalador seleccionaba "Ultron*" (comodín sin distinguir mayúsculas), así
// que su limpieza previa y -Uninstall borraban tareas de otros instaladores
// (ULTRON-BitacoraSweep, UltronQdrant, ULTRON-QdrantWatchdog). Aquí se prueba el
// filtro puro de scheduler-tasks.ps1 con tareas falsas (nunca se llama al
// Programador de tareas) y que el instalador no selecciona nada sin pasar por él.
//
// Uso: node scripts/cockpit/scheduler-tasks.selftest.mjs   (exit 0 = verde; solo Windows)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, 'scheduler-tasks.ps1');
const INSTALLER = join(HERE, 'install-scheduler.ps1');
const isWindows = process.platform === 'win32';

const FAKE_TASKS = [
  ['UltronScanProjects-Login', 'python.exe scan_projects.py'],
  ['UltronDoctor-Weekly', 'python.exe doctor.py'],
  ['UltronRetention-Daily', 'python.exe retention.py'],
  ['ULTRON-BitacoraSweep', 'node.exe bitacora-sweep.mjs'],
  ['ULTRON-QdrantWatchdog', 'powershell.exe watchdog.ps1'],
  ['UltronQdrant', 'qdrant.exe'],
  ['ultronscanprojects-login', 'python.exe scan_projects.py'],
  ['UltronBackup-Weekly', 'powershell.exe -File weekly-backup.ps1'],
];

/** Ejecuta el filtro en PowerShell 5.1 y devuelve los nombres seleccionados. */
function selectWithHelper(shortNames) {
  const tasks = FAKE_TASKS.map(
    ([name, action]) =>
      `[pscustomobject]@{ TaskName = '${name}'; Actions = @([pscustomobject]@{ Execute = '${action.split(' ')[0]}'; Arguments = '${action.split(' ').slice(1).join(' ')}' }) }`,
  ).join(', ');
  const names = shortNames.map((n) => `'${n}'`).join(', ');
  const script = [
    `. '${HELPER}'`,
    `$owned = Get-CockpitOwnedNames @(${names})`,
    `$picked = Select-CockpitTasks @(${tasks}) $owned`,
    `ConvertTo-Json -Compress @($picked | ForEach-Object { $_.TaskName })`,
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim() || '[]');
}

test('solo selecciona las tareas propias, por nombre exacto', { skip: !isWindows }, () => {
  const picked = selectWithHelper(['ScanProjects-Login', 'Doctor-Weekly']);
  assert.deepEqual(picked.sort(), ['UltronDoctor-Weekly', 'UltronRetention-Daily', 'UltronScanProjects-Login']);
});

test('no toca tareas de otros instaladores ni la de backup (caso negativo)', { skip: !isWindows }, () => {
  const picked = selectWithHelper(['ScanProjects-Login', 'Doctor-Weekly', 'Backup-Weekly']);
  for (const foreign of ['ULTRON-BitacoraSweep', 'ULTRON-QdrantWatchdog', 'UltronQdrant', 'ultronscanprojects-login']) {
    assert.ok(!picked.includes(foreign), `${foreign} seleccionada: ${picked}`);
  }
  assert.ok(!picked.includes('UltronBackup-Weekly'), 'la tarea de backup es de Settings -> Backups');
});

test('el instalador pasa toda seleccion por Select-CockpitTasks', () => {
  const src = readFileSync(INSTALLER, 'utf8');
  const gets = src.match(/Get-ScheduledTask\b/g) ?? [];
  const filtered = src.match(/Select-CockpitTasks\b/g) ?? [];
  assert.ok(gets.length > 0, 'el instalador consulta el Programador');
  assert.equal(filtered.length, gets.length, 'cada Get-ScheduledTask pasa por el filtro');
  assert.match(src, /\. \(Join-Path \$PSScriptRoot "scheduler-tasks\.ps1"\)/);
});

test('los dos .ps1 parsean en PowerShell 5.1 (sin ejecutarlos)', { skip: !isWindows }, () => {
  for (const f of [HELPER, INSTALLER]) {
    const script =
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e); ` +
      `ConvertTo-Json -Compress @($e | ForEach-Object { $_.Message })`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim() || '[]'), [], f);
  }
});

test('los dos .ps1 son ASCII puro (PowerShell 5.1)', () => {
  for (const f of [HELPER, INSTALLER]) {
    const bad = [...readFileSync(f, 'utf8')].filter((c) => c.charCodeAt(0) > 127);
    assert.deepEqual(bad, [], f);
  }
});
