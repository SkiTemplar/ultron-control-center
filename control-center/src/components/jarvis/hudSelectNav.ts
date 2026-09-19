// Navegación por teclado del desplegable del HUD. Parte pura, aparte del
// componente, porque es donde se esconden los off-by-one: el cursor se pasa
// del final o no da la vuelta, y eso hay que poder probarlo sin montar React.

/**
 * Índice al que salta el cursor con una tecla, o `null` si esa tecla no
 * mueve nada.
 *
 * Da la vuelta a propósito: en una lista de tres opciones, bajar desde la
 * última tiene que volver a la primera en vez de quedarse clavado.
 */
export function siguienteIndice(tecla: string, actual: number, total: number): number | null {
  if (total <= 0) return null;
  switch (tecla) {
    case "ArrowDown":
      return (actual + 1) % total;
    case "ArrowUp":
      return (actual - 1 + total) % total;
    case "Home":
      return 0;
    case "End":
      return total - 1;
    case "PageDown":
      return Math.min(total - 1, actual + 5);
    case "PageUp":
      return Math.max(0, actual - 5);
    default:
      return null;
  }
}
