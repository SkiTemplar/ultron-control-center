// kirkardo/cats-11-14.mjs — categorias 11 (MCP), 12 (CI), 13 (prompts) y 14 (backend/UI).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import * as P from "./predicates.mjs";
import * as R2 from "./predicates-r2.mjs";
import { cargoTestCheck } from "./cargo.mjs";
import { AGENTS_DIR, CC_SRC, CC_TAURI, COCKPIT, HOME, HOOKS_SCRIPTS, REPO, SETTINGS_JSON, SKILLS_DIR, SKILLS_REGISTRY_COCKPIT, ULTRON, cat, fileExists, grepInFiles, importersOf, invokeCallsites, readJSON, run } from "./core.mjs";

// ---------------------------------------------------------------------------
// CAT 11 — Plugins y MCPs
// ---------------------------------------------------------------------------
cat(11, "Plugins y MCPs", [
  {
    id: "11.1",
    desc: "0 entradas duplicadas de MCP en .claude.json",
    auto: true,
    check() {
      // MCPs viven en ~/.claude.json (no en settings.json)
      const claudeJson = join(HOME, ".claude.json");
      const c1 = readJSON(claudeJson);
      const c2 = readJSON(SETTINGS_JSON);
      if (!c1 && !c2) return { pass: false, detail: "no medible: ni ~/.claude.json ni settings.json legibles" };
      const s1 = c1 ?? {};
      const s2 = c2 ?? {};
      const allNames = [
        ...Object.keys(s1.mcpServers ?? {}),
        ...Object.keys(s2.mcpServers ?? {}),
      ];
      const seen = new Set();
      const dups = [];
      for (const n of allNames) {
        if (seen.has(n)) dups.push(n);
        seen.add(n);
      }
      return {
        pass: dups.length === 0,
        detail: dups.length === 0 ? `0 MCPs duplicados (total=${allNames.length})` : `dups: ${dups.join(", ")}`,
      };
    },
  },
  {
    id: "11.2",
    desc: "0 scopes invalidos (System32, AppData\\Local\\Temp): MCP de scope local, permisos o directorios adicionales bajo esas rutas en settings/.claude.json",
    auto: true,
    check() {
      // Criterio original (2026-06-08): "basura de scopes System32 + mcpServers" en
      // ~/.claude.json. Un scope es configuracion que concede algo: MCP de scope
      // local (projects[ruta].mcpServers / enabledMcpjsonServers), allowedTools,
      // additionalDirectories, o permisos de settings.json que apunten ahi. Claude
      // Code crea solo una clave projects[ruta] por cada cwd en que arranca (hoy
      // las sesiones de prueba de ULTRON en Temp): esa clave sin concesiones es su
      // estado interno, no un scope, y antes ponia el check en rojo por texto.
      const BAD = /System32|AppData[\\/]+Local[\\/]+Temp/i;
      const settings = readJSON(SETTINGS_JSON);
      const claudeJson = readJSON(join(HOME, ".claude.json"));
      if (!settings || !claudeJson) return { pass: false, detail: "no medible: settings.json o ~/.claude.json ilegible" };
      const grants = [];
      const permTxt = JSON.stringify(settings.permissions ?? {});
      if (BAD.test(permTxt)) grants.push("settings.permissions");
      if (BAD.test(JSON.stringify(claudeJson.mcpServers ?? {}))) grants.push(".claude.json mcpServers");
      let stateOnly = 0;
      for (const [path, v] of Object.entries(claudeJson.projects ?? {})) {
        const conf = {
          mcpServers: v?.mcpServers ?? {},
          enabledMcpjsonServers: v?.enabledMcpjsonServers ?? [],
          allowedTools: v?.allowedTools ?? [],
          additionalDirectories: v?.additionalDirectories ?? [],
        };
        const confTxt = JSON.stringify(conf);
        const grantsSomething =
          Object.keys(conf.mcpServers).length > 0 ||
          conf.enabledMcpjsonServers.length > 0 ||
          conf.allowedTools.length > 0 ||
          conf.additionalDirectories.length > 0;
        if (BAD.test(path)) {
          if (grantsSomething) grants.push(`projects[${path.slice(-40)}]`);
          else stateOnly++;
        } else if (BAD.test(confTxt)) {
          grants.push(`projects[${path.slice(-40)}] apunta a una ruta invalida`);
        }
      }
      return {
        pass: grants.length === 0,
        detail: grants.length === 0
          ? `0 scopes con concesiones bajo System32/Temp (${stateOnly} clave(s) de estado de Claude Code sin concesiones, ignoradas)`
          : `${grants.length} scope(s) invalidos: ${grants.slice(0, 4).join(" | ")}`,
      };
    },
  },
  {
    id: "11.3",
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: "Spawns SIN headroom wrap (= 0 referencias en spawn scripts)",
    auto: true,
    check() {
      // Ausencia de un wrapper descartado (decision de 2026-06): se mira el codigo
      // que lanza sesiones. La rama "spawn script no encontrado (OK)" daba verde
      // sin buscar nada; ahora se busca siempre y sin tuberias.
      const roots = [join(REPO, "scripts"), COCKPIT].filter((d) => existsSync(d));
      if (roots.length === 0) return { pass: false, detail: "no medible: ni scripts/ ni cockpit/" };
      const hits = roots.flatMap((d) => grepInFiles(/headroom wrap/, d, [".ps1", ".sh", ".js", ".mjs"]))
        .filter((m) => !/kirkardo-eval\.mjs$|[/\\]kirkardo[/\\]/.test(m.file));
      return { pass: hits.length === 0, detail: `${hits.length} referencias a headroom wrap en ${roots.length} raiz(es)` };
    },
  },
  {
    id: "11.4",
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: "ecc plugin DESACTIVADO en settings.json",
    auto: true,
    check() {
      const s = readJSON(SETTINGS_JSON);
      if (!s) return { pass: false, detail: "settings.json no encontrado" };
      // Clave ausente = plugin no instalado/desactivado (audit 2026-09-04: el
      // medidor exigia enabled=false literal y daba rojo con la clave ausente).
      const eccEnabled = s.enabledPlugins?.["ecc@ecc"];
      const off = eccEnabled === false || eccEnabled === undefined;
      return { pass: off, detail: `ecc@ecc enabled=${eccEnabled === undefined ? "(ausente)" : eccEnabled}` };
    },
  },
  {
    id: "11.5",
    desc: "delete_mcp persiste el borrado en config (no es no-op): cuerpo escribe el archivo",
    auto: true,
    check() {
      // Criterio binario 11.3 historico: delete_mcp modifica la config, no es un Ok(()) vacio.
      // (2026-10-23, seguridad-4) La persistencia se sigue por la CADENA DE
      // LLAMADAS desde delete_mcp_inner hasta una escritura a disco; antes valia
      // cualquier serde_json::to_string en el fichero.
      const mutFiles = grepInFiles(/fn\s+delete_mcp_inner/, CC_TAURI, [".rs"]);
      if (mutFiles.length === 0) return { pass: false, detail: "delete_mcp_inner no encontrado en src-tauri/src" };
      const modDir = dirname(mutFiles[0].file);
      const bodies = new Map();
      const modFiles = [...new Set(grepInFiles(/\bfn\s+/, modDir, [".rs"]).map((m) => m.file))];
      for (const f of modFiles) {
        for (const [k, v] of P.rustFnBodies(readFileSync(f, "utf8"))) if (!bodies.has(k)) bodies.set(k, v);
      }
      const body = bodies.get("delete_mcp_inner") ?? "";
      if (/^\s*Ok\(\(\)\)\s*$/.test(body.trim()) || !/\.remove\s*\(/.test(body)) {
        return { pass: false, detail: "delete_mcp_inner no quita la entrada de mcpServers (no-op / Ok(()) vacio)" };
      }
      const path = P.persistencePath(bodies, "delete_mcp_inner");
      return {
        pass: path !== null,
        detail: path ? `delete_mcp_inner quita la entrada y persiste: ${path.join(" -> ")}` : "delete_mcp_inner muta pero ninguna cadena de llamadas llega a una escritura a disco",
      };
    },
  },
  {
    id: "11.6",
    desc: "0 secretos en claro (ghp_/sk-/AKIA/xox/gsk_/AIza) en la config de los servidores MCP de ~/.claude.json (usuario y proyectos) y settings.json",
    auto: true,
    check() {
      // Primera propiedad de SEGURIDAD de los MCP que mide cat11 (auditoria
      // 2026-10-23, seguridad-4): un token en args/env de un servidor queda en un
      // fichero que leen todos los procesos del usuario. Solo lectura.
      const cj = readJSON(join(HOME, ".claude.json"));
      const st = readJSON(SETTINGS_JSON);
      if (!cj && !st) return { pass: false, detail: "no medible: ni ~/.claude.json ni settings.json legibles" };
      const scopes = [["usuario", cj?.mcpServers], ["settings.json", st?.mcpServers]];
      for (const [p, v] of Object.entries(cj?.projects ?? {})) scopes.push([`proyecto ${p.slice(-30)}`, v?.mcpServers]);
      let servers = 0;
      const hits = [];
      for (const [label, map] of scopes) {
        servers += Object.keys(map ?? {}).length;
        for (const name of P.mcpSecretHits(map)) hits.push(`${label}:${name}`);
      }
      if (servers === 0) return { skip: true, detail: "0 servidores MCP configurados: nada que revisar" };
      return {
        pass: hits.length === 0,
        detail: hits.length === 0 ? `${servers} servidores MCP sin tokens en claro` : `${hits.length} servidor(es) con token en claro: ${hits.slice(0, 4).join(", ")}`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 12 — Facilidad de implementacion
// ---------------------------------------------------------------------------
cat(12, "Facilidad de implementacion", [
  {
    id: "12.1",
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: "CI .yml incluye cargo test + vitest",
    auto: true,
    check() {
      const ciFile = join(REPO, ".github", "workflows", "ci.yml");
      if (!fileExists(ciFile)) return { pass: false, detail: "ci.yml no encontrado" };
      const content = readFileSync(ciFile, "utf8");
      const hasCargo = /cargo test/i.test(content);
      const hasVitest = /vitest|npm test/i.test(content);
      return {
        pass: hasCargo && hasVitest,
        detail: `cargo test=${hasCargo}, vitest=${hasVitest}`,
      };
    },
  },
  {
    id: "12.2",
    desc: "CI timeout <= 30 min (windows job)",
    auto: true,
    check() {
      const ciFile = join(REPO, ".github", "workflows", "ci.yml");
      if (!fileExists(ciFile)) return { pass: false, detail: "ci.yml no encontrado" };
      const content = readFileSync(ciFile, "utf8");
      // Busca timeout-minutes en cargo job
      const m = content.match(/timeout-minutes:\s*([0-9]+)/g);
      const timeouts = (m ?? []).map((s) => parseInt(s.match(/([0-9]+)/)[1], 10));
      // Sin ningun timeout-minutes el maximo era 0 y pasaba por vacuidad.
      if (timeouts.length === 0) return { pass: false, detail: "ci.yml sin timeout-minutes en ningun job (techo por defecto de 360 min)" };
      const maxTimeout = Math.max(...timeouts);
      return { pass: maxTimeout <= 30, detail: `max timeout-minutes=${maxTimeout} (${timeouts.length} jobs con tope)` };
    },
  },
  {
    id: "12.3",
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: ".pre-commit-config.yaml existe",
    auto: true,
    check() {
      const p = join(REPO, ".pre-commit-config.yaml");
      return { pass: fileExists(p), detail: fileExists(p) ? "presente" : "ausente" };
    },
  },
  {
    id: "12.4",
    desc: "node --check en todos los scripts de hooks (syntax OK)",
    auto: true,
    check() {
      const r = run(`find "${HOOKS_SCRIPTS}" -name "*.js" 2>/dev/null`);
      const files = r.stdout.trim().split("\n").filter(Boolean);
      if (files.length === 0) return { pass: false, detail: "no medible: find no devolvio ningun .js en hooks/scripts" };
      const errors = [];
      for (const f of files) {
        const res = run(`node --check "${f}" 2>&1`);
        if (!res.ok) errors.push(f.split("/").slice(-1)[0] + ": " + res.stderr.trim().slice(0, 80));
      }
      return {
        pass: errors.length === 0,
        detail: errors.length === 0 ? `${files.length} scripts OK` : errors.join("; "),
      };
    },
  },
  {
    id: "12.5",
    desc: "CI real < 300s (duracion del ultimo run success de ci.yml, via gh)",
    auto: true,
    check() {
      // Mide el RUN REAL (updatedAt - createdAt) del ultimo ci.yml success. El check 12.2 solo
      // miraba timeout-minutes<=30 (un techo, no la duracion real). Criterio documentado = <300s.
      const r = run(
        `gh run list --workflow=ci.yml --status success --limit 1 --json databaseId,createdAt,updatedAt 2>&1`,
        { timeout: 30000 }
      );
      // gh ausente o sin red no es un CI lento: no medible aqui (skip), igual que 12.6.
      if (!r.ok) {
        return { skip: true, detail: `gh no disponible o sin red: ${(r.stdout + r.stderr).trim().slice(0, 120)}` };
      }
      let arr;
      try { arr = JSON.parse(r.stdout.trim()); } catch {
        return { skip: true, detail: `gh devolvio JSON no parseable: ${r.stdout.trim().slice(0, 120)}` };
      }
      if (!Array.isArray(arr) || arr.length === 0) {
        return { pass: false, detail: "0 runs success de ci.yml" };
      }
      const run0 = arr[0];
      const start = new Date(run0.createdAt).getTime();
      const end = new Date(run0.updatedAt).getTime();
      if (isNaN(start) || isNaN(end) || end < start) {
        return { pass: false, detail: `timestamps invalidos: ${run0.createdAt} / ${run0.updatedAt}` };
      }
      const secs = Math.round((end - start) / 1000);
      return { pass: secs < 300, detail: `CI run #${run0.databaseId} duro ${secs}s (limite 300s)` };
    },
  },
  {
    id: "12.6",
    desc: "el ultimo run de CI en main acabo en success Y es de HEAD o posterior a HEAD (gh run list --branch main --limit 1); skip si gh no esta, no hay red o el run sigue en curso",
    auto: true,
    check() {
      // 12.5 solo mira la duracion del ultimo run VERDE: un main en rojo no lo
      // veia ningun check (encargo P11, 2026-10-23). Ronda 2: un verde de un
      // commit anterior a HEAD no valida lo que se mide (codigo sin pushear o
      // CI sin lanzar sobre el ultimo main).
      const r = run("gh run list --branch main --limit 1 --json conclusion,status,databaseId,headSha,workflowName,createdAt", { timeout: 30000 });
      const h = run("git log -1 --format=%H%x20%ct", { cwd: REPO, timeout: 10000 });
      const [sha, ct] = h.stdout.trim().split(" ");
      if (!h.ok || !sha) return { pass: false, detail: `no medible: git log -1 en el repo fallo (${h.stderr.trim().slice(0, 80)})` };
      return P.ciMainVerdict({ ok: r.ok, stdout: r.stdout, stderr: r.stderr }, { sha, timeMs: Number(ct) * 1000 });
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 13 — Mejora de prompts
// ---------------------------------------------------------------------------
cat(13, "Mejora de prompts", [
  {
    id: "13.1",
    desc: "optimizador de prompt canonico CABLEADO: build_prompt_plan( llamado en orchestrate.rs fuera de comentarios, fn definida en el orquestador y 0 restos del alias optimize_prompt en src-tauri/src",
    auto: true,
    check() {
      // Ronda 2: el alias optimize_prompt se retiro (4569ab8b); exigir su
      // callsite daba rojo por el fix. Ahora: llamada real al canonico + 0
      // restos de codigo del alias (comentarios fuera).
      const orchestrateFile = join(CC_TAURI, "orchestrator", "orchestrate.rs");
      if (!fileExists(orchestrateFile)) return { pass: false, detail: "orchestrate.rs no encontrado" };
      const calls = R2.codeRefLines(readFileSync(orchestrateFile, "utf8"), /\bbuild_prompt_plan\s*\(/).length;
      const fnDef = grepInFiles(/\bfn\s+build_prompt_plan\b/, join(CC_TAURI, "orchestrator"), [".rs"]);
      const alias = grepInFiles(/\boptimize_prompt\b/, CC_TAURI, [".rs"]).filter((m) => !P.isCommentLine(m.text));
      return {
        pass: calls >= 1 && fnDef.length > 0 && alias.length === 0,
        detail: `llamadas build_prompt_plan( en orchestrate.rs=${calls}, fn definida=${fnDef.length > 0}, restos de optimize_prompt=${alias.length}` +
          (alias.length ? ` (${alias.slice(0, 3).map((m) => m.file.split(/[/\\]/).pop()).join(", ")})` : ""),
      };
    },
  },
  {
    id: "13.2",
    desc: "el plan de prompt se comporta: cargo test --features finance --lib orchestrator::tests_prompt_plan (vaguedad, multi-paso, modo denso efectivo) con >= 6 tests en verde",
    auto: true,
    check() {
      // Ronda 2: ya no se busca el simbolo (13.1 lo cubre); se mide el
      // comportamiento del optimizador con sus tests de la auditoria
      // (prompting-6 y prompting-7).
      return cargoTestCheck("orchestrator::tests_prompt_plan::", { minPassed: 6 });
    },
  },
  {
    id: "13.3",
    desc: "skills-registry.json (cockpit) sin fantasmas (skills o agentes existen en ~/.claude/)",
    auto: true,
    check() {
      const reg = readJSON(SKILLS_REGISTRY_COCKPIT);
      if (!reg) return { pass: false, detail: "skills-registry.json no encontrado" };
      if (!Array.isArray(reg) || reg.length === 0) return { skip: true, detail: "skills-registry.json vacio: nada que resolver" };
      const phantoms = [];
      // Skills con ":" son de plugins (commit-commands:commit) — se verifican por plugin activo
      const settings = readJSON(SETTINGS_JSON) ?? {};
      const enabledPlugins = Object.keys(settings.enabledPlugins ?? {}).filter((k) => settings.enabledPlugins[k] === true);
      for (const entry of reg) {
        const rawId = entry.id ?? entry.name;
        if (!rawId) continue;
        if (rawId.includes(":")) {
          // Formato "plugin-name:skill-name" — verifica que el plugin este activo en settings.json
          const pluginName = rawId.split(":")[0];
          // Busca si algun enabledPlugin empieza por el nombre del plugin
          const pluginActive = enabledPlugins.some((p) => p.startsWith(pluginName));
          if (!pluginActive) phantoms.push(rawId);
          continue;
        }
        // Verifica en ~/.claude/skills/ (activo o .disabled) O ~/.claude/agents/
        const checks = [
          join(SKILLS_DIR, rawId),
          join(SKILLS_DIR, "_disabled", rawId),
          join(SKILLS_DIR, rawId + ".disabled"),
          join(AGENTS_DIR, `${rawId}.md`),
          join(AGENTS_DIR, `${rawId}.md.disabled`),
        ];
        if (!checks.some((p) => existsSync(p))) {
          phantoms.push(rawId);
        }
      }
      return {
        pass: phantoms.length === 0,
        detail: phantoms.length === 0 ? `0 fantasmas en ${reg.length} entries` : `${phantoms.length} fantasmas: ${phantoms.slice(0, 5).join(", ")}`,
      };
    },
  },
  {
    id: "13.4",
    desc: "Routing propone GRUPO y optimiza por paso — verificacion manual",
    auto: false,
    check: null,
  },
]);

// ---------------------------------------------------------------------------
// CAT 14 — Backend/UI
// ---------------------------------------------------------------------------
cat(14, "Backend/UI", [
  {
    id: "14.1",
    desc: "ai_router_validate_keys invocado desde Settings UI",
    auto: true,
    check() {
      // Usa grepInFiles Node.js nativo
      const matches = grepInFiles(/validate_keys|ai_router_validate_keys/, CC_SRC, [".tsx", ".ts"]);
      return { pass: matches.length >= 1, detail: `${matches.length} referencias a validate_keys en src/` };
    },
  },
  {
    id: "14.2",
    desc: "Usage tab visible (componente Usage.tsx existe y se importa en App.tsx)",
    auto: true,
    check() {
      const usageTsx = join(CC_SRC, "components", "Usage.tsx");
      if (!fileExists(usageTsx)) return { pass: false, detail: "Usage.tsx no encontrado" };
      // Lee App.tsx directamente
      const appTsx = join(CC_SRC, "App.tsx");
      if (!fileExists(appTsx)) return { pass: false, detail: "App.tsx no encontrado" };
      const appContent = readFileSync(appTsx, "utf8");
      // Import real del componente y render (<Usage), no cualquier substring
      // "Usage" (auditoria 2026-10-23, medidor-13).
      const imported = /import\s*\{[^}]*\bUsage\b[^}]*\}\s*from\s*["'][^"']*\/Usage["']|import\(\s*["'][^"']*\/Usage["']/.test(appContent);
      const rendered = /<Usage\b/.test(appContent);
      return { pass: imported && rendered, detail: `Usage.tsx existe, importado=${imported} renderizado=${rendered} en App.tsx` };
    },
  },
  {
    id: "14.3",
    desc: "orchestrate_prompt con boton/panel montado en la UI: el .tsx que hace el invoke real lo importa otro componente de produccion",
    auto: true,
    check() {
      // Antes era el mismo grep que 10.1 (y contaba comentarios): ahora 10.1 mide
      // el invoke y 14.3 que su componente este montado (medidor-5).
      const comps = [...new Set(invokeCallsites("orchestrate_prompt").filter((m) => m.file.endsWith(".tsx")).map((m) => m.file))];
      if (comps.length === 0) return { pass: false, detail: "0 componentes .tsx con invoke real de orchestrate_prompt" };
      const mounted = comps.filter((f) => {
        const base = f.split(/[/\\]/).pop().replace(/\.tsx$/, "");
        return importersOf(base).some((m) => m.file !== f);
      });
      return {
        pass: mounted.length > 0,
        detail: `${mounted.length}/${comps.length} componente(s) con el invoke montados: ${comps.map((f) => f.split(/[/\\]/).pop()).join(", ")}`,
      };
    },
  },
  {
    id: "14.4",
    desc: "Panel Git funciona (verificacion visual)",
    auto: false,
    check: null,
  },
  {
    id: "14.5",
    desc: "Zone Editor presente en AIRouter",
    auto: true,
    check() {
      const zoneEditorPath = join(CC_SRC, "components", "AIRouter", "ZoneEditor.tsx");
      const found = fileExists(zoneEditorPath);
      return { pass: found, detail: found ? "ZoneEditor.tsx presente en AIRouter/" : "ZoneEditor.tsx no encontrado" };
    },
  },
  {
    id: "14.6",
    desc: "Panel CodeGraph en ProjectWorkspace — verificacion visual",
    auto: false,
    check: null,
  },
]);
