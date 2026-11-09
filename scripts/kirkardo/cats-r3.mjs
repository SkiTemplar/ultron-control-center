// kirkardo/cats-r3.mjs — checks de la ronda 3 (2026-10-28,
// docs/audits/audit-2026-10-28-kirkardo-criterio.md) que se anaden a
// categorias existentes:
//   5.6       lapidas fusionadas (P5): sustituye a 10.6, 11.3, 11.4 y 16.1-16.4
//   6.6       rutas citadas en los documentos de entrada (2026-11-01)
//   9.6-9.9   hooks de seguridad con sondas positiva y de control (K1)
//   9.10      mod ultron-permisos con id propio (K2)
//   9.11      paridad manifest/plantilla/settings ejecutada (sustituye a 9.1 y 12.3)
//   10.7      ficheros referenciados por el codigo y sin trackear (G1)
//   10.8      vitest completo de la app (F1; sustituye a 12.1 y 14.11)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import * as R2 from "./predicates-r2.mjs";
import * as R3 from "./predicates-r3.mjs";
import { CC, CC_TAURI, CLAUDE, COCKPIT, HOOKS_SCRIPTS, REPO, SETTINGS_JSON, extendCat, grepInFiles, hookSandbox, readJSON, run, spawnHook, spawnTracked } from "./core.mjs";

// Codigo de terceros vendorizado (parche de tao): no es codigo propio.
const VENDOR_EXCLUDE = ["control-center/src-tauri/vendor/"];

// ---------------------------------------------------------------------------
// 6.6 rutas citadas en los documentos de entrada (mandamiento 6, 2026-11-01)
// ---------------------------------------------------------------------------
const DOCS_WITH_PATHS = ["README.md", "SYSTEM-MAP.md", "CLAUDE.md", "docs/GOAL.md", "docs/INTEGRATION.md", "docs/MODS.md", "docs/PUPUS.md"];
// Los documentos citan rutas relativas al modulo del que hablan.
const CITATION_ROOTS = ["", "control-center", "control-center/src-tauri", "control-center/src-tauri/src", "control-center/src", "control-center/src/components", "hooks", "hooks/scripts", "cockpit", "docs", "scripts", "mods"];
// docs/MODS.md cita rutas relativas a cada mod.
const modRoots = () => (existsSync(join(REPO, "mods")) ? readdirSync(join(REPO, "mods")).map((m) => `mods/${m}`) : []);

extendCat(6, [
  {
    id: "6.6",
    desc: "las rutas de codigo citadas en README, SYSTEM-MAP, CLAUDE.md, GOAL, INTEGRATION, MODS y PUPUS existen en disco (lineas que narran una retirada aparte)",
    auto: true,
    check() {
      const docs = DOCS_WITH_PATHS.filter((d) => existsSync(join(REPO, d)))
        .map((d) => ({ name: d, paths: R3.citedPaths(readFileSync(join(REPO, d), "utf8")) }));
      const roots = [...CITATION_ROOTS, ...modRoots()];
      return R3.citedPathsVerdict(docs, (p) => roots.some((root) => existsSync(join(REPO, root, p))));
    },
  },
]);

// ---------------------------------------------------------------------------
// 5.6 lapidas
// ---------------------------------------------------------------------------
function tombstoneSources() {
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const hookCode = grepInFiles(/mem0/, HOOKS_SCRIPTS, [".js"])
    .filter((m) => !/^\s*(\/\/|\*)/.test(m.text) && !/forbidden|prohibited|blocked|opt-out|opt_out/i.test(m.text))
    .map((m) => m.text).join("\n");
  const spawnScripts = [join(REPO, "scripts"), COCKPIT].filter(existsSync)
    .flatMap((d) => grepInFiles(/headroom wrap/, d, [".ps1", ".sh", ".js", ".mjs"]))
    .filter((m) => !/[/\\]kirkardo[/\\]|kirkardo-eval/.test(m.file)).map((m) => m.text).join("\n");
  const settings = readJSON(SETTINGS_JSON);
  const live = join(CC_TAURI, "commands", "sessions_sub", "live_session.rs");
  return [
    { label: "settings.hooks", text: JSON.stringify(settings?.hooks ?? {}) },
    { label: "settings.enabledPlugins", text: JSON.stringify(settings?.enabledPlugins ?? {}) },
    { label: "CLAUDE.md global", text: read(join(CLAUDE, "CLAUDE.md")) },
    { label: "hooks/scripts (codigo)", text: hookCode },
    { label: "scripts y cockpit (spawns)", text: spawnScripts },
    { label: "live_session.rs (codigo)", text: existsSync(live) ? R2.codeRefLines(read(live), /routing-dispatcher/).join("\n") : "" },
  ];
}

const TOMBSTONES = [
  // in: etiquetas de fuente donde la lapida cuenta (sin in, todas). mem0 se
  // nombra en CLAUDE.md para prohibirlo: solo cuenta en hooks y settings.
  { id: "mem0", re: /mem0/i, in: ["settings.hooks", "hooks/scripts (codigo)"] }, // 16.3, 16.4 y la parte mem0 de 17.1
  { id: "headroom-wrap", re: /headroom wrap/ }, // 11.3
  { id: "ecc-activo", re: /"ecc@ecc":\s*true/ }, // 11.4
  { id: "rtk-obligatorio", re: /RTK.*obligatorio|obligatorio.*RTK/i }, // 16.1
  { id: "routing-dispatcher.jsonl", re: /routing-dispatcher\.jsonl/ }, // 10.6
];

// ---------------------------------------------------------------------------
// 9.6-9.9 sondas de hooks de seguridad
// ---------------------------------------------------------------------------
function probe(script, label, expect, input) {
  const r = spawnHook(join(HOOKS_SCRIPTS, script), input, { timeout: 30000 });
  return { label, expect, code: r.status, got: R3.hookDecision(r.stdout) };
}

function hookProbeCheck(script, build) {
  if (!existsSync(join(HOOKS_SCRIPTS, script))) return { pass: false, detail: `no medible: falta hooks/scripts/${script}` };
  return R3.hookProbesVerdict(build());
}

const pre = (tool_name, tool_input, cwd = REPO) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd, session_id: "kirkardo-probe" });

// ---------------------------------------------------------------------------
// 10.7 referencias sin trackear
// ---------------------------------------------------------------------------
function gitLines(args) {
  const r = spawnTracked("git", args, { cwd: REPO, encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, `git ${args[0]}`);
  return r.status === 0 ? String(r.stdout).split(/\r?\n/).filter(Boolean) : null;
}

function rustRefs(rel) {
  const text = readFileSync(join(REPO, rel), "utf8");
  const dir = posix.dirname(rel);
  const base = posix.basename(rel, ".rs");
  const modRoot = ["mod", "lib", "main"].includes(base) ? dir : posix.join(dir, base);
  return R3.rustRefTargets(text).flatMap((t) => {
    if (t.kind === "mod") return [posix.join(modRoot, `${t.target}.rs`), posix.join(modRoot, t.target, "mod.rs")].map((to) => ({ from: rel, to, alt: true }));
    return [{ from: rel, to: posix.normalize(posix.join(dir, t.target)) }];
  });
}

function tsRefs(rel) {
  const text = readFileSync(join(REPO, rel), "utf8");
  const dir = posix.dirname(rel);
  return R3.tsImportTargets(text).flatMap((t) => {
    const p = posix.normalize(posix.join(dir, t));
    const cands = /\.(ts|tsx|js|mjs|json|css|svg|png)$/.test(p) ? [p] : [`${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`];
    const hit = cands.find((c) => existsSync(join(REPO, c)));
    return hit ? [{ from: rel, to: hit }] : [];
  });
}

extendCat(5, [
  {
    id: "5.6",
    desc: "0 lapidas reintroducidas (mem0, headroom wrap, ecc activo, RTK obligatorio, routing-dispatcher.jsonl): un solo check sustituye a 10.6, 11.3, 11.4 y 16.1-16.4",
    auto: true,
    check() {
      return R3.tombstonesVerdict(tombstoneSources(), TOMBSTONES);
    },
  },
]);

extendCat(9, [
  {
    id: "9.6",
    desc: "deny-secrets en vivo: deniega Read de una clave en .ssh/, frena (deny o ask) Read de un .env y deja pasar Read de README.md",
    auto: true,
    check() {
      const sb = hookSandbox();
      return hookProbeCheck("deny-secrets.js", () => [
        probe("deny-secrets.js", "Read clave ssh", "deny", pre("Read", { file_path: join(sb.root, ".ssh", "id_ed25519") })),
        probe("deny-secrets.js", "Read .env", "block", pre("Read", { file_path: join(sb.ultron, ".env") })),
        probe("deny-secrets.js", "Read README.md", "pass", pre("Read", { file_path: join(REPO, "README.md") })),
      ]);
    },
  },
  {
    id: "9.7",
    desc: "guardrails-pre en vivo: deniega un Bash con la bandera de saltarse permisos y deja pasar git status",
    auto: true,
    check() {
      return hookProbeCheck("guardrails-pre.js", () => [
        probe("guardrails-pre.js", "bypass", "deny", pre("Bash", { command: ["claude", "--dangerously-skip-" + "permissions", "-p", "x"].join(" ") })),
        probe("guardrails-pre.js", "git status", "pass", pre("Bash", { command: "git status" })),
      ]);
    },
  },
  {
    id: "9.8",
    desc: "uni-deliverable-guard en vivo: con .ultron-trabajo.json deniega un Write en borrador/ y deja pasar el mismo Write fuera",
    auto: true,
    check() {
      const sb = hookSandbox();
      const work = join(sb.root, "asignatura", "trabajo");
      mkdirSync(join(work, "borrador"), { recursive: true });
      writeFileSync(join(work, ".ultron-trabajo.json"), JSON.stringify({ protegidas: ["borrador", "entrega"] }));
      return hookProbeCheck("uni-deliverable-guard.js", () => [
        probe("uni-deliverable-guard.js", "Write borrador/", "deny", pre("Write", { file_path: join(work, "borrador", "memoria.md"), content: "x" }, work)),
        probe("uni-deliverable-guard.js", "Write notas/", "pass", pre("Write", { file_path: join(work, "notas", "ideas.md"), content: "x" }, work)),
      ]);
    },
  },
  {
    id: "9.9",
    desc: "model-family-guard en vivo: deniega un cambio a un modelo fuera de la familia 5.5 y deja pasar claude-opus-5-5",
    auto: true,
    check() {
      const sw = (to_model) => ({ hook_event_name: "PreModelSwitch", to_model, from_model: "claude-opus-5-5", session_id: "kirkardo-probe" });
      return hookProbeCheck("model-family-guard.js", () => [
        probe("model-family-guard.js", "claude-opus-4-1", "deny", sw("claude-opus-4-1")),
        probe("model-family-guard.js", "claude-opus-5-5", "pass", sw("claude-opus-5-5")),
      ]);
    },
  },
  {
    id: "9.10",
    desc: "mod ultron-permisos con id propio: sus tests en verde (una edicion de settings.json, hooks/ o agents/ pide permiso)",
    auto: true,
    check() {
      const r = spawnTracked(process.execPath, [join(REPO, "scripts", "run-mod-tests.mjs"), "--filter", "ultron-permisos"], {
        cwd: REPO, encoding: "utf8", timeout: 600000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      }, "run-mod-tests ultron-permisos");
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (/FALTA la CLI `claude`/.test(out)) return { manual: true, detail: "sin la CLI claude: los tests del mod no se pueden ejecutar aqui" };
      return R2.suiteSummaryVerdict({ code: r.status, output: out }, { noun: "suites", minTotal: 1 });
    },
  },
  {
    id: "9.11",
    desc: "paridad real de hooks: node hooks/regen-manifest.js --check (manifest, plantilla y settings.json) sale con 0",
    auto: true,
    check() {
      const script = join(REPO, "hooks", "regen-manifest.js");
      if (!existsSync(script)) return { pass: false, detail: "no medible: falta hooks/regen-manifest.js" };
      const r = spawnTracked(process.execPath, [script, "--check"], { cwd: REPO, encoding: "utf8", timeout: 60000, windowsHide: true }, "regen-manifest --check");
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
      return { pass: r.status === 0, detail: `exit=${r.status}: ${out.split(/\r?\n/).slice(-1)[0]?.slice(0, 140) ?? ""}` };
    },
  },
]);

extendCat(10, [
  {
    id: "10.7",
    desc: "0 ficheros referenciados por el codigo (include_str!/include_bytes!, #[path], mod x;, imports relativos) sin trackear en git (mandamiento 4; excluye vendor/)",
    auto: true,
    check() {
      const untrackedList = gitLines(["ls-files", "--others", "--exclude-standard"]);
      const tracked = gitLines(["ls-files", "control-center/src-tauri/src", "control-center/src"]);
      if (!untrackedList || !tracked) return { pass: false, detail: "no medible: git ls-files fallo" };
      const untracked = new Set(untrackedList);
      const refs = [];
      for (const rel of tracked) {
        if (!existsSync(join(REPO, rel))) continue;
        if (rel.endsWith(".rs")) refs.push(...rustRefs(rel));
        else if (/\.(ts|tsx)$/.test(rel)) refs.push(...tsRefs(rel));
      }
      // `mod x;` tiene dos destinos posibles: cuenta el que existe.
      const real = refs.filter((r) => !r.alt || existsSync(join(REPO, r.to)));
      return R3.untrackedRefsVerdict(real, untracked, { exclude: VENDOR_EXCLUDE });
    },
  },
  {
    id: "10.8",
    desc: "vitest completo de la app en verde, sin errores no capturados y con >= 1650 tests (sustituye a 12.1, que solo leia ci.yml, y absorbe 14.11)",
    auto: true,
    check() {
      if (!existsSync(join(CC, "node_modules"))) return { manual: true, detail: "sin control-center/node_modules: vitest no se puede ejecutar aqui" };
      const r = run("npx vitest run --silent 2>&1", { cwd: CC, timeout: 900000 });
      return R2.vitestVerdict({ code: r.code, output: r.stdout + r.stderr }, { minTests: 1650 });
    },
  },
]);

