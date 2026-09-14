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
