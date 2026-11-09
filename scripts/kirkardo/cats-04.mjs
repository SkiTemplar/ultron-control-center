// kirkardo/cats-04.mjs — categoria 4 (skills y agentes).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as P from "./predicates.mjs";
import { AGENTS_DIR, REPO, SETTINGS_JSON, SKILLS_DIR, SKILLS_REGISTRY_COCKPIT, SKILL_LAZY, ULTRON, cat, fileExists, readJSON, run, spawnHook } from "./core.mjs";

// ---------------------------------------------------------------------------
// CAT 4 — Skill/Agent Routing
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CAT 4 — Skill/Agent Routing (OUTPUT del hook, no rankCandidates)
// ---------------------------------------------------------------------------
// Endurecida 2026-06-24: la cat vieja medía rankCandidates() sobre 21 casos
// sintéticos con el trigger LITERAL — nunca ejecutaba main()/buildInjectionBlock
// ni observaba el additionalContext que de verdad llega al modelo. Verificado en
// runtime: un prompt TDD rutea bien PERO inyecta el SKILL.md del NAMESPACE
// catch-all 'superpowers' (name: superpowers) en vez del de TDD, y ADEMÁS arrastra
// un ecc:hexagonal-architecture irrelevante. cat4.5 medía --v3 mientras el binario
// LIVE de settings.json es v2 (sin fallback semántico). Esta versión EJECUTA el
// hook real (routing-dispatcher.v2.js por stdin) y asevera sobre su salida.
//
// (2026-10-23) Desde el 2026-09-29 el dispatcher no esta cableado: 4.1-4.6 median
// un script que no corre en produccion (verdes y rojos sobre codigo sin
// consumidor). Quedan retirados mientras siga desconectado; 4.8 mide la carga
// bajo demanda que hay hoy (pool de skills con revision del SHA fijado).
const DISPATCHER_V2 = join(SKILL_LAZY, "routing-dispatcher.v2.js");

// Ejecuta el hook con {prompt} por stdin y devuelve el additionalContext + lo
// parseado: skills inyectadas (bloques [skill-inyectada:X]) y candidatos sugeridos
// (Suggested: / "1)" / "2)" del hint). Fail-safe: ok=false si el hook no emite JSON.
function runDispatcher(prompt, scriptPath = DISPATCHER_V2) {
  const r = spawnHook(scriptPath, { prompt, hook_event_name: "UserPromptSubmit" }, { timeout: 30000 });
  if (r.error) return { ok: false, raw: String(r.error) };
  const out = (r.stdout ?? "").trim();
  let ac;
  try {
    ac = JSON.parse(out).hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return { ok: false, raw: out.slice(0, 160) };
  }
  // skills inyectadas: id + cuerpo del SKILL.md de cada bloque
  const blocks = [];
  const blockRe = /--- \[skill-inyectada: ([^\]]+)\] ---\n([\s\S]*?)\n--- \[fin skill-inyectada: \1\] ---/g;
  let bm;
  while ((bm = blockRe.exec(ac)) !== null) blocks.push({ id: bm[1], body: bm[2] });
  // candidatos sugeridos observables en el hint (sin contenido inyectado)
  const labels = [];
  const sug = ac.match(/Suggested:\s*\w+:(\S+)/);
  if (sug) labels.push(sug[1]);
  const numRe = /\d\)\s*\w+:([^\s(]+)/g;
  let nm;
  while ((nm = numRe.exec(ac)) !== null) labels.push(nm[1]);
  return {
    ok: true,
    ac,
    len: ac.length,
    injectedIds: blocks.map((b) => b.id),
    blocks,
    candidates: [...new Set(labels)],
  };
}

// Extrae el `name:` del front-matter YAML del cuerpo de un bloque inyectado.
function injectedSkillName(body) {
  const m = (body || "").match(/^\s*name:\s*([^\n]+)/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

// CASES e2e del hook: prompt -> id esperado en el top-3 OBSERVABLE del
// additionalContext (Suggested + candidatos del hint), no rankCandidates. Mismo set
// que el harness viejo medía in-process, ahora cruzado contra la SALIDA real del
// hook. Incluye casos EN donde el OUTPUT no lista el id (p.ej. el hint de
// "code-reviewer" solo lleva 1 candidato) -> ya no es 100% trivial.
const ROUTING_CASES = [
  { prompt: "activa don claudio para el netcode de ue5", expected: "don-claudio" },
  { prompt: "tio gilito, anade un gasto a mi presupuesto", expected: "tio-gilito" },
  { prompt: "modo tolkien, escribe el siguiente capitulo", expected: "tolkien" },
  { prompt: "jordan, necesito un pitch para inversores b2b", expected: "jordan-belfort" },
  { prompt: "mike tyson, revisa la jerarquia visual del landing", expected: "mike-tyson" },
  { prompt: "alfred, mata el proceso y limpia la carpeta local", expected: "alfred" },
  { prompt: "arregla los tipos de typescript en este componente react", expected: "typescript-pro" },
  { prompt: "optimiza el uso de memoria en rust con tokio", expected: "rust-engineer" },
  { prompt: "audita la seguridad: posible sql injection y owasp", expected: "security-auditor" },
  { prompt: "tengo un stack trace y un panic, encuentra la causa raiz", expected: "debugger" },
  { prompt: "haz tdd con red green refactor antes de implementar", expected: "superpowers:test-driven-development" },
  { prompt: "haz un security scan del repositorio buscando cve", expected: "security-scan" },
  { prompt: "consolida memoria y ordena el index de .ultron", expected: "consolidate-memory" },
  { prompt: "revisa el pr buscando problemas de calidad de codigo", expected: "pr-review-toolkit:code-reviewer" },
  { prompt: "review this pull request for code quality issues", expected: "code-reviewer" },
  { prompt: "profile the hot path, there is an n+1 query bottleneck", expected: "performance-engineer" },
  { prompt: "design a kubernetes helm chart for the cluster", expected: "kubernetes-specialist" },
  { prompt: "write a rag pipeline with a vector db and embeddings", expected: "ai-engineer" },
  { prompt: "set up a github actions ci cd pipeline", expected: "devops-engineer" },
  { prompt: "merge a postgresql schema migration with zero-downtime", expected: "database-migrations" },
  { prompt: "systematic debugging, I cannot find the intermittent bug", expected: "superpowers:systematic-debugging" },
];

// Negativos: NO deben inyectar nada (additionalContext sin Suggested/skill).
const NEGATIVE_CASES = ["gracias", "que hora es", "vale perfecto", "buenos dias", "ok dale"];

// Prompts representativos para el techo de context_chars (uno carga la persona
// dominante de un FAST PATH, otro arrastra el bug del namespace + ECC).
const CTX_PROMPTS = [
  "haz tdd con red green refactor antes de implementar",
  "optimiza el uso de memoria en rust con tokio",
  "audita la seguridad: posible sql injection y owasp",
];
const CTX_MAX_CHARS = 12000;

cat(4, "Skill/Agent Routing (output del hook)", [
  {
    id: "4.1",
    desc: "SKILL.md correcto inyectado: el bloque de un superpowers:* trae su propio name, no el namespace catch-all 'superpowers'",
    auto: true,
    retiredBy: "dispatcher-off",
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      // Cada superpowers:* debe inyectar SU SKILL.md (name == sub-skill), NO el del
      // namespace 'superpowers'. Hoy resolveSkillMdPath cae en skills/superpowers.disabled
      // (name: superpowers) -> el modelo recibe el manifiesto genérico, no la guía pedida.
      const cases = [
        { prompt: "haz tdd con red green refactor antes de implementar", id: "superpowers:test-driven-development", expectName: "test-driven-development" },
        { prompt: "haz un debug sistematico de este bug intermitente sin causa obvia", id: "superpowers:systematic-debugging", expectName: "systematic-debugging" },
      ];
      const bad = [];
      let checked = 0;
      for (const c of cases) {
        const r = runDispatcher(c.prompt);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        const blk = r.blocks.find((b) => b.id === c.id);
        if (!blk) { bad.push(`${c.id}:no-inyectado`); continue; }
        checked++;
        const nm = injectedSkillName(blk.body);
        if (nm !== c.expectName) bad.push(`${c.id}:name="${nm}"(esp ${c.expectName})`);
      }
      if (checked === 0) return { pass: false, detail: "no medible: ningún superpowers:* llegó a inyectarse" };
      return {
        pass: bad.length === 0,
        detail: bad.length === 0
          ? `${checked} superpowers:* inyectan su SKILL.md propio`
          : `${bad.length} con SKILL.md erróneo (namespace catch-all): ${bad.join(", ")}`,
      };
    },
  },
  {
    id: "4.2",
    desc: "0 falsos positivos ECC: prompts no-ECC (TDD/commit/debug) no inyectan ningún ecc:*",
    auto: true,
    retiredBy: "dispatcher-off",
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      // Set-trampa: ninguno pide arquitectura hexagonal/puertos-adaptadores. Si el
      // hook inyecta un ecc:* es un falso positivo (floor ECC rebajado). Verificado
      // hoy: TDD arrastra ecc:hexagonal-architecture -> FAIL honesto.
      const trap = [
        "haz tdd con red green refactor antes de implementar",
        "git commit con conventional commits",
        "haz un debug sistematico de este bug intermitente",
        "optimiza el uso de memoria en rust con tokio",
      ];
      const offenders = [];
      for (const p of trap) {
        const r = runDispatcher(p);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        const ecc = r.injectedIds.filter((id) => id.startsWith("ecc:"));
        if (ecc.length) offenders.push(`"${p.slice(0, 24)}"->${ecc.join("/")}`);
      }
      return {
        pass: offenders.length === 0,
        detail: offenders.length === 0
          ? `${trap.length} prompts no-ECC, 0 ecc:* inyectados`
          : `${offenders.length} falsos positivos ECC: ${offenders.join(" | ")}`,
      };
    },
  },
  {
    id: "4.3",
    desc: "accuracy@3 por OUTPUT del hook >= 90% (id esperado en el top-3 observable, no rankCandidates)",
    auto: true,
    retiredBy: "dispatcher-off",
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      let hits = 0;
      const miss = [];
      for (const c of ROUTING_CASES) {
        const r = runDispatcher(c.prompt);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        const top3 = r.candidates.slice(0, 3);
        if (top3.includes(c.expected)) hits++;
        else miss.push(`"${c.prompt.slice(0, 26)}"->${JSON.stringify(top3)}(esp ${c.expected})`);
      }
      const pct = (hits / ROUTING_CASES.length) * 100;
      return {
        pass: pct >= 90,
        detail: `accuracy@3(output)=${pct.toFixed(1)}% (${hits}/${ROUTING_CASES.length})` +
          (miss.length ? ` miss: ${miss.slice(0, 2).join(" | ")}` : ""),
      };
    },
  },
  {
    id: "4.4",
    desc: "casos negativos: 'gracias'/'que hora es' -> additionalContext sin routing (vacío, 0 skills)",
    auto: true,
    retiredBy: "dispatcher-off",
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      const offenders = [];
      for (const p of NEGATIVE_CASES) {
        const r = runDispatcher(p);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        // negativo limpio = sin candidato sugerido Y sin skill inyectada
        if (r.candidates.length > 0 || r.injectedIds.length > 0) {
          offenders.push(`"${p}"->cand=${JSON.stringify(r.candidates)} inj=${JSON.stringify(r.injectedIds)}`);
        }
      }
      return {
        pass: offenders.length === 0,
        detail: offenders.length === 0
          ? `${NEGATIVE_CASES.length} negativos -> 0 routing (correcto)`
          : `${offenders.length} negativos rutearon algo: ${offenders.join(" | ")}`,
      };
    },
  },
  {
    id: "4.5",
    desc: "binario LIVE == medido: el dispatcher de settings.json se comporta segun su capacidad (v3 emite [semantic-fallback] en prompt ambiguo; v2 no)",
    auto: true,
    retiredBy: "dispatcher-off",
    check() {
      // Mide el dispatcher que de VERDAD corre (settings.json), no un v2 hardcodeado.
      // El marcador real de v3 es "[semantic-fallback: top-N by similarity]"; el regex
      // viejo \[semantic-fallback\] exigia un ']' inmediato y nunca casaba -> el check
      // daba rojo aunque v3 (live) si emite el fallback. Doble fix de fidelidad.
      const s = readJSON(SETTINGS_JSON);
      if (!s) return { pass: false, detail: "no medible: settings.json ausente" };
      let liveCmd = null;
      for (const group of s.hooks?.UserPromptSubmit ?? []) {
        for (const h of group.hooks ?? []) {
          if (h.command && /routing-dispatcher/.test(h.command)) liveCmd = h.command;
        }
      }
      if (!liveCmd) return { pass: false, detail: "no medible: ningún routing-dispatcher en UserPromptSubmit" };
      const isV3 = /routing-dispatcher\.v3/.test(liveCmd);
      const livePath = (liveCmd.match(/(\S*routing-dispatcher\.v\d+\.js)/) || [])[1] || DISPATCHER_V2;
      const ambiguous = "necesito ayuda con esto que tengo aqui montado";
      // Pre-warm: si el daemon E5 esta frio, la 1a llamada puede no devolver
      // resultados semanticos dentro del presupuesto del hook. Reintentar.
      let hasFallback = false;
      let measured = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = runDispatcher(ambiguous, livePath);
        if (r.ok) {
          measured = true;
          if (/\[semantic-fallback/i.test(r.ac)) { hasFallback = true; break; }
        }
        if (attempt < 2) run("sleep 3", { timeout: 5000 });
      }
      if (!measured) return { pass: false, detail: "no medible: el dispatcher live no emitió JSON" };
      if (isV3) {
        return { pass: hasFallback, detail: `LIVE=v3 (medido sobre el binario live); prompt ambiguo semantic-fallback=${hasFallback}` };
      }
      return {
        pass: !hasFallback,
        detail: `LIVE=v2 (determinista); prompt ambiguo semantic-fallback=${hasFallback} (esperado false)`,
      };
    },
  },
  {
    id: "4.6",
    desc: "context_chars techo: additionalContext <= 12000 chars en prompts representativos (cap inflado silencioso)",
    auto: true,
    retiredBy: "dispatcher-off",
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      // Un prompt puede inflar el bloque (14032 chars visto con TDD por el namespace
      // catch-all + ECC). El cap de 3 inyecciones no acota los chars. Mide el OUTPUT real.
      const over = [];
      let maxLen = 0;
      for (const p of CTX_PROMPTS) {
        const r = runDispatcher(p);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        maxLen = Math.max(maxLen, r.len);
        if (r.len > CTX_MAX_CHARS) over.push(`"${p.slice(0, 24)}"=${r.len}`);
      }
      return {
        pass: over.length === 0,
        detail: over.length === 0
          ? `max additionalContext=${maxLen} chars (<=${CTX_MAX_CHARS})`
          : `${over.length} sobre techo (${CTX_MAX_CHARS}): ${over.join(", ")} [max=${maxLen}]`,
      };
    },
  },
  {
    id: "4.7",
    desc: "keep_active vs disco: carpetas de primer nivel con SKILL.md en ~/.claude/skills (las que cargan) == keep_active del registry y <= 12",
    auto: true,
    check() {
      // cat4.3 vieja solo leía el JSON del registry. El criterio real es el DISCO: una
      // skill activa es una carpeta de PRIMER nivel con SKILL.md (excluye dotdirs
      // como .git y dirs auxiliares sin manifiesto como 'learned'). Lo perezoso
      // vive en _disabled/<name>/ (Claude Code no desciende); el sufijo legacy
      // .disabled SI carga, asi que cuenta como activa (antes se excluia).
      if (!existsSync(SKILLS_DIR)) return { pass: false, detail: "no medible: ~/.claude/skills ausente" };
      let active;
      try {
        active = readdirSync(SKILLS_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .filter((e) => existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
          .map((e) => e.name);
      } catch (e) {
        return { pass: false, detail: `no medible: readdir falló (${e.message})` };
      }
      const legacy = active.filter((n) => n.endsWith(".disabled"));
      const reg = readJSON(SKILLS_REGISTRY_COCKPIT);
      const keepNames = reg ? reg.filter((x) => x.keep_active === true).map((x) => x.name ?? x.id) : null;
      const keepActive = keepNames ? keepNames.length : null;
      const diskCount = active.length;
      const matchesRegistry = keepActive === null ? true : diskCount === keepActive;
      const onlyDisk = keepNames ? active.filter((n) => !keepNames.includes(n)) : [];
      const onlyReg = keepNames ? keepNames.filter((n) => !active.includes(n)) : [];
      return {
        pass: diskCount <= 12 && matchesRegistry && legacy.length === 0,
        detail: `disco=${diskCount} (<=12) keep_active=${keepActive ?? "N/A"} match=${matchesRegistry} legacy_.disabled=${legacy.length}` +
          (matchesRegistry ? "" : ` [divergencia disco/registry: solo_disco=${onlyDisk.join(",") || "-"} solo_registry=${onlyReg.join(",") || "-"}]`),
      };
    },
  },
  {
    id: "4.8",
    desc: "carga bajo demanda viva: /skill activa, cada entrada de la pool con revision del SHA/version fijado y `skill-pool.mjs show` de cada kind=skill sale con exit 0",
    auto: true,
    check() {
      // Sustituye a 4.1-4.6 mientras el dispatcher siga desconectado: hoy una skill
      // de terceros entra por /skill <nombre> (skill-pool.mjs show), que se niega si
      // la revision no es del SHA fijado o el clon no coincide. Se ejecuta ese
      // camino real sobre toda la pool.
      const poolCli = join(REPO, "scripts", "skill-pool.mjs");
      if (!existsSync(poolCli)) return { pass: false, detail: "no medible: scripts/skill-pool.mjs ausente" };
      const loader = existsSync(join(SKILLS_DIR, "skill", "SKILL.md"));
      // Los clones (repos/) son estado vivo de ~/.ultron (ignorados por git):
      // desde un worktree se usa la pool desplegada, no una vacia.
      const POOL_OPTS = { encoding: "utf8", timeout: 30000, cwd: REPO, env: { ...process.env, ULTRON_SKILL_POOL_ROOT: join(ULTRON, "skill-pool") } };
      const ls = spawnSync("node", [poolCli, "list", "--json"], POOL_OPTS);
      let entries;
      try {
        entries = JSON.parse(ls.stdout).entries;
      } catch {
        return { pass: false, detail: `skill-pool list --json no devolvio JSON: ${String(ls.stderr || ls.stdout).slice(0, 100)}` };
      }
      if (!Array.isArray(entries) || entries.length === 0) return { pass: false, detail: "no medible: pool vacia" };
      const unreviewed = entries.filter((e) => !e.review?.sha || e.review.sha !== (e.sha ?? e.version)).map((e) => e.name);
      const skills = entries.filter((e) => e.kind === "skill");
      const broken = skills
        .filter((e) => spawnSync("node", [poolCli, "show", e.name], POOL_OPTS).status !== 0)
        .map((e) => e.name);
      return {
        pass: loader && unreviewed.length === 0 && broken.length === 0 && skills.length > 0,
        detail: `loader /skill=${loader} pool=${entries.length} sin_revision_del_fijado=${unreviewed.join(",") || 0} show_kind_skill=${skills.length - broken.length}/${skills.length}` +
          (broken.length ? ` rotas: ${broken.join(",")}` : ""),
      };
    },
  },
  {
    id: "4.9",
    desc: "agentes de usuario ACTIVOS solo con la familia 5.5 y con maxTurns; alias opus/sonnet/haiku del env de settings.json fijados a claude-<x>-5-5",
    auto: true,
    check() {
      // Reglas de core.md (2026-09-28 y 2026-10-21): solo la familia 5.5, todos
      // los agentes de usuario con maxTurns, alias fijados en settings.env.
      // Ronda 2: los .md.disabled ya no cuentan aqui porque la pestana Agents
      // se niega a activarlos fuera de la politica (8c2d8a81); esa puerta la
      // mide 4.11 con sus tests.
      if (!existsSync(AGENTS_DIR)) return { pass: false, detail: "no medible: ~/.claude/agents ausente" };
      const settings = readJSON(SETTINGS_JSON);
      if (!settings) return { pass: false, detail: "no medible: settings.json ilegible" };
      const agents = readdirSync(AGENTS_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({
          name: f.replace(/\.md(\.disabled)?$/, ""),
          disabled: f.endsWith(".disabled"),
          ...P.agentFrontmatter(readFileSync(join(AGENTS_DIR, f), "utf8")),
        }));
      return P.agentModelVerdict(agents, settings.env ?? {});
    },
  },
]);
