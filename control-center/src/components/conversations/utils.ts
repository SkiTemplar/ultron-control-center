// Utilidades puras del navegador de conversaciones (agrupado, titulo, formato).
// Sin I/O ni React: se testean directamente.

import type { ClaudeSession } from "../../types/projects";
import type { DateBucket } from "./types";

/** Milisegundos de un dia. */
const DAY = 86_400_000;

/**
 * Cubo temporal de una conversacion, calculado contra `now` (inyectable para
 * que el test no dependa del reloj).
 *
 * "Hoy" / "Ayer" son dias de CALENDARIO, no ventanas de 24 h: una sesion de
 * las 23:50 de ayer tiene que caer en "Ayer" aunque hayan pasado 30 minutos.
 */
export function bucketFor(lastActivity: string | null, now: Date = new Date()): DateBucket {
  if (!lastActivity) return "Sin fecha";
  const ts = new Date(lastActivity);
  if (Number.isNaN(ts.getTime())) return "Sin fecha";

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = ts.getTime();
  if (t >= startOfToday) return "Hoy";
  if (t >= startOfToday - DAY) return "Ayer";
  if (t >= startOfToday - 7 * DAY) return "Últimos 7 días";
  if (t >= startOfToday - 30 * DAY) return "Últimos 30 días";
  return "Más antiguo";
}

/**
 * Limpia el envoltorio XML que Claude Code mete en el primer mensaje.
 *
 * Una sesion lanzada con una barra (`/jarvis`) no guarda "jarvis" como texto:
 * guarda `<command-name>/jarvis</command-name><command-message>jarvis</…>
 * <command-args></command-args>`. Sin limpiarlo, media lista se llamaba
 * literalmente "<command-message>jarvis</command-message>" (visto en vivo
 * 2026-09-17), que es peor que no tener titulo.
 */
export function cleanPreview(raw: string): string {
  let text = raw;
  // Los bloques inyectados por el harness no los escribio la persona.
  text = text.replace(/<(system-reminder|local-command-stdout|command-stderr)>[\s\S]*?<\/\1>/g, " ");
  // Un comando de barra se muestra como el comando y sus argumentos.
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (name) {
    const cmd = name[1].trim();
    const rest = (args?.[1] ?? "").trim();
    // Un comando sin nombre util (envoltorio vacio) cae al resto del texto.
    if (cmd) return rest ? `${cmd} ${rest}` : cmd;
  }
  // Cualquier otra etiqueta se quita dejando su contenido.
  return text.replace(/<\/?[a-zA-Z][\w-]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Titulo de la conversacion: la primera linea util del preview (que es el
 * primer mensaje del usuario), limpiada y recortada. Sin preview cae al id
 * corto, nunca a una cadena vacia — una fila sin texto es imposible de buscar.
 */
export function titleFor(s: Pick<ClaudeSession, "id" | "preview">, maxChars = 72): string {
  const cleaned = cleanPreview(s.preview ?? "");
  const firstLine = cleaned
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return `Sesión ${s.id.slice(0, 8)}`;
  return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars).trimEnd()}…` : firstLine;
}

/**
 * Nombre corto del proyecto a partir del `project_label` (una ruta absoluta
 * recuperada del slug de Claude Code). Devuelve el ultimo segmento no vacio.
 */
export function projectNameFor(projectLabel: string): string {
  const parts = projectLabel.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || projectLabel;
}

/** Tiempo relativo compacto en español ("hace 5 min", "hace 3 d"). */
export function formatRel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return "—";
  const diff = Math.max(0, now.getTime() - ts.getTime());
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "ahora mismo";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `hace ${days} d`;
  const months = Math.floor(days / 30);
  return months < 12 ? `hace ${months} mes${months === 1 ? "" : "es"}` : `hace ${Math.floor(months / 12)} año(s)`;
}

/** Hora local corta de un turno ("14:05"). */
export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return "";
  return ts.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Etiqueta del modelo sin el prefijo del proveedor ("claude-opus-5" -> "opus-5"). */
export function shortModel(model: string | null): string {
  if (!model) return "";
  return model.replace(/^claude-/, "");
}
