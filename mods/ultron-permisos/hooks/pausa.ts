/**
 * Pausa con caducidad de las peticiones de permiso del fichero de variables de
 * entorno que hace `deny-secrets` (hook de ULTRON). Este mod es su único
 * productor: el agente no puede escribir el fichero (deny duro en el hook), así
 * que solo la persona la pone desde el chat con `/permisos pausar-env`.
 *
 * Solo afecta a los casos «ask» del hook (el `.env` y los `.npmrc`/`.pypirc`);
 * las claves privadas, `.ssh` y demás siguen en deny duro con o sin pausa.
 */

/** Tope de la pausa en minutos; el hook ignora una fecha a más de 12 h vista. */
export const PAUSA_MAX_MIN = 720

const PAUSA_RELATIVE = '.ultron/run/deny-secrets-pausa.json'

/** Ruta del fichero: la de `ULTRON_DENY_SECRETS_PAUSA` si existe, si no la de `~/.ultron/run`. */
export function pausaPath(home: string, override: string | undefined): string | null {
  if (override !== undefined && override.trim() !== '') return override.trim()
  if (home === '') return null
  return `${home.replace(/[\\/]+$/, '')}/${PAUSA_RELATIVE}`
}

/** Minutos válidos (entero de 1 a PAUSA_MAX_MIN) o null. */
export function parseMinutes(text: string): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null
  const minutes = Number(text.trim())
  return minutes >= 1 && minutes <= PAUSA_MAX_MIN ? minutes : null
}

/** Contenido del fichero para una pausa de `minutes` minutos desde `now` (ms). */
export function pausaContent(now: number, minutes: number): string {
  const hasta = new Date(now + minutes * 60_000).toISOString()
  return `${JSON.stringify({ hasta, desde: new Date(now).toISOString(), origen: '/permisos pausar-env' })}\n`
}

/** Contenido que cierra la pausa: una fecha ya pasada, que el hook trata como «sin pausa». */
export function reanudarContent(now: number): string {
  return `${JSON.stringify({ hasta: new Date(now).toISOString(), origen: '/permisos reanudar-env' })}\n`
}

/** Minutos que le quedan a la pausa del fichero, o null si no hay pausa vigente. */
export function minutesLeft(text: string | null, now: number): number | null {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''))
    const hasta = typeof parsed === 'object' && parsed !== null ? (parsed as { hasta?: unknown }).hasta : undefined
    const end = typeof hasta === 'string' ? Date.parse(hasta) : Number.NaN
    if (!Number.isFinite(end) || end <= now || end - now > PAUSA_MAX_MIN * 60_000) return null
    return Math.ceil((end - now) / 60_000)
  } catch {
    return null
  }
}

/** Línea de estado para el listado de `/permisos`. */
export function pausaLine(left: number | null): string {
  return left === null
    ? 'Pausa de deny-secrets (.env): inactiva'
    : `Pausa de deny-secrets (.env): activa, quedan ${left} min (/permisos reanudar-env para cerrarla)`
}
