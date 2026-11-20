// kirkardo/cats-04.mjs — categoria 4 (skills y agentes).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as P from "./predicates.mjs";
import { AGENTS_DIR, REPO, SETTINGS_JSON, SKILLS_DIR, ULTRON, cat, readJSON } from "./core.mjs";

// ---------------------------------------------------------------------------
// CAT 4 — Skill/Agent Routing
// ---------------------------------------------------------------------------
// (2026-11-14) El dispatcher v2/v3 se borro (desconectado desde el 2026-09-29):
// 4.1-4.6 median su salida y se fueron con el. 4.8 mide la carga bajo demanda
// que hay hoy (pool de skills con revision del SHA fijado).
cat(4, "Skill/Agent Routing", [
  {
    id: "4.7",
    desc: "skills activas en disco: carpetas de primer nivel con SKILL.md en ~/.claude/skills (las que cargan) <= 12 y sin sufijo legacy .disabled",
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
      const diskCount = active.length;
      return {
        pass: diskCount <= 12 && legacy.length === 0,
        detail: `disco=${diskCount} (<=12) legacy_.disabled=${legacy.length}`,
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
