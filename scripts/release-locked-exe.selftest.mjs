// release-locked-exe.selftest.mjs — el build de ULTRON aparta el .exe en uso
// en vez de cerrar la app (control-center/scripts/release-locked-exe.mjs).
// Simula el target de cargo con una copia de ping.exe en ejecución y su hard
// link: tras apartarlo, los dos nombres admiten un binario nuevo y el proceso
// viejo sigue vivo. Sin ejecución, no se toca nada (caso negativo).
//
// Uso: node scripts/release-locked-exe.selftest.mjs   (exit 0 = verde; solo Windows)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  exePaths,
  isLocked,
  releaseLockedExe,
  sweepOld,
} from '../control-center/scripts/release-locked-exe.mjs';

const isWindows = process.platform === 'win32';
const PING = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE');

/** Target de cargo falso: deps/control_center.exe + hard link control-center.exe. */
function fakeTarget() {
  const dir = mkdtempSync(join(tmpdir(), 'release-exe-'));
  mkdirSync(join(dir, 'deps'));
  const [launched, linked] = exePaths(dir);
  copyFileSync(PING, linked);
  linkSync(linked, launched);
  return dir;
}

test('sin la app abierta no se aparta nada (caso negativo)', { skip: !isWindows }, () => {
  const dir = fakeTarget();
  try {
    assert.deepEqual(releaseLockedExe(dir, 1), { status: 'free', moved: [] });
    for (const f of exePaths(dir)) assert.ok(existsSync(f));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('con la app abierta aparta los dos nombres y el proceso sigue vivo', { skip: !isWindows }, async () => {
  const dir = fakeTarget();
  const [launched, linked] = exePaths(dir);
  const child = spawn(launched, ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  try {
    await sleep(500);
    assert.equal(isLocked(linked), true, 'el binario en ejecución debe estar bloqueado');

    const r = releaseLockedExe(dir, 42);
    assert.equal(r.status, 'moved');
    assert.equal(r.moved.length, 2);
    for (const f of exePaths(dir)) assert.equal(existsSync(f), false);

    // El enlazador puede escribir el binario nuevo en los dos nombres.
    copyFileSync(PING, linked);
    linkSync(linked, launched);
    assert.equal(child.exitCode, null, 'el proceso viejo no debe morir');

    // Mientras corre, el apartado no se borra; después, sí.
    assert.ok(sweepOld(dir).kept.length >= 1);
    child.kill();
    await new Promise((res) => child.once('exit', res));
    await sleep(300);
    sweepOld(dir);
    const left = [...readdirSync(dir), ...readdirSync(join(dir, 'deps'))].filter((n) => n.includes('.old-'));
    assert.deepEqual(left, []);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
