// Settings/api-keys/validation.ts — validacion de formato client-side.

/** Same "parse, don't validate" shape as the backend (env_keys.rs::is_valid_email):
 *  one non-edge `@` and a domain with a dot. Client-side only fails fast; the
 *  backend is the actual gate. */
export function isPlausibleEmail(raw: string): boolean {
  const at = raw.indexOf("@");
  if (at <= 0 || at === raw.length - 1) return false;
  const domain = raw.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

// ------------------------------------------------------------------
// Proveedores personalizados (contrato plans/2026-10-26, §Decisiones y §4).
// El backend repite estas comprobaciones; aquí solo se falla pronto y con
// el motivo a la vista.
// ------------------------------------------------------------------

/** Nombre de variable de una key personalizada (mismo regex que el backend). */
export const CUSTOM_KEY_ENV_RE = /^ULTRON_KEY_[A-Z0-9_]{2,40}$/;

/** Id de proveedor personalizado, igual que `is_slug` en custom.rs:
 *  2-40 caracteres a-z, 0-9 y `-`, sin `-` en los extremos. Con 40 como
 *  máximo la variable derivada nunca pasa del tope de CUSTOM_KEY_ENV_RE. */
export const CUSTOM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;

/** Tope del nombre en caracteres (no en unidades UTF-16), como custom.rs. */
export const CUSTOM_NAME_MAX = 80;

export const CUSTOM_API_FORMATS = ["openai_compat", "anthropic", "gemini"] as const;

/** Hosts loopback admitidos por http (misma lista que `is_loopback_http`). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `true` si `raw` es una URL http a un host loopback (servidor local). */
export function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** `ULTRON_KEY_<SLUG>` a partir del id (`mi-proxy` → `ULTRON_KEY_MI_PROXY`). */
export function slugToKeyEnv(id: string): string {
  return `ULTRON_KEY_${id.trim().toUpperCase().replace(/-/g, "_")}`;
}

/** Id sugerido a partir del nombre (`Mi Proxy Ñ` → `mi-proxy-n`). */
export function suggestSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export interface CustomProviderDraft {
  name: string;
  id: string;
  baseUrl: string;
  apiFormat: string;
  apiKey: string;
}

export type CustomProviderErrors = Partial<Record<keyof CustomProviderDraft, string>>;

function validateBaseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "La base_url es obligatoria.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "La base_url no es una URL válida.";
  }
  if (url.username || url.password) return "La base_url no puede llevar credenciales.";
  if (url.search || url.hash) return "La base_url no puede llevar query ni fragmento.";
  if (url.protocol === "https:") return null;
  if (isLoopbackHttpUrl(value)) return null;
  return "La base_url tiene que ser https (http solo para localhost).";
}

/**
 * Valida el formulario «Añadir proveedor personalizado». `takenIds` son los
 * ids de proveedores que NO son personalizados: pisarlos sobrescribiría uno
 * del seed. Un id personalizado existente sí se admite (upsert = editar).
 * Devuelve un objeto vacío si todo es válido.
 */
export function validateCustomProvider(
  draft: CustomProviderDraft,
  takenIds: ReadonlySet<string>,
): CustomProviderErrors {
  const errors: CustomProviderErrors = {};
  const name = draft.name.trim();
  const id = draft.id.trim();

  if (!name) errors.name = "El nombre es obligatorio.";
  else if ([...name].length > CUSTOM_NAME_MAX) {
    errors.name = `El nombre admite como mucho ${CUSTOM_NAME_MAX} caracteres.`;
  }

  if (!CUSTOM_ID_RE.test(id)) {
    errors.id =
      "Id de 2 a 40 caracteres: minúsculas, dígitos o «-», sin «-» al principio ni al final.";
  } else if (takenIds.has(id)) {
    errors.id = `El id «${id}» ya lo usa un proveedor del router que no es personalizado.`;
  } else if (!CUSTOM_KEY_ENV_RE.test(slugToKeyEnv(id))) {
    errors.id = "El id no genera una variable ULTRON_KEY_* válida.";
  }

  const urlError = validateBaseUrl(draft.baseUrl);
  if (urlError) errors.baseUrl = urlError;

  if (!(CUSTOM_API_FORMATS as readonly string[]).includes(draft.apiFormat)) {
    errors.apiFormat = "Formato no admitido: openai_compat, anthropic o gemini.";
  }

  if (/\s/.test(draft.apiKey.trim())) {
    errors.apiKey = "La key no puede contener espacios ni saltos de línea.";
  }

  return errors;
}
