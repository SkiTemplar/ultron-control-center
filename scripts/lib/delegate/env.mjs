/**
 * env.mjs - entorno de los procesos hijo del delegador.
 *
 * Cada motor recibe process.env SIN ninguna variable secreta y, encima, solo
 * su propia key (`keyEnv` y las de su `envMap`). Secretas son: todo `keyEnv`
 * y todo nombre de `envMap` (origen y destino) de la configuracion, las keys
 * que gestiona la app (ALLOWED_KEYS de control-center/src-tauri/src/env_keys.rs)
 * y, por patron, `*_API_KEY`, `*_TOKEN`, `*_PAT`, `*_SECRET*`, `*_PASSWORD*`,
 * `AWS_*` y `ULTRON_KEY_*`. El check (que ejecuta codigo escrito por el motor)
 * recibe el entorno sin ninguna key.
 *
 * Sin esto, un motor gratuito de terceros heredaba la key de DeepSeek (OpenCode
 * activa solo los proveedores cuyas keys ve) y el modelo podia leerla con `env`.
 */

import { readKey } from './quota.mjs';
import { UsageError } from './proc.mjs';

const SECRET_PATTERN = /(_API_KEY|_TOKEN|_PAT)$|_SECRET|_PASSWORD|^AWS_|^ULTRON_KEY_/i;

/**
 * Copia de ALLOWED_KEYS (control-center/src-tauri/src/env_keys.rs): las keys
 * que la app guarda en el entorno del usuario. Un test de paridad compara las
 * dos listas (hardening-env.mjs).
 */
export const APP_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY', 'COHERE_API_KEY', 'NVIDIA_NIM_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY',
  'GITHUB_MODELS_TOKEN', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'XAI_API_KEY', 'SAMBANOVA_API_KEY',
  'HF_TOKEN', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'OPENALEX_API_KEY',
  'OPENALEX_MAILTO', 'SEMANTIC_SCHOLAR_API_KEY', 'UNPAYWALL_EMAIL',
]);

/**
 * Destino admitido en `envMap`: el nombre de key que espera el CLI del motor
 * (NVIDIA_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY…). Solo `*_API_KEY` y
 * `*_TOKEN`: nunca NODE_OPTIONS, PATH ni otra variable que cambie como arranca
 * el proceso.
 */
const ENV_TARGET = /^[A-Z][A-Z0-9_]{0,63}_(API_KEY|TOKEN)$/;
export const isAllowedEnvTarget = (name) => typeof name === 'string' && ENV_TARGET.test(name);

/** Motivo por el que el `envMap` de un motor no es valido, o null. */
export function envMapProblem(engine) {
  const map = engine && engine.envMap;
  if (map === undefined || map === null) return null;
  if (typeof map !== 'object' || Array.isArray(map)) return 'envMap no es un objeto';
  const bad = Object.keys(map).filter((t) => !isAllowedEnvTarget(t));
  return bad.length ? `envMap con destino no admitido (${bad.join(', ')}; solo *_API_KEY o *_TOKEN)` : null;
}

/** Nombres (en mayusculas) de las variables con keys segun la configuracion y la app. */
export function configSecretNames(config) {
  const names = new Set(APP_KEYS);
  const engines = config && typeof config.engines === 'object' && config.engines ? config.engines : {};
  for (const e of Object.values(engines)) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.keyEnv === 'string' && e.keyEnv) names.add(e.keyEnv.toUpperCase());
    const map = e.envMap && typeof e.envMap === 'object' ? e.envMap : {};
    for (const [target, source] of Object.entries(map)) {
      names.add(String(target).toUpperCase());
      names.add(String(source).toUpperCase());
    }
  }
  return names;
}

/** true si la variable `name` se considera secreta. */
export function isSecretName(name, configNames) {
  return SECRET_PATTERN.test(name) || configNames.has(String(name).toUpperCase());
}

/** Copia de `base` sin variables secretas. */
export function scrubbedEnv(config, base = process.env) {
  const names = configSecretNames(config);
  return Object.fromEntries(Object.entries(base).filter(([k]) => !isSecretName(k, names)));
}

/**
 * Entorno de un motor: el saneado mas DELEGATE_* y SOLO las keys del motor
 * (de process.env o de HKCU). `envMap` traduce al nombre que espera el CLI
 * (p. ej. NVIDIA_API_KEY <- NVIDIA_NIM_API_KEY); un destino fuera de la lista
 * blanca es un error (availability.mjs ya da el motor por deshabilitado).
 */
export function engineEnv(config, st, engine) {
  const problem = envMapProblem(engine);
  if (problem) throw new UsageError(`${st.id}: ${problem}`);
  const env = { ...scrubbedEnv(config), DELEGATE_ENGINE: st.id, DELEGATE_RUNNER: st.runner, DELEGATE_MODEL: st.model };
  if (engine.keyEnv) {
    const key = readKey(engine.keyEnv);
    if (key) env[engine.keyEnv] = key;
  }
  for (const [target, source] of Object.entries(engine.envMap || {})) {
    const key = readKey(String(source));
    if (key) env[target] = key;
  }
  return env;
}
