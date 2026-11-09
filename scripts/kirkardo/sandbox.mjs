/**
 * kirkardo/sandbox.mjs — HOME aislado para los hooks que ejecuta el harness.
 *
 * Por que (auditoria 2026-10-23, medidor-1/6/12): los checks lanzaban los hooks
 * reales con el HOME de produccion. Cada corrida escribia hook-timing.jsonl y
 * hook-tokens.jsonl (los ficheros que miden 1.5, 15.1 y 16.5), dejaba lineas en
 * hook-errors.jsonl y, via 7.9, resumia la sesion viva y la fusionaba en la
 * bitacora (estado.json), que es lo que mide 1.8.
 *
 * Los hooks resuelven todo desde os.homedir(), que en Windows y en POSIX sale
 * de USERPROFILE / HOME: con esas dos variables apuntando a un directorio
 * temporal, sus escrituras (logs, .tmp, bitacora, estado de cadencias) caen
 * ahi. Se copian solo las ENTRADAS de solo lectura que necesitan (registro de
 * proyectos, bitacora y kanban del proyecto medido, personalidad).
 *
 * El sidecar Rust NO ve este HOME (dirs::home_dir usa la Known Folder del
 * perfil): por eso, salvo que el check lo pida, ULTRON_MEMORY_BIN apunta a un
 * fichero inexistente y los hooks no encuentran binario (ni gc, ni capture, ni
 * drain contra el brain.db real). Con `realBin`, solo para los checks del
 * resume (lectura), se apaga ademas el refresco de hubs (ULTRON_HUBS_REFRESH).
 */
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Entradas de solo lectura que los hooks medidos leen del HOME. El lockfile del
 * daemon (lleva su token TCP) solo se copia con el orchestrate en modo
 * completo, que es cuando el hook le pregunta (como en una sesion real); en
 * modo ligero no sale de ~/.ultron/run.
 */
export function sandboxInputs(project, { withDaemonLock = false } = {}) {
  const inputs = [
    ["cockpit", "projects.json"],
    ["cockpit", "project-identity.json"],
    ["personality.json"],
    ["cockpit", "projects", project, "estado.json"],
    ["cockpit", "projects", project, "kanban.json"],
    ["cockpit", "projects", project, "memory-stale.json"],
  ];
  return withDaemonLock ? [...inputs, ["run", "orchestrate.json"]] : inputs;
}

/**
 * Crea el HOME aislado. Devuelve { root, ultron, logs, env(opts), countLines,
 * cleanup }. `env({ realBin })` da el entorno del hijo; sin realBin los hooks
 * no encuentran el sidecar.
 */
export function makeHookSandbox({ ultronRoot, project, baseEnv = process.env, tmpRoot = tmpdir(), withDaemonLock = false }) {
  const root = mkdtempSync(join(tmpRoot, "kirkardo-sbx-"));
  const ultron = join(root, ".ultron");
  const logs = join(ultron, "logs");
  for (const d of [logs, join(ultron, ".tmp"), join(ultron, "run"), join(ultron, "cockpit", "projects", project), join(root, ".claude", "logs")]) {
    mkdirSync(d, { recursive: true });
  }
  const copied = [];
  for (const parts of sandboxInputs(project, { withDaemonLock })) {
    const src = join(ultronRoot, ...parts);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(ultron, ...parts));
    copied.push(parts.join("/"));
  }
  const absentBin = join(ultron, "bin", "__sin-sidecar__.exe");
  const env = ({ realBin = null, extra = {} } = {}) => {
    const e = {
      ...baseEnv,
      USERPROFILE: root,
      HOME: root,
      ULTRON_ROOT: ultron,
      LAST_SESSION_PROJECTS_DIR: join(ultron, "cockpit", "projects"),
      ULTRON_MEMORY_BIN: realBin ?? absentBin,
      ULTRON_HUBS_REFRESH: "off",
      MEMORY_GC_STATE: join(ultron, ".tmp", "memory-gc-last.json"),
      MEMORY_GC_LOG: join(logs, "memory-gc.jsonl"),
      ...extra,
    };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return e;
  };
  const countLines = (name) => {
    const p = join(logs, name);
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length;
  };
  const listLogs = () => (existsSync(logs) ? readdirSync(logs) : []);
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, ultron, logs, copied, absentBin, env, countLines, listLogs, cleanup };
}
