// Settings/api-keys/types.ts — tipos compartidos entre el hook, la seccion
// y los componentes de fila. Sin datos ni logica, solo formas.

/** Mini-tutorial por clave: pasos cortos, para qué la usa ULTRON y qué pasa
 *  si falta. Todo dato verificado contra la fuente oficial en `sourceUrl`
 *  (o contra el propio código de ULTRON cuando el dato es "qué zona la usa").
 */
export interface KeyTutorial {
  steps: string[];
  usedFor: string;
  ifMissing: string;
  sourceUrl: string;
  sourceLabel: string;
}

/** Grupo del catálogo de claves (contrato 2026-10-26, §5). `subscription`
 *  son CLI sin key (Codex, Antigravity) y `custom` los proveedores
 *  `ULTRON_KEY_*` que añade el usuario; ninguno de los dos vive en
 *  PROVIDER_KEYS. */
export type KeyGroup = "subscription" | "paid" | "free" | "research" | "custom";

export interface ProviderKeyDef {
  envVar: string;
  label: string;
  docsUrl: string;
  placeholder: string;
  group: KeyGroup;
  tutorial: KeyTutorial;
}

/** Formato de API de un proveedor personalizado (subconjunto de
 *  `Provider.api_format` que admite `ai_router_upsert_custom_provider`). */
export type CustomApiFormat = "openai_compat" | "anthropic" | "gemini";

/** Espejo de `CustomProviderInput` (Rust, contrato §4). */
export interface CustomProviderInput {
  id: string;
  name: string;
  base_url: string;
  api_format: CustomApiFormat;
  key_env_var: string;
  default_model?: string;
}

/** Proveedor del router tal y como lo devuelve `ai_router_list_providers`,
 *  con los campos internos que necesita esta sección. */
export interface RouterProviderRecord {
  id: string;
  name: string;
  key_env_var?: string;
  base_url?: string;
  api_format?: string;
  custom?: boolean;
  api_key_status?: "configured" | "missing" | "placeholder";
  models?: string[];
}

export type ResearchKeyDef = ProviderKeyDef & { isEmail: boolean };

export interface EnvKeysSaveResult {
  saved: string[];
  skipped: string[];
  errors: Record<string, string>;
}

export interface FieldState {
  value: string;
  visible: boolean;
}

// Mirrors crate::env_keys::EnvKeyStatus.
export interface EnvKeyStatus {
  env_var: string;
  active: boolean;
  configured: boolean;
  masked: string | null;
  is_secret: boolean;
}

export interface GithubTokenResult {
  ok: boolean;
  masked: string;
  message: string;
}

// Espejo de ai_router::KeyValidation (modulo ai_router/, cat14.5).
export interface KeyValidation {
  provider_id: string;
  provider_label: string;
  has_key: boolean;
  source: string;
  warning?: string | null;
}
