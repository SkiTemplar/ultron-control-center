// Cierre de menús emergentes con Escape y con clic fuera.
//
// Los menús «···» de ProjectRow y el desplegable de Actualizar de Proyectos solo
// se cerraban al sacar el ratón del contenedor: con teclado o con un clic en
// otra parte de la página se quedaban abiertos encima del contenido.

import { useEffect, useRef, type RefObject } from "react";

/**
 * Mientras `open` sea true, llama a `onClose` al pulsar Escape o al hacer
 * pointerdown fuera de `ref`. Escape devuelve el foco al disparador (el
 * elemento con `aria-haspopup`, o el primer botón) para no dejar el foco en
 * un elemento que desaparece.
 */
export function useDismissable(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  // El callback suele ser una flecha nueva en cada render: se guarda en un ref
  // para no volver a suscribir los oyentes en cada pintado.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const root = ref.current;
      if (root && e.target instanceof Node && root.contains(e.target)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
      const root = ref.current;
      (root?.querySelector<HTMLElement>("[aria-haspopup]") ?? root?.querySelector<HTMLElement>("button"))?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [ref, open]);
}
