// Error message helper shared by components that surface invoke() failures.

/** Message of an Error, the string itself, or a generic fallback. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Error inesperado";
}
