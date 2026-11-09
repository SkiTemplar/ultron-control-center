// kirkardo/provenance.mjs — control del medidor (auditoria 2026-11-01): quien
// escribe el producto escribe tambien el medidor, asi que la nota no se certifica
// sola. Tres piezas sin agentes:
//   - provenance: a que codigo y a que medidor corresponde una nota.
//   - retired_effect: cuanto puede estar comprando cada retirada.
//   - score_watch: aviso si la nota sube con el producto intacto.
//
// Alcance real: hace visible la subida, no la impide; logs/ esta ignorado por git,
// asi que quien borre el historial pierde la comparacion (sale "sin_referencia").
// El congelado de ids, retiradas y suelos esta en registry-lock.mjs.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const METER_PREFIXES = ["scripts/kirkardo/", "scripts/kirkardo-eval"];
const MAX_HASHED_BYTES = 8 * 1024 * 1024;
const HISTORY_FILE = "kirkardo-history.jsonl";

/** Un fichero del medidor no es producto: tocarlo no explica que suba la nota. */
export function isMeterPath(path) {
  return METER_PREFIXES.some((p) => path.startsWith(p));
}

// ---------------------------------------------------------------------------
// Predicados puros
// ---------------------------------------------------------------------------

/**
 * Efecto de las retiradas en la nota. Los retirados no se ejecutan, asi que su
 * resultado real se desconoce: lo unico honesto es la cota de cada uno si
 * contara en rojo. checks = [{ id, area, status }]; areas = [{ id, weight }].
 */
export function retiredEffect(checks, areas) {
  const measured = (id) => checks.filter((c) => c.area === id && (c.status === "pass" || c.status === "fail"));
  const passed = (id) => measured(id).filter((c) => c.status === "pass").length;
  const retired = checks.filter((c) => c.status === "retired");
  const wSum = areas.reduce((s, a) => s + a.weight, 0);
  const weightOf = (id) => areas.find((a) => a.id === id)?.weight ?? 0;
  const areaNote = (id, extraFails) => {
    const total = measured(id).length + extraFails;
    return total ? (passed(id) / total) * 10 : 0;
  };
  const dropIfFails = (id, n) => (wSum ? ((areaNote(id, 0) - areaNote(id, n)) * weightOf(id)) / wSum : 0);
  const byArea = areas
    .map((a) => ({ area: a.id, weight: a.weight, retired: retired.filter((c) => c.area === a.id).length }))
    .filter((r) => r.retired > 0)
    .map((r) => ({ ...r, overall_drop_if_all_fail: Number(dropIfFails(r.area, r.retired).toFixed(2)) }));
  return {
    retired: retired.length,
    registered: checks.length,
    meaning: "cota: cuanto bajaria overall si los retirados contaran en rojo; no se ejecutan, su resultado real se desconoce",
    overall_drop_if_all_fail: Number(byArea.reduce((s, r) => s + r.overall_drop_if_all_fail, 0).toFixed(2)),
    by_area: byArea,
    checks: retired.map((c) => ({ id: c.id, area: c.area, overall_drop_if_fail: Number(dropIfFails(c.area, 1).toFixed(3)) })),
  };
}

/**
 * Aviso si la nota sube sin cambios en el producto. prev y cur = fila del
 * historial { overall, product_fingerprint, harness_hash, git_sha }.
 */
export function scoreWatch(prev, cur) {
  if (!prev) return { status: "sin_referencia", detail: "sin corrida anterior en logs/kirkardo-history.jsonl: nada que comparar" };
  if (!prev.product_fingerprint || !cur.product_fingerprint) return { status: "no_comparable", detail: "falta la huella del producto en una de las dos corridas" };
  const delta = Number((cur.overall - prev.overall).toFixed(2));
  const sameProduct = prev.product_fingerprint === cur.product_fingerprint;
  const harnessChanged = prev.harness_hash !== cur.harness_hash;
  const base = { delta, previous_overall: prev.overall, previous_at: prev.generated_at ?? null, same_product: sameProduct, harness_changed: harnessChanged };
  if (delta <= 0 || !sameProduct) return { status: "ok", ...base, detail: sameProduct ? "la nota no sube" : "el producto cambio entre las dos corridas" };
  return {
    status: "nota_sube_sin_cambios_en_producto",
    ...base,
    detail: harnessChanged
      ? `overall +${delta} con el producto intacto y el medidor cambiado: la subida la explica el medidor, revisa su diff`
      : `overall +${delta} con producto y medidor intactos: la subida viene del estado vivo (nondeterministic_inputs)`,
  };
}

// ---------------------------------------------------------------------------
// Recogida (git y disco)
// ---------------------------------------------------------------------------

function git(repo, args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]}: ${r.error?.code ?? `exit ${r.status}`}`);
  return r.stdout;
}

function fileDigest(path) {
  const st = statSync(path);
  if (st.size > MAX_HASHED_BYTES) return `size:${st.size}:${st.mtimeMs}`;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Huella del arbol sin los ficheros del medidor: commits y cambios sin commitear
 * que solo tocan el medidor no la mueven. Esto cubre lo que `git_sha` no ve, que
 * un arbol sucio cambie con el mismo HEAD.
 */
function productFingerprint(repo) {
  const tracked = git(repo, ["ls-tree", "-r", "HEAD"]).split("\n").filter((l) => l && !isMeterPath(l.split("\t")[1] ?? ""));
  const diff = git(repo, ["-c", "core.quotepath=off", "diff", "HEAD", "--", ".", ...METER_PREFIXES.map((p) => `:(exclude,glob)${p}**`)]);
  const untracked = git(repo, ["ls-files", "-o", "--exclude-standard"]).split("\n").filter((l) => l && !isMeterPath(l)).sort();
  const hash = createHash("sha256").update(tracked.join("\n")).update(diff);
  for (const rel of untracked) hash.update(`${rel}\0${fileDigest(join(repo, rel))}\n`);
  return hash.digest("hex").slice(0, 16);
}

/** Hash del codigo del medidor: scripts/kirkardo/ y kirkardo-eval*. */
function harnessHash(repo) {
  const hash = createHash("sha256");
  const scripts = join(repo, "scripts");
  const dir = join(scripts, "kirkardo");
  const files = [
    ...readdirSync(scripts).filter((n) => n.startsWith("kirkardo-eval")).map((n) => join(scripts, n)),
    ...readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).map((n) => join(dir, n)),
  ].sort();
  for (const f of files) hash.update(readFileSync(f));
  return hash.digest("hex").slice(0, 16);
}

/** A que codigo corresponde esta corrida. Un fallo de git se declara, no se calla. */
export function collectProvenance(repo) {
  try {
    const sha = git(repo, ["rev-parse", "--short", "HEAD"]).trim();
    const dirty = git(repo, ["--no-optional-locks", "status", "--porcelain"]).trim().length > 0;
    return { git_sha: sha, dirty, product_fingerprint: productFingerprint(repo), harness_hash: harnessHash(repo) };
  } catch (e) {
    return { git_sha: null, dirty: null, product_fingerprint: null, harness_hash: null, error: e.message };
  }
}

/** Ultima fila valida del historial, o null si no hay. Una linea corrupta se salta. */
export function lastHistoryRow(logsDir) {
  const path = join(logsDir, HISTORY_FILE);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch (e) {
      process.stderr.write(`[kirkardo] linea corrupta en ${HISTORY_FILE}: ${e.message}\n`);
    }
  }
  return null;
}

export function appendHistoryRow(logsDir, row) {
  appendFileSync(join(logsDir, HISTORY_FILE), `${JSON.stringify(row)}\n`, "utf8");
}
