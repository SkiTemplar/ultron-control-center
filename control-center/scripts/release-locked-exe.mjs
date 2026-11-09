// release-locked-exe.mjs — libera el ejecutable de la app antes de un build
// sin cerrarla.
//
// En Windows un .exe en ejecución no se puede sobrescribir, pero sí
// renombrar. Cargo deja target/release/control-center.exe como hard link de
// target/release/deps/control_center.exe: los dos nombres apuntan al mismo
// fichero bloqueado. Este script aparta ambos a `*.old-<ts>.exe`; la app
// abierta sigue corriendo con el binario viejo (y con ella las sesiones de
// Sessions y Pupus), el enlazado escribe el nuevo y el cambio entra al
// reiniciar ULTRON. Los apartados de builds anteriores se borran cuando ya
// nadie los ejecuta.
//
// Si el renombrado falla, cae al cierre forzoso (kill-running-app.mjs) y lo
// dice: el build no puede seguir con el .exe bloqueado.
//
// Uso: node scripts/release-locked-exe.mjs   (lo llaman build:local y build:app)

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RELEASE_DIR = resolve(SCRIPT_DIR, "..", "src-tauri", "target", "release");

/** Los dos nombres del binario: el que se lanza y el que escribe el enlazador. */
export function exePaths(releaseDir) {
  return [join(releaseDir, "control-center.exe"), join(releaseDir, "deps", "control_center.exe")];
}

/** ¿Lo tiene abierto un proceso? Un .exe en ejecución no admite escritura. */
export function isLocked(file) {
  try {
    closeSync(openSync(file, "r+"));
    return false;
  } catch (e) {
    if (e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES") return true;
    throw e;
  }
}

function oldName(file, stamp) {
  return file.replace(/\.exe$/i, `.old-${stamp}.exe`);
}

/**
 * Borra los apartados de builds anteriores. Los que siguen en ejecución
 * (otra instancia vieja abierta) se dejan para el siguiente build.
 * @returns {{removed: string[], kept: string[]}}
 */
export function sweepOld(releaseDir) {
  const removed = [];
  const kept = [];
  for (const file of exePaths(releaseDir)) {
    const dir = dirname(file);
    const base = file.slice(dir.length + 1).replace(/\.exe$/i, "");
    const pattern = new RegExp(`^${base.replace(/[-.]/g, "\\$&")}\\.old-\\d+\\.exe$`, "i");
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries.filter((n) => pattern.test(n))) {
      const full = join(dir, name);
      try {
        unlinkSync(full);
        removed.push(full);
      } catch (e) {
        if (e.code !== "EBUSY" && e.code !== "EPERM" && e.code !== "EACCES") throw e;
        kept.push(full);
      }
    }
  }
  return { removed, kept };
}

/**
 * Aparta los nombres del binario si está en ejecución. Si el segundo
 * renombrado falla, deshace el primero para no dejar el target a medias.
 * @returns {{status: "free"|"moved"|"failed", moved: string[], error?: string}}
 */
export function releaseLockedExe(releaseDir = DEFAULT_RELEASE_DIR, stamp = Date.now()) {
  const present = exePaths(releaseDir).filter((f) => existsSync(f));
  if (!present.some(isLocked)) return { status: "free", moved: [] };
  const done = [];
  try {
    for (const file of present) {
      const target = oldName(file, stamp);
      renameSync(file, target);
      done.push([file, target]);
    }
  } catch (e) {
    for (const [file, target] of done.reverse()) renameSync(target, file);
    return { status: "failed", moved: [], error: e.message };
  }
  return { status: "moved", moved: done.map(([, target]) => target) };
}

function main() {
  if (process.platform !== "win32") return 0;
  const { kept } = sweepOld(DEFAULT_RELEASE_DIR);
  if (kept.length) console.log(`[release-exe] ${kept.length} binario(s) viejo(s) siguen en uso; se borrarán en otro build.`);
  const r = releaseLockedExe();
  if (r.status === "free") return 0;
  if (r.status === "moved") {
    console.log("[release-exe] ULTRON sigue abierto con el binario anterior; el nuevo entra al reiniciarlo.");
    return 0;
  }
  console.error(`[release-exe] no se pudo apartar el .exe en uso (${r.error}); se cierra ULTRON para poder enlazar.`);
  const k = spawnSync("node", [join(SCRIPT_DIR, "kill-running-app.mjs")], { stdio: "inherit" });
  return k.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
