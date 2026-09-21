// Navegación por teclado de la tira de pestañas del panel lateral. Parte pura,
// aparte del componente, igual que `hudSelectNav.ts`: aquí es donde se esconden
// los off-by-one y hay que poder probarlos sin montar React.
//
// Por qué existe: `PanelLateral.tsx` declara `role="tablist"` con `role="tab"` y
// `aria-selected` en cada pestaña, pero no implementaba la navegación por
// flechas que ese rol promete — un lector de pantalla anunciaba un conjunto de
// pestañas que no se podía recorrer como tal (2026-09-22).

/**
 * Índice al que salta la pestaña activa con una tecla, o `null` si esa tecla
 * no mueve nada (y entonces el componente NO debe tragarse el evento: las
 * flechas arriba/abajo tienen que seguir haciendo scroll en el diff).
 *
 * Da la vuelta a propósito, como manda el patrón de tabs de la WAI: ir a la
 * derecha desde la última vuelve a la primera en vez de quedarse clavado.
 */
export function siguientePestana(
  tecla: string,
  actual: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  switch (tecla) {
    case "ArrowRight":
      return (actual + 1) % total;
    case "ArrowLeft":
      return (actual - 1 + total) % total;
    case "Home":
      return 0;
    case "End":
      return total - 1;
    default:
      return null;
  }
}
