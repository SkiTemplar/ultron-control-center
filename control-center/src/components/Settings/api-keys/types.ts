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

export interface ProviderKeyDef {
  envVar: string;
  label: string;
  docsUrl: string;
  placeholder: string;
  tutorial: KeyTutorial;
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
