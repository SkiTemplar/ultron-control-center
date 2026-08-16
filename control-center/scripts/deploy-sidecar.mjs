// Despliega el sidecar recién compilado a ~/.ultron/bin/ — el binario que usan
// los hooks y el harness.
//
// Por qué existe (2026-08-16): `npm run build:local` recompila ultron-memory
// dentro de target/release/ pero nadie lo copiaba a ~/.ultron/bin/, así que
// cada build dejaba el sidecar desplegado STALE (check 7.7 del harness en rojo
// y, peor, hooks corriendo un binario viejo mientras el código decía otra
// cosa). El paso manual "acuérdate de copiarlo" se olvidó suficientes veces
// como para automatizarlo aquí, al final del build.
//
// El daemon residente (`ultron-memory serve`) mantiene el .exe bloqueado en
// Windows; se le pide shutdown limpio por su socket TCP (lockfile en
// ~/.ultron/run/orchestrate.json) antes de copiar. El siguiente prompt de
// Claude Code lo relanza solo (memory-orchestrate hace spawnDetached).
import { existsSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === "win32" ? "ultron-memory.exe" : "ultron-memory";
const SRC = path.join(here, "..", "src-tauri", "target", "release", exe);
const DST = path.join(homedir(), ".ultron", "bin", exe);
const LOCK = path.join(homedir(), ".ultron", "run", "orchestrate.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pide al daemon que pare (best-effort). Resuelve cuando responde o falla. */
function requestShutdown() {
  return new Promise((resolve) => {
    let lock = null;
    try {
      lock = JSON.parse(readFileSync(LOCK, "utf8"));
    } catch {
      return resolve(false); // sin lockfile = sin daemon
    }
    if (!lock || !Number.isInteger(lock.port) || typeof lock.token !== "string") {
      return resolve(false);
    }
    const sock = connect({ host: "127.0.0.1", port: lock.port });
    const done = (v) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    sock.setTimeout(5000);
    sock.on("connect", () => {
      try {
        sock.write(JSON.stringify({ token: lock.token, cmd: "shutdown" }) + "\n");
      } catch {
        done(false);
      }
    });
    sock.on("data", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

async function main() {
  if (!existsSync(SRC)) {
    // Build sin la feature qdrant (no produce sidecar): nada que desplegar.
    console.log(`[deploy-sidecar] sin binario en ${SRC} — nada que desplegar.`);
    return;
  }
  // Hasta 3 intentos: el daemon puede tardar un par de segundos en soltar el
  // .exe tras aceptar el shutdown.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await requestShutdown();
    await sleep(attempt * 1500);
    try {
      copyFileSync(SRC, DST);
      const a = statSync(SRC).size;
      const b = statSync(DST).size;
      if (a !== b) throw new Error(`tamaños distintos tras copiar (${a} vs ${b})`);
      console.log(`[deploy-sidecar] desplegado ${DST} (${(b / 1048576).toFixed(1)} MB)`);
      return;
    } catch (e) {
      if (attempt === 3) {
        // Mandamiento 11: nada de no-ops silenciosos. El build no se rompe por
        // esto, pero el aviso tiene que ser inconfundible.
        console.error(
          `[deploy-sidecar] AVISO: NO se pudo desplegar el sidecar (${e.message || e}). ` +
            `El binario de ~/.ultron/bin/ queda STALE: los hooks corren código viejo. ` +
            `Cierra el proceso ultron-memory y copia a mano:\n  cp "${SRC}" "${DST}"`
        );
      }
    }
  }
}

await main();
