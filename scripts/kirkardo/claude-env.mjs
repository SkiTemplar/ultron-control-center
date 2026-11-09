// kirkardo/claude-env.mjs — lectura del entorno de Claude Code que comparten
// 10.4, 4.10 y 2.11: plugins instalados y HABILITADOS, y frontmatter de los
// agentes de usuario. Solo lectura; memoizado por corrida.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, CLAUDE, SETTINGS_JSON, readJSON } from "./core.mjs";

let _plugins;

/**
 * Plugins habilitados en settings.json con su ruta de instalacion.
 * Devuelve { byNs: Map(ns -> [installPath]), agentNames: Set(lowercase),
 * item(ns, name) -> bool }. Un plugin instalado pero deshabilitado no cuenta:
 * la herramienta Skill/Agent no lo ve.
 */
export function pluginIndex() {
  if (_plugins) return _plugins;
  const installed = readJSON(join(CLAUDE, "plugins", "installed_plugins.json"))?.plugins ?? {};
  const enabled = readJSON(SETTINGS_JSON)?.enabledPlugins ?? {};
  const byNs = new Map();
  for (const [key, list] of Object.entries(installed)) {
    if (enabled[key] !== true) continue;
    const ns = key.split("@")[0];
    const paths = (Array.isArray(list) ? list : []).map((e) => e?.installPath).filter((p) => p && existsSync(p));
    byNs.set(ns, [...(byNs.get(ns) ?? []), ...paths]);
  }
  // Nombre suelto y con espacio de nombres (`pr-review-toolkit:code-reviewer`),
  // que es como los lanza la herramienta Agent.
  const agentNames = new Set();
  for (const [ns, paths] of byNs) {
    for (const p of paths) {
      const dir = join(p, "agents");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const base = f.slice(0, -3).toLowerCase();
        agentNames.add(base);
        agentNames.add(`${ns.toLowerCase()}:${base}`);
      }
    }
  }
  const item = (ns, name) => {
    const paths = byNs.get(ns);
    if (!paths) return false;
    return paths.some((p) =>
      existsSync(join(p, "agents", `${name}.md`)) ||
      existsSync(join(p, "skills", name, "SKILL.md")) ||
      existsSync(join(p, "commands", `${name}.md`)));
  };
  _plugins = { byNs, agentNames, item };
  return _plugins;
}

/** Agentes ACTIVOS de usuario (.md) con su linea `tools:` (null si no la tienen). */
export function activeAgentTools() {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const text = readFileSync(join(AGENTS_DIR, f), "utf8");
      const fm = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] ?? "";
      const tools = (fm.match(/^tools:\s*(.*)$/m) || [])[1] ?? null;
      return { name: f.slice(0, -3), tools: tools === null ? null : tools.trim() };
    });
}
