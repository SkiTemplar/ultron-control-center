// kirkardo/cats-05-07.mjs — categorias 5 (limpieza), 6 (documentacion) y 7 (calidad y frescura).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import * as P from "./predicates.mjs";
import { BIN, CC, CC_SRC, CC_TAURI, CLAUDE, HOME, HOOKS_MANIFEST, HOOKS_SCRIPTS, REPO, SKILL_LAZY, ULTRON, cat, countLines, fileExists, fwd, grepInFiles, readJSON, run, runDoctor, spawnHook } from "./core.mjs";

// ---------------------------------------------------------------------------
// CAT 5 — Limpieza de .ultron
// ---------------------------------------------------------------------------
cat(5, "Limpieza de .ultron", [
  {
    id: "5.1",
    desc: "FASTEMBED: 1 sola copia del modelo E5-large (model.onnx)",
    auto: true,
    // Con el denso apagado E5 no se carga: 0 copias es el estado esperado.
    retiredBy: "dense-off",
    check() {
      // El modelo E5 es model.onnx (NO safetensors). Busca SOLO en los caches fastembed
      // conocidos (acotado/rapido): un find sobre todo HOME timeouteaba y devolvia 0 = falso
      // pass que cazo el audit independiente 2026-06-21.
      const caches = [
        join(HOME, ".ultron", ".fastembed_cache"),
        join(HOME, "AppData", "Local", "Temp", "fastembed_cache"),
        join(HOME, "AppData", "Local", "fastembed-rs"),
      ];
      let count = 0;
      for (const d of caches) {
        if (!existsSync(d)) continue;
        const r = run(`find "${fwd(d)}" -ipath "*e5-large*" -name "model.onnx" 2>/dev/null | wc -l`, { timeout: 15000 });
        count += parseInt(r.stdout.trim(), 10) || 0;
      }
      return { pass: count === 1, detail: `${count} copia(s) de E5-large model.onnx en caches fastembed` };
    },
  },
  {
    id: "5.2",
    desc: "Disco libre >= 50GB (doctor informa free_gb)",
    auto: true,
    check() {
      // En vez de medir el tamaño (lento en Windows), usa el reporte del doctor
      const txt = runDoctor().raw;
      try {
        const j = JSON.parse(txt.trim());
        const diskCheck = (j.checks ?? []).find((c) => c.name === "disk");
        if (diskCheck) {
          const freeGb = diskCheck.data?.free_gb ?? null;
          if (freeGb !== null) {
            return { pass: freeGb >= 50, detail: `libre=${freeGb.toFixed(1)}GB` };
          }
        }
      } catch {}
      return { pass: false, detail: "no se pudo obtener info de disco del doctor" };
    },
  },
  {
    id: "5.3",
    desc: "0 dirs _cleanup_quarantine_* (o todos < 30 dias)",
    auto: true,
    check() {
      const r = run(`find "${fwd(ULTRON)}" -maxdepth 2 -type d -name "_cleanup_quarantine_*" 2>/dev/null`, { cwd: ULTRON });
      const dirs = r.stdout.trim().split("\n").filter(Boolean);
      if (dirs.length === 0) return { pass: true, detail: "0 quarantine dirs" };
      // En Windows, stat -c %Y puede no funcionar; usamos Node.js statSync
      const now = Date.now();
      const oldDirs = [];
      for (const d of dirs) {
        try {
          const { mtimeMs } = statSync(d);
          if (now - mtimeMs > 30 * 24 * 3600 * 1000) oldDirs.push(d);
        } catch {
          oldDirs.push(d); // si no podemos leer, conservador: cuenta como viejo
        }
      }
      return { pass: oldDirs.length === 0, detail: `${dirs.length} dirs total, ${oldDirs.length} > 30d` };
    },
  },
  {
    id: "5.4",
    retiredBy: "dispatcher-off", // 2026-10-28: cuenta .bak de un script desconectado
    desc: "0 archivos .bak de routing-dispatcher en ~/.claude/scripts ni en cockpit/skill-lazy (donde vive hoy)",
    auto: true,
    check() {
      // El dispatcher vive en cockpit/skill-lazy desde 2026-06; ~/.claude/scripts
      // solo guarda _retired-2026-06-10 (auditoria 2026-10-23, medidor-13).
      const dirs = [join(CLAUDE, "scripts"), SKILL_LAZY].filter((d) => existsSync(d));
      if (dirs.length === 0) return { pass: false, detail: "no medible: ni ~/.claude/scripts ni cockpit/skill-lazy existen" };
      const baks = dirs.flatMap((d) => grepInFiles(/^/, d, [".bak"]).map((m) => m.file))
        .filter((f) => /routing-dispatcher[^/\\]*\.bak$/.test(f));
      const uniq = [...new Set(baks)];
      return { pass: uniq.length === 0, detail: `${uniq.length} .bak de routing-dispatcher en ${dirs.length} dir(s)` };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 6 — Documentacion
// ---------------------------------------------------------------------------
cat(6, "Documentacion", [
  {
    id: "6.1",
    desc: "0 rutas personales en archivos trackeados (todos los ficheros de texto de git ls-files)",
    auto: true,
    check() {
      // git ls-files SIN pathspec y sin shell (auditoria 2026-10-23, medidor-8):
      // `git ls-files -- *.md ...` por bash -c expandia *.md a los .md de la raiz
      // y el filtro dejaba fuera .js/.mjs/.ps1/.json/.py. Binarios fuera (NUL).
      const ls = spawnSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
      if (ls.status !== 0) return { pass: false, detail: `no medible: git ls-files exit=${ls.status}` };
      // Fiel al CI gate (audit_personal_data.py): AUTHORS.md/README.md exentos (atribucion de
      // autoria, NO fuga). Patrones = RUTAS personales reales, no el nombre del autor suelto.
      const ALLOWED = ["AUTHORS.md", "README.md"];
      // Username desde el entorno (no hardcodeado) -> el propio harness queda libre de PII.
      const userName = (process.env.USERNAME || process.env.USER || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [/D:[/\\]Ultron/];
      if (userName) patterns.push(new RegExp("C:[/\\\\]Users[/\\\\]" + userName));
      const files = [];
      for (const rel of ls.stdout.split("\0").filter(Boolean)) {
        let buf;
        try { buf = readFileSync(join(REPO, rel)); } catch { continue; }
        if (P.looksBinary(buf)) continue;
        files.push({ path: rel, content: buf.toString("utf8") });
      }
      if (files.length === 0) return { pass: false, detail: "no medible: 0 ficheros de texto trackeados" };
      const hits = P.personalPathHits(files, patterns, ALLOWED);
      return {
        pass: hits.length === 0,
        detail: `${hits.length}/${files.length} ficheros trackeados con rutas personales` + (hits.length ? `: ${hits.slice(0, 5).join(", ")}` : ""),
      };
    },
  },
  {
    id: "6.2",
    desc: "audit_personal_data.py HIGH = 0",
    auto: true,
    check() {
      const script = join(REPO, "scripts", "cockpit", "audit_personal_data.py");
      if (!fileExists(script)) return { pass: false, detail: "audit_personal_data.py no encontrado" };
      // `uv run python` (regla del proyecto) y 300 s (K7, 2026-10-23): con
      // `python` suelto y 30 s el check moria antes de medir (HIGH=-1). El informe
      // va a un temporal, no al .tmp de produccion.
      const outDir = mkdtempSync(join(tmpdir(), "kirkardo-audit-"));
      try {
        const r = spawnSync("uv", ["run", "python", script, "--out", join(outDir, "audit.md")], {
          cwd: REPO, encoding: "utf8", timeout: 300000, windowsHide: true,
        });
        const txt = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        const high = P.auditHighCount(txt);
        if (high === null) return { pass: false, detail: `no medible: sin linea resumen HIGH= (exit=${r.status}${r.error ? `, ${r.error.code}` : ""}): ${P.tailLines(txt, 2).slice(0, 120)}` };
        return { pass: high === 0, detail: `HIGH=${high} (exit=${r.status}); ${P.tailLines(txt, 1).slice(0, 120)}` };
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
  },
  {
    id: "6.3",
    desc: "0 broken links a .md en los .md trackeados del repo (links relativos reales, con/sin ./, con anchors)",
    auto: true,
    check() {
      // Todos los .md trackeados, no solo docs/ (auditoria 2026-10-23, docs-ci-8:
      // inspeccionaba 7 enlaces). Parsea TODOS los links markdown relativos que
      // apuntan a un .md: bare `]( INSTALL.md )`, `]( ./X.md )`, `]( ../X.md#anchor )`.
      const ls = spawnSync("git", ["-C", REPO, "ls-files", "-z", "--", "*.md"], { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      if (ls.status !== 0) return { pass: false, detail: `no medible: git ls-files exit=${ls.status}` };
      // Los fixtures son textos de prueba, no documentacion: sus enlaces no se navegan.
      const uniq = ls.stdout.split("\0").filter((rel) => rel && !/(^|\/)fixtures\//.test(rel)).map((rel) => join(REPO, rel));
      if (uniq.length === 0) return { pass: false, detail: "no medible: 0 .md trackeados" };
      // Regex: captura el destino dentro de ]( ... ) que contenga ".md"
      const linkRe = /\]\(\s*([^)]+?\.md[^)\s]*)\s*\)/g;
      let links = 0, broken = 0;
      const brokenList = [];
      for (const f of uniq) {
        let content;
        try { content = readFileSync(f, "utf8"); } catch { continue; }
        let m;
        while ((m = linkRe.exec(content)) !== null) {
          let ref = m[1].trim();
          // Salta links externos / absolutos / solo-anchor
          if (/^(https?:|mailto:|#)/i.test(ref)) continue;
          ref = ref.replace(/^<|>$/g, "").split("#")[0].split("?")[0].trim();
          if (!ref || ref.startsWith("/")) continue; // ignora absolutos del repo
          links++;
          const target = join(dirname(f), ref);
          if (!existsSync(target)) {
            broken++;
            if (brokenList.length < 5) brokenList.push(`${f.split(/[/\\]/).pop()} -> ${ref}`);
          }
        }
      }
      // Si NO se parseo ningun link, es sospechoso (el check seria vacuo otra vez) -> reporta FAIL.
      if (links === 0) return { pass: false, detail: `0 links .md parseados en ${uniq.length} .md (sospechoso: check vacuo)` };
      return {
        pass: broken === 0,
        detail: broken === 0 ? `${links} links en ${uniq.length} .md, 0 rotos` : `${broken}/${links} rotos: ${brokenList.join(", ")}`,
      };
    },
  },
  {
    id: "6.4",
    desc: "CLAUDE.md describe build:local (no build:app para escritorio)",
    auto: true,
    check() {
      const claudeMd = join(REPO, "CLAUDE.md");
      if (!fileExists(claudeMd)) return { pass: false, detail: "CLAUDE.md no encontrado" };
      // Antes `regex || hasBuildLocal`: bastaba con que apareciera "build:local"
      // en cualquier sitio (auditoria 2026-10-23, medidor-13). Ahora exige las dos
      // mitades del desc en la misma linea cada una.
      return P.buildLocalDocVerdict(readFileSync(claudeMd, "utf8"));
    },
  },
  {
    id: "6.5",
    desc: "eval rechaza flags desconocidos (no finge medir con recall=1.0 ante un typo)",
    auto: true,
    check() {
      // Hoy `eval --flagquenoexiste` -> exit 0 + recall_at_k=1.0: ignora el flag y
      // corre el eval sintetico circular. Un typo (--gold por --golden) produce una
      // metrica falsamente optimista EN SILENCIO (mandamiento 11). known_red hasta
      // que el parser de args rechace lo desconocido.
      const r = run(`"${fwd(join(BIN, "ultron-memory.exe"))}" eval --flagquenoexiste 2>&1`, {
        timeout: 60000,
      });
      const txt = r.stdout + r.stderr;
      const rejected =
        r.code !== 0 || /unknown|unrecognized|invalid|no such|desconocid/i.test(txt);
      return {
        pass: rejected,
        detail: rejected
          ? "flag invalido rechazado (exit!=0 o error explicito)"
          : `flag invalido IGNORADO: exit=${r.code}, finge medir (recall=1.0 sintetico)`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 7 — Calidad de Codigo
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CAT 7 — Calidad de Codigo + Frescura del binario
// ---------------------------------------------------------------------------
// 7.1-7.5: calidad (clippy/tsc/lineas/tests). 7.3 (.rs >800L) PRESERVADO.
// 7.6-7.9: FRESCURA (mandamiento 3): el sidecar que ejecutan los hooks debe
// corresponder a HEAD, ser identico al binario recien compilado, y los hooks
// deben ARRANCAR de verdad (no solo pasar node --check). El gotcha mas caro del
// proyecto: bin/ultron-memory.exe stale -> "parece que no se aplico". Nada lo
// guardaba; ahora si.
cat(7, "Calidad de Codigo + Frescura del binario", [
  {
    id: "7.1",
    desc: "cargo clippy --all-targets (--features finance si el modulo existe) -- -D warnings: exit 0 y 0 diagnosticos de error",
    auto: true,
    check() {
      // Sin tuberia (auditoria 2026-10-23, medidor-2): `| tail -5` devolvia el exit
      // de tail y los lints elevados a error ("error: ...", sin codigo E) no
      // tumbaban el check. --all-targets es lo que se verifica a mano; Finance
      // entra si su modulo esta en el arbol (build:local).
      const fin = P.financeSourcePresent(existsSync, join, CC_TAURI) ? " --features finance" : "";
      const r = run(`cargo clippy --all-targets${fin} -- -D warnings 2>&1`, {
        cwd: join(CC, "src-tauri"),
        timeout: 900000,
      });
      const v = P.clippyVerdict({ code: r.code, output: r.stdout + r.stderr });
      return { ...v, detail: `[--all-targets${fin}] ${v.detail}` };
    },
  },
  {
    id: "7.2",
    desc: "tsc --noEmit: exit 0 y 0 errores TS",
    auto: true,
    check() {
      // Sin `| tail -10`: el exit es el de tsc y se miran todas las lineas.
      const r = run("npx tsc --noEmit 2>&1", { cwd: CC, timeout: 180000 });
      return P.tscVerdict({ code: r.code, output: r.stdout + r.stderr });
    },
  },
  {
    id: "7.3",
    desc: "0 archivos .rs > 800 lineas (excluyendo target/)",
    auto: true,
    check() {
      // PRESERVADO: anti-patron de fichero monolitico. find real + conteo de lineas.
      const r = run(
        `find "${CC_TAURI}" -name "*.rs" -not -path "*/target/*" -type f 2>/dev/null`,
        { cwd: ULTRON },
      );
      const files = r.stdout.trim().split("\n").filter(Boolean);
      if (files.length === 0) return { pass: false, detail: "no medible: find no devolvio ningun .rs" };
      const over = files.filter((f) => countLines(f) > 800);
      return {
        pass: over.length === 0,
        detail:
          over.length === 0
            ? `0 .rs >800L (de ${files.length})`
            : over.map((f) => `${f.split("/").slice(-1)[0]}:${countLines(f)}L`).join(", "),
      };
    },
  },
  {
    id: "7.4",
    desc: "0 archivos .tsx > 800 lineas",
    auto: true,
    check() {
      const r = run(`find "${CC_SRC}" -name "*.tsx" -type f 2>/dev/null`, { cwd: ULTRON });
      const files = r.stdout.trim().split("\n").filter(Boolean);
      if (files.length === 0) return { pass: false, detail: "no medible: find no devolvio ningun .tsx" };
      const over = files.filter((f) => countLines(f) > 800);
      return {
        pass: over.length === 0,
        detail:
          over.length === 0
            ? `0 .tsx >800L (de ${files.length})`
            : over.map((f) => `${f.split("/").slice(-2).join("/")}:${countLines(f)}L`).join(", "),
      };
    },
  },
  {
    id: "7.5",
    desc: "cargo test --lib --bins (--features finance si el modulo existe) pasa: exit 0, >=1 'test result: ok' y 0 failed",
    auto: true,
    check() {
      // Antes el desc decia --lib --bins y ejecutaba solo --lib (calidad-rust-12):
      // los tests del sidecar no entraban. Con finance (ronda 2): es el build
      // que se despliega y comparte compilacion con los checks de cargo.mjs.
      const fin = P.financeSourcePresent(existsSync, join, CC_TAURI) ? " --features finance" : "";
      const r = run(`cargo test${fin} --lib --bins --quiet -- --test-threads=1 2>&1`, {
        cwd: join(CC, "src-tauri"),
        timeout: 600000,
      });
      return P.cargoTestVerdict({ code: r.code, output: r.stdout + r.stderr });
    },
  },
  {
    id: "7.6",
    desc: "sidecar deployado fresco: mtime(bin/ultron-memory.exe) >= ultimo commit que toca memory/",
    auto: true,
    check() {
      // Mandamiento 3: el .exe que ejecutan los hooks debe ser POSTERIOR al ultimo
      // cambio en memory/. Si quedo mas viejo -> "parece que no se aplico" (stale binary).
      const binPath = join(BIN, "ultron-memory.exe");
      if (!existsSync(binPath)) {
        return { pass: false, detail: "no medible: bin/ultron-memory.exe ausente" };
      }
      // git log -1 --format=%ct (epoch s) del ultimo commit que toca el modulo memory/.
      const r = run(
        `git log -1 --format=%ct -- control-center/src-tauri/src/memory/`,
        { cwd: REPO, timeout: 15000 },
      );
      const commitSec = parseInt(r.stdout.trim(), 10);
      if (!r.ok || !Number.isFinite(commitSec) || commitSec <= 0) {
        return { pass: false, detail: "no medible: git log -1 memory/ sin commit (clon shallow/sin historial)" };
      }
      let binSec;
      try {
        binSec = Math.floor(statSync(binPath).mtimeMs / 1000);
      } catch (e) {
        return { pass: false, detail: "no medible: statSync(bin) fallo: " + e.message };
      }
      const driftMin = ((binSec - commitSec) / 60).toFixed(1);
      return {
        pass: binSec >= commitSec,
        detail:
          binSec >= commitSec
            ? `bin fresco: mtime ${driftMin}min DESPUES del commit memory/`
            : `STALE: bin ${Math.abs(driftMin)}min ANTES del ultimo commit memory/ -> rebuild+redeploy`,
      };
    },
  },
  {
    id: "7.7",
    desc: "bin/ultron-memory.exe identico a target/release/ (cmp -s) — sin paso de copia olvidado",
    auto: true,
    check() {
      // Tras `cargo build --release` hay que COPIAR a bin/. Si se olvida, el .exe
      // deployado diverge del compilado. cmp -s exit 0 == byte-identicos.
      const binPath = join(BIN, "ultron-memory.exe");
      const relPath = join(CC, "src-tauri", "target", "release", "ultron-memory.exe");
      if (!existsSync(binPath)) return { pass: false, detail: "no medible: bin/ultron-memory.exe ausente" };
      if (!existsSync(relPath)) {
        return { pass: false, detail: "no medible: target/release/ultron-memory.exe ausente (sin build local)" };
      }
      const r = run(
        `cmp -s "${fwd(binPath)}" "${fwd(relPath)}"; echo $?`,
        { cwd: ULTRON, timeout: 20000 },
      );
      const code = parseInt(r.stdout.trim().split("\n").pop(), 10);
      return {
        pass: code === 0,
        detail:
          code === 0
            ? "bin/ == target/release/ (byte-identicos)"
            : `DIVERGEN (cmp exit=${code}): falta copiar el binario recien compilado a bin/`,
      };
    },
  },
  {
    id: "7.8",
    desc: "version embebido == HEAD: el .exe imprime el git SHA y coincide con rev-parse HEAD",
    auto: true,
    check() {
      // Unica prueba honesta de que el .exe corresponde a HEAD (mtime reciente lo
      // puede falsear un `touch`). known_red: HOY no existe subcomando que emita SHA
      // -> `version` da exit!=0 "unknown subcommand". ESE es el hallazgo (mandamiento 3):
      // sin SHA embebido no se puede verificar correspondencia exacta exe<->commit.
      const binPath = join(BIN, "ultron-memory.exe");
      if (!existsSync(binPath)) return { pass: false, detail: "no medible: bin/ultron-memory.exe ausente" };
      const rHead = run(`git rev-parse --short HEAD`, { cwd: REPO, timeout: 10000 });
      const head = rHead.stdout.trim();
      if (!rHead.ok || !head) return { pass: false, detail: "no medible: git rev-parse HEAD fallo" };
      // Prueba el subcomando que DEBERIA emitir el SHA.
      const rVer = run(`"${fwd(binPath)}" version 2>&1`, { cwd: ULTRON, timeout: 15000 });
      const out = (rVer.stdout + rVer.stderr).trim();
      // Falla honesta: no hay subcomando 'version' (unknown subcommand) o no imprime el SHA.
      if (!rVer.ok || /unknown subcommand|unrecognized|no such/i.test(out)) {
        return {
          pass: false,
          detail: `sin SHA embebido: 'version' -> "${out.slice(0, 80)}" (anadir build.rs git SHA + subcomando para verificar exe==HEAD)`,
        };
      }
      const emits = out.includes(head);
      return {
        pass: emits,
        detail: emits ? `version embebe HEAD ${head}` : `version="${out.slice(0, 60)}" NO contiene HEAD ${head}`,
      };
    },
  },
  {
    id: "7.9",
    desc: "cada hook del manifest ARRANCA sin crash (exit 0 + sin Error:/excepcion) en HOME aislado; los inyectores SessionStart/UserPromptSubmit emiten stdout no vacio",
    auto: true,
    check() {
      // cat12.4 hace solo `node --check` (sintaxis): un hook sintacticamente valido
      // puede PETAR al arrancar (require ausente, path Windows, JSON.parse de stdin).
      // Aqui se EJECUTA cada hook con un payload minimo y se asevera el arranque real.
      //
      // (2026-10-23, medidor-1) Solo los scripts de hooks/manifest.json, que es
      // quien define que es hook: antes se lanzaban los 37 .js de la carpeta,
      // entre ellos session-summarize-previous.js, que sin --session resumia con
      // Codex la sesion VIVA y la fusionaba en estado.json. Y en HOME aislado y
      // sin sidecar (spawnHook): ni gc, ni capture, ni drain contra brain.db.
      if (!existsSync(HOOKS_SCRIPTS)) return { pass: false, detail: "no medible: hooks/scripts ausente" };
      const manifest = readJSON(HOOKS_MANIFEST);
      if (!manifest) return { pass: false, detail: "no medible: hooks/manifest.json ausente o ilegible" };
      const declared = P.manifestHookScripts(manifest, HOME, REPO);
      const missing = declared.filter((h) => !existsSync(h.script)).map((h) => h.script.split("/").pop());
      const hooks = declared.filter((h) => existsSync(h.script));
      if (hooks.length === 0) return { pass: false, detail: "no medible: 0 hooks del manifest en disco" };
      // Inyectores SessionStart/UserPromptSubmit: su unico proposito es emitir
      // additionalContext -> stdout vacio = no-op silencioso (mandamiento 11). El resto
      // (capture/sync/relay) son side-effect y producen stdout vacio LEGITIMAMENTE.
      const MUST_EMIT = new Set([
        "memory-session-resume.js",
        "memory-orchestrate.js",
      ]);
      const CRASH = /\b(TypeError|ReferenceError|SyntaxError|RangeError|MODULE_NOT_FOUND)\b|Cannot read|is not a function|Error:/;
      const crashed = [];
      const silentInjectors = [];
      for (const { script, event } of hooks) {
        const name = script.split("/").pop();
        // Payload minimo del evento con el que lo declara el manifest. Sin
        // session_id ni transcript: nada que resumir, capturar ni fusionar.
        const payload = {
          cwd: ULTRON,
          source: "startup",
          hook_event_name: event,
          prompt: "refactoriza el modulo de auth",
          tool_name: "Glob",
          tool_input: { pattern: "*.rs" },
          transcript_path: "",
        };
        const r = spawnHook(script, payload, { timeout: 30000 });
        const out = (r.stdout ?? "") + (r.stderr ?? "");
        if (r.error || r.status !== 0 || CRASH.test(out)) {
          crashed.push(`${name}:exit=${r.status}${r.error ? `(${r.error.code ?? "spawn"})` : ""}`);
          continue;
        }
        if (MUST_EMIT.has(name) && (r.stdout ?? "").trim().length === 0) {
          silentInjectors.push(name);
        }
      }
      const bad = crashed.length + silentInjectors.length + missing.length;
      return {
        pass: bad === 0,
        detail:
          bad === 0
            ? `${hooks.length} hooks del manifest arrancan OK en HOME aislado; ${MUST_EMIT.size} inyectores emiten contexto`
            : `crash=[${crashed.join(", ")}] inyector-silencioso=[${silentInjectors.join(", ")}] ausentes=[${missing.join(", ")}]`,
      };
    },
  },
]);
