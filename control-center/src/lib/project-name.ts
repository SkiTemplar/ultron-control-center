// Validacion de nombre de proyecto/carpeta para el asistente "Nuevo
// proyecto" (NewProjectWizard.tsx). Espeja las reglas que el backend del
// CLI `project-create.mjs` aplica (error INVALID_NAME): caracteres
// prohibidos en NTFS/Windows + nombres reservados del sistema. Vive en
// lib/ para validar en vivo sin ida y vuelta al proceso Node.

// Caracteres invalidos en NTFS/Windows + caracteres de control (0x00-0x1F).
const FORBIDDEN_CHARS = /[\x00-\x1f<>:"/\\|?*]/;

// CON/PRN/AUX/NUL y COM1-9/LPT1-9 son invalidos como nombre de archivo o
// carpeta en Windows, con o sin extension (p.ej. "con.txt" tambien falla).
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

// Metacaracteres de cmd.exe: el nombre llega como argumento a generadores
// externos (defensa frente a CVE-2024-27980), igual que en el backend.
const SHELL_META_CHARS = /[&%^!`]/;

const MAX_LENGTH = 80;

/**
 * Valida un nombre de proyecto/carpeta/asignatura.
 * Devuelve `null` cuando es valido, o un mensaje de error listo para
 * mostrar en la UI.
 */
export function validateProjectName(rawName: string): string | null {
  const name = rawName.trim();
  if (!name) return "El nombre no puede estar vacio.";
  if (FORBIDDEN_CHARS.test(name)) {
    return 'Caracteres no permitidos: < > : " / \\ | ? *';
  }
  if (SHELL_META_CHARS.test(name)) {
    return "Caracteres no permitidos: & % ^ ! `";
  }
  if (name.startsWith("-")) {
    return "El nombre no puede empezar por guion.";
  }
  // El espacio final ya lo elimina el trim() de arriba; el punto final
  // sobrevive (no es whitespace) y Windows lo rechaza como nombre de carpeta.
  if (name.endsWith(".")) {
    return "Windows no admite nombres terminados en punto.";
  }
  const bareName = (name.split(".")[0] ?? name).toUpperCase();
  if (RESERVED_NAMES.has(bareName)) {
    return `"${bareName}" es un nombre reservado del sistema operativo.`;
  }
  if (name.length > MAX_LENGTH) {
    return `Nombre demasiado largo (maximo ${MAX_LENGTH} caracteres).`;
  }
  return null;
}

/** `true` cuando `validateProjectName` no encuentra ningun problema. */
export function isValidProjectName(rawName: string): boolean {
  return validateProjectName(rawName) === null;
}
