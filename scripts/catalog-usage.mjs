#!/usr/bin/env node
/**
 * catalog-usage.mjs — cruza la telemetria de routing con el catalogo en disco
 * para detectar skills/agentes MUERTOS (existen pero no se rutean).
 *
 * ALCANCE REAL (mandamiento 13): "muerto" = NO aparece en la ventana de telemetria
 * de routing-dispatcher.jsonl / orchestrate.jsonl (rotan a 1 MiB, ~ultimos cientos
 * de prompts). NO es "nunca util": es "frio en la ventana observada" -> candidato a
 * revisar/archivar, NO a borrado ciego.
 *
 * Uso: node scripts/catalog-usage.mjs
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
const CLAUDE = join(HOME, ".claude");
const ROUTING_LOG = join(CLAUDE, "logs", "routing-dispatcher.jsonl");
const ORCH_LOG = join(CLAUDE, "logs", "orchestrate.jsonl");
const SKILLS_DIR = join(CLAUDE, "skills");
const AGENTS_DIR = join(CLAUDE, "agents");

function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// --- Telemetria: que se inyecta/propone de verdad ---
const routing = readJsonl(ROUTING_LOG);
const skillHits = new Map();   // skillId -> veces inyectada
const eccHits = new Map();     // eccId -> veces matcheada
for (const e of routing) {
  for (const id of e.injected_ids ?? []) skillHits.set(id, (skillHits.get(id) ?? 0) + 1);
  if (e.ecc_candidate) eccHits.set(e.ecc_candidate, (eccHits.get(e.ecc_candidate) ?? 0) + 1);
}
const orch = readJsonl(ORCH_LOG);
const agentHits = new Map();   // agentName -> veces propuesto
for (const e of orch) {
  for (const a of e.agents ?? []) if (a?.name) agentHits.set(a.name, (agentHits.get(a.name) ?? 0) + 1);
}

// --- Disco: que existe ---
function listSkills() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name.replace(/\.disabled$/, ""), disabled: d.name.endsWith(".disabled") }));
}
function listAgents() {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".md.disabled"))
    .map((f) => f.replace(/\.md(\.disabled)?$/, ""));
}
const skills = listSkills();
const agents = listAgents();

// ECC: solo conocemos las usadas (no escaneamos las 232 aqui). Reportamos el ranking.
// IMPORTANTE (honestidad): las skills ACTIVAS (no .disabled) NO se inyectan via
// dispatcher -> nunca estan en injected_ids aunque se usen (se invocan por Skill tool
// o se cargan siempre). Solo las .disabled (lazy) son candidatas reales a poda. Y aun
// asi "frio en telemetria de inyeccion" != "nunca usado": una skill .disabled invocada
// por Skill tool explicito tampoco aparece aqui. -> revisar, no borrar a ciegas.
const skillsActive = skills.filter((s) => !s.disabled && !s.id.startsWith("."));
const skillsDead = skills.filter((s) =>
  s.disabled && !s.id.startsWith(".") && !skillHits.has(s.id) && !skillHits.has("ecc:" + s.id)
);
// Agentes ultron-* se invocan por flujos/comandos (/maxdual, news...), no por el
// orchestrate generico -> tambien falsos positivos. Se marcan aparte.
const agentsDead = agents.filter((a) => !agentHits.has(a) && !a.startsWith("ultron-"));
const agentsMetaCold = agents.filter((a) => !agentHits.has(a) && a.startsWith("ultron-"));

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

const out = {
  ventana: { routing_eventos: routing.length, orchestrate_eventos: orch.length },
  skills: {
    en_disco: skills.length,
    activas_nucleo: skillsActive.length,
    activas_lista: skillsActive.map((s) => s.id).sort(),
    disabled_inyectadas: new Set([...skillHits.keys()].filter((k) => !k.startsWith("ecc:"))).size,
    disabled_frias: skillsDead.length,
    top_usadas: topN(skillHits, 8),
    frias_lista: skillsDead.map((s) => s.id).sort(),
  },
  agentes: {
    en_disco: agents.length,
    propuestos_alguna_vez: agentHits.size,
    frios: agentsDead.length,
    meta_ultron_frios: agentsMetaCold.length,
    top_propuestos: topN(agentHits, 8),
    frios_lista: agentsDead.sort(),
    meta_ultron_lista: agentsMetaCold.sort(),
  },
  ecc: {
    matcheadas_distintas: eccHits.size,
    top_matcheadas: topN(eccHits, 8),
  },
};
console.log(JSON.stringify(out, null, 1));
