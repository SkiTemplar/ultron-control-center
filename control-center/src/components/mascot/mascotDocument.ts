// Mascota — documento transparente desde el primer fotograma.
//
// El CSS global pinta html/body/#root con el fondo negro de la app. La
// ventana «mascot» cubre el área de trabajo entera, así que cualquier
// fotograma pintado antes de quitar ese fondo sale como un rectángulo negro
// del tamaño del monitor. La clase se pone de forma síncrona al cargar el
// módulo (antes de `createRoot`), no en un efecto de React, que corre
// después del primer pintado. Sin <style> en línea: rompería la CSP.

export const MASCOT_ROOT_CLASS = "mascot-root";
export const MASCOT_PATH = "/mascot";

/** Marca el documento como transparente si es la ventana de la mascota. */
export function prepareMascotDocument(pathname: string, doc: Document = document): boolean {
  if (pathname !== MASCOT_PATH) return false;
  doc.documentElement.classList.add(MASCOT_ROOT_CLASS);
  return true;
}
