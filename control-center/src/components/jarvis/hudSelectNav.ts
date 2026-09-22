// Navegación por teclado del desplegable del HUD. Parte pura, aparte del
// componente, porque es donde se esconden los off-by-one: el cursor se pasa
// del final o no da la vuelta, y eso hay que poder probarlo sin montar React.

/**
 * Índice al que salta el cursor con una tecla, o `null` si esa tecla no
 * mueve nada.
 *
 * Da la vuelta a propósito: en una lista de tres opciones, bajar desde la
 * última tiene que volver a la primera en vez de quedarse clavado.
 *
 * `saltable(i)` marca las opciones por las que el cursor NO debe pararse —
 * desde el 2026-09-22, las que la suscripción no permite: se siguen viendo
 * (una opción que desaparece parece un fallo del programa), pero el teclado
 * pasa de largo, porque pararse en algo que no se puede elegir da la
 * sensación de que el Enter no responde. Es el cuarto argumento y es
 * opcional para no tocar las llamadas que no tienen nada que saltar.
 *
 * Con TODAS saltables devuelve `null`: no hay ningún sitio al que ir, y
 * buscarlo sería un bucle infinito. De ahí la guarda de `total` pasos.
 */
export function siguienteIndice(
  tecla: string,
  actual: number,
  total: number,
  saltable?: (i: number) => boolean,
): number | null {
  if (total <= 0) return null;
  const crudo = destino(tecla, actual, total);
  if (crudo === null || !saltable) return crudo;
  // Se sigue buscando en el sentido de la tecla: con ArrowUp sobre una opción
  // vetada hay que seguir SUBIENDO, no bajar por donde se venía.
  const paso = tecla === "ArrowUp" || tecla === "PageUp" || tecla === "End" ? -1 : 1;
  let i = crudo;
  for (let dados = 0; dados < total; dados++) {
    if (!saltable(i)) return i;
    i = (i + paso + total) % total;
  }
  return null;
}

/** El salto a pelo, sin mirar si la opción de destino se puede elegir. */
function destino(tecla: string, actual: number, total: number): number | null {
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
