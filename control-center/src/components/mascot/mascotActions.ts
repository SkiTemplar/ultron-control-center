// Mascota — acciones que llaman al backend y cuyo fallo tiene que verse.
//
// Un clic en «Permitir» tras el plazo, un «Ocultar» o «Ajustes» que no
// responden… antes se tragaban con `.catch(() => {})` y parecía que habían
// funcionado. `runAction` devuelve el texto del error para el bocadillo de
// avisos (useDeskAlerts.showError) o `null` si fue bien.

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Texto corto del fallo: qué no se hizo y por qué. */
export function actionErrorText(what: string, e: unknown): string {
  const why = e instanceof Error ? e.message : String(e ?? "error desconocido");
  return `${what}: ${why.trim() || "error desconocido"}`;
}

/** Ejecuta un comando; `null` si fue bien, el texto del error si falló. */
export async function runAction(
  invokeFn: InvokeFn,
  cmd: string,
  args: Record<string, unknown> | undefined,
  what: string,
): Promise<string | null> {
  try {
    await invokeFn(cmd, args);
    return null;
  } catch (e) {
    return actionErrorText(what, e);
  }
}

/** Copia al portapapeles; `null` si fue bien, el texto del error si no. */
export async function copyText(
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  text: string,
): Promise<string | null> {
  try {
    if (!clipboard) throw new Error("sin acceso al portapapeles");
    await clipboard.writeText(text);
    return null;
  } catch (e) {
    return actionErrorText("No se pudo copiar", e);
  }
}

/** Qué decir si la respuesta a una confirmación no llega al backend. */
export function approvalFailureWhat(allow: boolean): string {
  return allow
    ? "Tu «Permitir» no llegó a tiempo y la acción NO se ha ejecutado"
    : "Tu «Denegar» no llegó, pero la acción no se ejecuta";
}
