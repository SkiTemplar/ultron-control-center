// kirkardo/decisions.mjs — retiradas por decision con vigencia comprobada en ejecucion.
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CATS, CC_SRC, CLAUDE, HOOKS_MANIFEST, HOOKS_SCRIPTS, REPO, SETTINGS_JSON, ULTRON, doctorCheck, grepInFiles, hooksText, readJSON, spawnHook } from "./core.mjs";

// Ronda 3 (2026-10-28): checks sustituidos por uno de comportamiento. Clave =
// check retirado; valor = check que lo sustituye. La decision medidor-r3 esta
// en vigor mientras TODOS los sustitutos sigan registrados: si alguien borra
// el sustituto, el original vuelve a medirse solo.
export const SUPERSEDED = {
  "2.8": "2.10", // duplicado: dos criterios del indice por proyecto que se contradecian; queda el de ensure-project
  "9.1": "9.11", // existencia de scripts del manifest -> paridad real con regen-manifest.js --check
  "12.3": "9.11", // existe .pre-commit-config.yaml -> lo que el pre-commit exige, ejecutado
  "12.1": "10.8", // texto 'vitest' en ci.yml -> vitest completo ejecutado
  "14.11": "10.8", // vitest de orchestrator y palette, absorbido por el vitest completo
  "18.3": "23.4", // existe playwright.config.ts -> los e2e de Sessions ejecutados
  "10.6": "5.6", // lapida de routing-dispatcher.jsonl en live_session.rs -> check unico de lapidas
  "11.3": "5.6", // lapida headroom wrap
  "11.4": "5.6", // lapida ecc@ecc
  "16.1": "5.6", // RTK en CLAUDE.md
  "16.2": "5.6", // headroom con uv (daba verde sin uv)
  "16.3": "5.6", // mem0 en hooks
  "16.4": "5.6", // mem0 en settings
};

// PURA. medidor-r3 en vigor si todos los sustitutos estan registrados.
export function supersededStatus(registeredIds, table = SUPERSEDED) {
  const missing = [...new Set(Object.values(table))].filter((id) => !registeredIds.has(id));
  return {
    inForce: missing.length === 0,
    evidence: missing.length ? `sustitutos sin registrar: ${missing.join(",")}` : `${Object.keys(table).length} checks sustituidos por ${new Set(Object.values(table)).size} de comportamiento registrados`,
  };
}

function ciWorkflowsText() {
  const dir = join(REPO, ".github", "workflows");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
}

// ---------------------------------------------------------------------------
// Retiradas por decision (2026-10-23)
// ---------------------------------------------------------------------------
// Un check retirado sale del denominador SOLO mientras la decision con fecha que
// lo retira siga en vigor, y eso se verifica en ejecucion en cada corrida
// (configuracion efectiva + comportamiento del binario o del hook). Si la
// decision deja de estar en vigor, el check vuelve a medirse solo, sin tocar el
// harness. Los retirados salen en el informe y en el JSON con su evidencia; no
// desaparecen en silencio. Tabla y reactivacion: docs/GOAL.md, "Retiradas por
// decision".

const isOffValue = (v) => v === "0" || v === "false";

// Variable de usuario de Windows (HKCU\Environment): la heredan la app y Claude
// Code aunque el shell del harness no la tenga. undefined = no legible (no
// Windows o sin `reg`); null = no definida.
function userEnvVar(name) {
  if (process.platform !== "win32") return undefined;
  let r;
  try {
    r = spawnSync("reg", ["query", "HKCU\\Environment", "/v", name], { encoding: "utf8", timeout: 10000 });
  } catch {
    return undefined;
  }
  if (r.error) return undefined;
  if (r.status !== 0) return null;
  const m = (r.stdout || "").match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

const showVal = (v) => (v === undefined ? "(no legible)" : v === null ? "(ausente)" : v);

// PURA. Denso apagado (2026-09-28): ULTRON_DENSE y ULTRON_RERANK a 0 en el env de
// settings.json y en las variables de usuario, sin override en el entorno del
// harness, y el binario desplegado confirma qdrant.dense=false en el doctor.
export function denseOffStatus({ settingsEnv, userEnv, processEnv, doctorDense }) {
  const ok = [];
  const bad = [];
  for (const k of ["ULTRON_DENSE", "ULTRON_RERANK"]) {
    const s = settingsEnv?.[k];
    (isOffValue(s) ? ok : bad).push(`settings.env.${k}=${showVal(s ?? null)}`);
    const u = userEnv?.[k];
    (isOffValue(u) ? ok : bad).push(`HKCU.${k}=${showVal(u)}`);
    const p = processEnv?.[k];
    if (p !== undefined && !isOffValue(p)) bad.push(`entorno del harness ${k}=${p}`);
  }
  (doctorDense === false ? ok : bad).push(`doctor qdrant.dense=${doctorDense ?? "(sin dato)"}`);
  return { inForce: bad.length === 0, evidence: (bad.length ? bad : ok).join(", ") };
}

// PURA. Orchestrate ligero (2026-09-28/29): nadie fija ULTRON_ORCHESTRATE=full y
// el hook real, ante un prompt tecnico, no emite orchestration-context ni
// directiva (sin recall, routing ni delegacion por prompt).
export function orchestrateLightStatus({ settingsEnv, userEnv, processEnv, probe }) {
  const ok = [];
  const bad = [];
  const k = "ULTRON_ORCHESTRATE";
  for (const [label, v] of [["settings.env", settingsEnv?.[k] ?? null], ["HKCU", userEnv?.[k]], ["entorno del harness", processEnv?.[k] ?? null]]) {
    (v === "full" ? bad : ok).push(`${label}.${k}=${showVal(v)}`);
  }
  if (!probe?.ok) bad.push(`hook sin salida JSON (${probe?.raw ?? "?"})`);
  else if (probe.full) bad.push("el hook emite orchestration-context/directiva (modo completo)");
  else ok.push(`hook: ${probe.len} chars, sin orchestration-context`);
  return { inForce: bad.length === 0, evidence: (bad.length ? bad : ok).join(", ") };
}

// PURA. Dispatcher de skills desconectado (2026-09-29, 7ff38577): ninguna fuente
// de hooks (settings de usuario y manifest) referencia routing-dispatcher.
// sources = [{ label, text }]; text=null => fuente no legible (no se presume).
export function dispatcherOffStatus({ sources }) {
  const bad = [];
  const ok = [];
  for (const s of sources ?? []) {
    if (s.text === null || s.text === undefined) bad.push(`${s.label} no legible`);
    else if (/routing-dispatcher/.test(s.text)) bad.push(`${s.label} referencia routing-dispatcher`);
    else ok.push(`${s.label} sin routing-dispatcher`);
  }
  if (!sources?.length) bad.push("sin fuentes de hooks");
  return { inForce: bad.length === 0, evidence: (bad.length ? bad : ok).join(", ") };
}

function probeOrchestrateMode() {
  const hook = join(HOOKS_SCRIPTS, "memory-orchestrate.js");
  if (!existsSync(hook)) return { ok: false, raw: "memory-orchestrate.js ausente" };
  const input = JSON.stringify({
    prompt: "refactoriza el modulo de recall y revisa la arquitectura del pipeline",
    cwd: ULTRON,
    hook_event_name: "UserPromptSubmit",
  });
  const r = spawnHook(hook, input, { timeout: 60000 });
  let ac;
  try {
    const j = JSON.parse((r.stdout ?? "").trim());
    ac = j.hookSpecificOutput?.additionalContext ?? j.additionalContext ?? "";
  } catch {
    return { ok: false, raw: String(r.stdout || r.stderr || "").slice(0, 80) };
  }
  return { ok: true, len: ac.length, full: /<orchestration-(context|directive)/.test(ac) };
}

export const DECISIONS = {
  "dense-off": {
    date: "2026-09-28",
    reason:
      "denso apagado (E5 + reranker + Qdrant): ULTRON_DENSE=0 y ULTRON_RERANK=0; recall solo FTS5 (golden recall@8 0,131 aceptado)",
    reactivate:
      "quitar ULTRON_DENSE/ULTRON_RERANK del env de settings.json y de las variables de usuario, rehabilitar UltronQdrant y los hooks ensure-qdrant/memory-warmup/qdrant-mirror-sync",
    status() {
      const settingsEnv = readJSON(SETTINGS_JSON)?.env ?? {};
      const userEnv = { ULTRON_DENSE: userEnvVar("ULTRON_DENSE"), ULTRON_RERANK: userEnvVar("ULTRON_RERANK") };
      const pre = denseOffStatus({ settingsEnv, userEnv, processEnv: process.env, doctorDense: false });
      // Si la configuracion ya lo desmiente no hace falta preguntar al binario.
      const doctorDense = pre.inForce ? doctorCheck("qdrant")?.data?.dense : undefined;
      return denseOffStatus({ settingsEnv, userEnv, processEnv: process.env, doctorDense });
    },
  },
  "orchestrate-light": {
    date: "2026-09-28",
    reason:
      "memory-orchestrate en modo ligero (solo tono): sin recall, routing ni directivas de delegacion por prompt; la memoria entra por el resume de arranque y la bitacora (memory_recall fuera del MCP desde el 2026-10-03)",
    reactivate: "ULTRON_ORCHESTRATE=full (env de settings.json o variable de usuario)",
    status() {
      const settingsEnv = readJSON(SETTINGS_JSON)?.env ?? {};
      const userEnv = { ULTRON_ORCHESTRATE: userEnvVar("ULTRON_ORCHESTRATE") };
      return orchestrateLightStatus({ settingsEnv, userEnv, processEnv: process.env, probe: probeOrchestrateMode() });
    },
  },
  "dispatcher-off": {
    date: "2026-09-29",
    reason:
      "dispatcher de skills v2/v3 desconectado de settings.json y hooks/manifest.json (commit 7ff38577): nada inyecta SKILL.md por prompt; las skills se cargan bajo demanda (/skill, pool por proyecto)",
    reactivate: "volver a cablear routing-dispatcher.v2/v3.js en settings.json (UserPromptSubmit) y regenerar hooks/manifest.json",
    status() {
      const sources = [
        { label: "settings.json", text: hooksText(SETTINGS_JSON) },
        { label: "hooks/manifest.json", text: hooksText(HOOKS_MANIFEST) },
      ];
      const local = join(CLAUDE, "settings.local.json");
      if (existsSync(local)) sources.push({ label: "settings.local.json", text: hooksText(local) });
      return dispatcherOffStatus({ sources });
    },
  },
};

// ---------------------------------------------------------------------------
// Ronda 3 (2026-10-28): decisiones sin checks propios (DEC1 de la auditoria) y
// las que retiran checks de la ronda 3. Su vigencia sale en el JSON aunque no
// retiren nada: una decision revertida en silencio se ve en el informe.
// ---------------------------------------------------------------------------
Object.assign(DECISIONS, {
  "medidor-r3": {
    date: "2026-10-28",
    reason: "auditoria del criterio del medidor: checks de existencia, texto o lapida sustituidos por uno de comportamiento (tabla SUPERSEDED en decisions.mjs)",
    reactivate: "borrar el sustituto de SUPERSEDED (o el check sustituto): el original vuelve a medirse",
    status() {
      return supersededStatus(new Set(CATS.flatMap((c) => c.checks.map((k) => k.id))));
    },
  },
  "cowork-retired": {
    date: "2026-10-28",
    reason: "plugin ultron-memory-cowork borrado: session-end-summary.js ya no lo empaqueta nadie; los candidatos por sesion salen de session-end-bitacora.js y lesson-distill.js",
    reactivate: "volver a crear plugins/ultron-memory-cowork o cablear session-end-summary.js en el manifest",
    status() {
      const plugin = existsSync(join(REPO, "plugins", "ultron-memory-cowork"));
      const wired = /session-end-summary/.test(hooksText(HOOKS_MANIFEST) ?? "");
      return { inForce: !plugin && !wired, evidence: `plugins/ultron-memory-cowork=${plugin ? "presente" : "ausente"}, session-end-summary en el manifest=${wired}` };
    },
  },
  "memory-browser-retired": {
    date: "2026-10-23",
    reason: "Memory Browser retirado de la UI (la memoria se gobierna por inbox, resume y bitacora)",
    reactivate: "volver a montar MemoryBrowser.tsx",
    status() {
      const hits = grepInFiles(/MemoryBrowser/, CC_SRC, [".tsx", ".ts"]).length;
      return { inForce: hits === 0, evidence: `referencias a MemoryBrowser en src=${hits}` };
    },
  },
  "filechanged-off": {
    date: "2026-10-23",
    reason: "sin hooks FileChanged: no se reacciona a cambios de fichero por hook",
    reactivate: "cablear un hook FileChanged en hooks/manifest.json",
    status() {
      const txt = readFileSync(HOOKS_MANIFEST, "utf8");
      const on = /"FileChanged"/.test(txt);
      return { inForce: !on, evidence: `FileChanged en hooks/manifest.json=${on}` };
    },
  },
  "lienzo-fuera": {
    date: "2026-10-28",
    reason: "Lienzo de escritorio (desktop/lienzo-desk, C# WPF) fuera del alcance del medidor: superficie distinta de la app Tauri, sin build ni tests en CI",
    reactivate: "anadir su build al CI o un check dotnet build en el medidor",
    status() {
      const inCi = /lienzo/i.test(ciWorkflowsText());
      return { inForce: !inCi, evidence: `lienzo en los workflows de CI=${inCi}` };
    },
  },
});

/** Calcula la vigencia de TODAS las decisiones (memoizada) para el JSON. */
export function refreshAllDecisions() {
  for (const id of Object.keys(DECISIONS)) decisionStatus(id);
}

// Vigencia memoizada por corrida: cada decision se comprueba una sola vez.
export const _decisionCache = new Map();
export function decisionStatus(id) {
  if (!_decisionCache.has(id)) {
    const d = DECISIONS[id];
    let st;
    try {
      st = d ? d.status() : { inForce: false, evidence: `decision desconocida: ${id}` };
    } catch (e) {
      st = { inForce: false, evidence: `vigencia no comprobable: ${e.message}` };
    }
    _decisionCache.set(id, st);
  }
  return _decisionCache.get(id);
}
