// kirkardo/cats-r2-b.mjs — checks de la ronda 2 (2026-10-23) para las
// categorias 7 (calidad), 10 (union), 12 (CI), 14 (backend/UI) y 18
// (reproducibilidad). Ejecutan tests, scripts y comandos reales.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as R2 from "./predicates-r2.mjs";
import { cargoTestCheck } from "./cargo.mjs";
import { CC, CC_SRC, CC_TAURI, REPO, ULTRON, ULTRON_MEM, extendCat, fwd, grepInFiles, run, spawnTracked } from "./core.mjs";

function nodeScript(rel, args = [], timeout = 300000) {
  // spawnTracked (P1, 2026-10-28): un proceso que no arranca se anota como
  // infraestructura y el runner lo pasa a manual con la causa.
  const r = spawnTracked(process.execPath, [join(REPO, ...rel.split("/")), ...args], {
    cwd: REPO, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  }, rel);
  return { code: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
}

// ---------------------------------------------------------------------------
// CAT 7 — Calidad
// ---------------------------------------------------------------------------
extendCat(7, [
  {
    id: "7.10",
    desc: "sidecar desplegado con sello de arbol limpio: `ultron-memory version` trae dirty=false (un binario sin el campo es anterior al sello)",
    auto: true,
    check() {
      // K1 (7f8ff248): version informaba el SHA de HEAD aunque el arbol
      // estuviera sucio. Mide el binario de bin/, el que ejecutan los hooks.
      if (!existsSync(ULTRON_MEM)) return { pass: false, detail: "no medible: bin/ultron-memory.exe ausente" };
      const r = run(`"${fwd(ULTRON_MEM)}" version`, { timeout: 15000 });
      return R2.versionDirtyVerdict(r.stdout);
    },
  },
  {
    id: "7.11",
    desc: "0 comandos Tauri sincronos (pub fn sin async) con E/S bloqueante directa (Command::new, reqwest, ureq, TcpStream, read_dir) y 0 `let _ = fs::write` en ollama/editor.rs",
    auto: true,
    check() {
      // calidad-rust (2a35d54f, 68d2ea59): un comando sincrono con E/S congela
      // el hilo principal de la UI; un fs::write con el error tragado no avisa.
      const files = grepInFiles(/#\[tauri::command/, CC_TAURI, [".rs"]).map((m) => m.file);
      const uniq = [...new Set(files)];
      if (uniq.length === 0) return { pass: false, detail: "no medible: 0 ficheros con #[tauri::command]" };
      const offenders = uniq.flatMap((f) => R2.syncIoCommands(readFileSync(f, "utf8")).map((n) => `${f.split(/[/\\]/).pop()}:${n}`));
      const editor = join(CC_TAURI, "ollama", "editor.rs");
      const swallowed = existsSync(editor) ? R2.swallowedWrites(readFileSync(editor, "utf8")) : 0;
      return {
        pass: offenders.length === 0 && swallowed === 0,
        detail: `${uniq.length} ficheros con comandos; sincronos con E/S=${offenders.length}${offenders.length ? ` [${offenders.slice(0, 5).join(", ")}]` : ""}; let _ = fs::write en ollama/editor.rs=${swallowed}`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 10 — Union del sistema
// ---------------------------------------------------------------------------
extendCat(10, [
  {
    id: "10.6",
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: "live_session.rs no lee routing-dispatcher.jsonl (log del dispatcher desconectado): 0 referencias de codigo",
    auto: true,
    check() {
      // 080611f8 / sesiones: la pestana leia un log que ya nadie escribe.
      const f = join(CC_TAURI, "commands", "sessions_sub", "live_session.rs");
      if (!existsSync(f)) return { pass: false, detail: "no medible: live_session.rs ausente" };
      const refs = R2.codeRefLines(readFileSync(f, "utf8"), /routing-dispatcher\.jsonl/).length;
      return { pass: refs === 0, detail: `${refs} lectura(s) de routing-dispatcher.jsonl fuera de comentarios` };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 12 — Facilidad de implementacion (CI local)
// ---------------------------------------------------------------------------
extendCat(12, [
  {
    id: "12.7",
    desc: "los selftests del CI pasan con HOME limpio: run-selftests.mjs --ci --fake-home --jobs 4 -> N/N en verde",
    auto: true,
    check() {
      // --jobs 4 (2026-11-02), igual que el CI: en serie la bateria tardaba 4-5 min
      // y con la maquina cargada agotaba el tope. El criterio (N/N) no cambia.
      const r = nodeScript("scripts/run-selftests.mjs", ["--ci", "--fake-home", "--jobs", "4"], 900000);
      return R2.suiteSummaryVerdict(r, { noun: "selftests", minTotal: 1 });
    },
  },
  {
    id: "12.8",
    desc: "tests de los mods y del MCP de escritorio: run-mod-tests.mjs -> >= 19 suites, todas en verde (claude plugin test + node --test)",
    auto: true,
    check() {
      // mascota-mods-3: ningun gate ejecutaba claude plugin test.
      const r = nodeScript("scripts/run-mod-tests.mjs", [], 1800000);
      if (/FALTA la CLI `claude`/.test(r.output)) return { manual: true, detail: "sin la CLI claude: los tests de los mods no se pueden ejecutar aqui" };
      return R2.suiteSummaryVerdict(r, { noun: "suites", minTotal: 19 });
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 14 — Backend/UI
// ---------------------------------------------------------------------------
const BRAKE_PROBES = [
  { command: 'curl -s -H "X-Ultron-Token: T" -d \'{"action":"type"}\' http://127.0.0.1:5000/v1/action', expectRisky: true },
  { command: 'c"ur"l http://127.0.0."1":5000/v1/act"ion"', expectRisky: true },
  { command: "curl http://127.1:5000/x", expectRisky: true },
  { command: "curl -s https://example.com", expectRisky: false },
  { command: "git status", expectRisky: false },
];

extendCat(14, [
  {
    id: "14.7",
    desc: "backend del visor CodeGraph e2e contra el indice vivo de ~/.ultron: el vecindario de route (ai_router) trae >= 1 arista y respeta el tope de nodos (cargo test --ignored)",
    auto: true,
    check() {
      if (!existsSync(join(ULTRON, ".codegraph", "codegraph.db"))) return { pass: false, detail: "no medible: ~/.ultron/.codegraph/codegraph.db ausente" };
      return cargoTestCheck("commands::projects::git_ops::codegraph::tests_index::codegraph_vecindario_de_route_en_un_indice_real", {
        ignored: true, env: { ULTRON_CODEGRAPH_PROJECT: ULTRON }, minPassed: 1,
      });
    },
  },
  {
    id: "14.8",
    desc: "guardarrail de persistencia de Pupus: cargo test mascot::guardrail con >= 8 tests en verde Y Guard::start cableado en mascot/chat.rs",
    auto: true,
    check() {
      // ad044e00: el guardarrail existia sin llamante en los turnos de Codex/AGY.
      const chat = join(CC_TAURI, "mascot", "chat.rs");
      if (!existsSync(chat)) return { pass: false, detail: "no medible: mascot/chat.rs ausente" };
      const wired = R2.codeRefLines(readFileSync(chat, "utf8"), /\bGuard::start\b/).length;
      const v = cargoTestCheck("mascot::guardrail::tests::", { minPassed: 8 });
      if (v.manual) return v;
      return { pass: v.pass && wired >= 1, detail: `${v.detail}; Guard::start en chat.rs=${wired}` };
    },
  },
  {
    id: "14.9",
    desc: "freno del chat de Pupus: classifyToolUse marca de riesgo el acceso al puente local (curl con token, c\"ur\"l ofuscado, 127.1) y deja pasar los controles (curl a internet, git status)",
    auto: true,
    async check() {
      // d3e4d855: el freno no cubria el puente local ni la red por shell.
      const server = join(REPO, "tools", "ultron-desktop-mcp", "server.mjs");
      if (!existsSync(server)) return { pass: false, detail: "no medible: tools/ultron-desktop-mcp/server.mjs ausente" };
      const { classifyToolUse } = await import(pathToFileURL(server).href);
      return R2.brakeVerdict(BRAKE_PROBES.map((p) => ({ ...p, risky: classifyToolUse("Bash", { command: p.command }).risky })));
    },
  },
  {
    id: "14.10",
    desc: "mantenimiento: cada script que lista la pestana existe y acepta sus flags (cargo test every_listed_script_exists_and_accepts_its_flags)",
    auto: true,
    check() {
      // 9c78b9b6: audit-skills no existia y doctor-fix llevaba un flag invalido.
      return cargoTestCheck("maintenance::commands::tests::every_listed_script_exists_and_accepts_its_flags", { minPassed: 1 });
    },
  },
  {
    id: "14.11",
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: "orquestador y paleta de la UI: vitest de src/components/orchestrator y src/components/palette en verde (modo ligero real, confirmaciones y fallos visibles)",
    auto: true,
    check() {
      // afc8e8a6 y f284a9d5.
      if (!existsSync(join(CC, "node_modules"))) return { manual: true, detail: "sin control-center/node_modules: vitest no se puede ejecutar aqui" };
      const r = run("npx vitest run src/components/orchestrator src/components/palette --silent 2>&1", { cwd: CC, timeout: 300000 });
      return R2.vitestVerdict({ code: r.code, output: r.stdout + r.stderr }, { minTests: 2 });
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 18 — Reproducibilidad (backup)
// ---------------------------------------------------------------------------
extendCat(18, [
  {
    id: "18.5",
    desc: "backup semanal: weekly-backup.selftest.mjs en verde (aborta sin destino, con la unidad desmontada o en el mismo volumen; >= 11 casos)",
    auto: true,
    check() {
      // N1 (20714808): sin destino caia a D:\BACKUP o a ~/BACKUP con exit 0.
      const r = nodeScript("scripts/backup/weekly-backup.selftest.mjs", [], 600000);
      return R2.nodeTestVerdict(r, { minPass: 11 });
    },
  },
  {
    id: "18.6",
    desc: "0 rastro de la tarea vieja UltronBackup-Weekly: ni en el codigo (fuera de comentarios) ni registrada en el Programador de tareas",
    auto: true,
    check() {
      // 6e37b05f: el codigo consultaba una tarea que no era la del backup real.
      const roots = [CC_TAURI, CC_SRC, join(REPO, "scripts"), join(REPO, "hooks")];
      const refs = roots.flatMap((d) => grepInFiles(/UltronBackup-Weekly/, d, [".rs", ".ts", ".tsx", ".js", ".mjs", ".ps1", ".sh"]))
        // Fuera comentarios, tests y el propio medidor (que nombra la tarea para buscarla).
        .filter((m) => !/^\s*(\/\/|\/\*|\*|#)/.test(m.text) && !/\.selftest\.mjs$|[/\\]tests?[/\\]|[/\\]kirkardo[/\\]/.test(m.file));
      let registered = null;
      if (process.platform === "win32") {
        const q = spawnSync("schtasks", ["/Query", "/TN", "UltronBackup-Weekly"], { encoding: "utf8", timeout: 20000, windowsHide: true });
        registered = q.error ? null : q.status === 0;
      }
      return R2.staleBackupTaskVerdict({ codeRefs: refs.length, taskRegistered: registered });
    },
  },
]);
