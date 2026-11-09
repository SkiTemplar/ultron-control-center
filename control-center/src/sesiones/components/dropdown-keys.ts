// Navegación por teclado del Dropdown, pura para poder probarla sin DOM.

interface Navigable {
  label: string;
  disabled?: boolean;
}

/** Siguiente opción habilitada desde `from` en la dirección `dir`, con vuelta. -1 si no hay ninguna. */
export function nextEnabled(options: readonly Navigable[], from: number, dir: 1 | -1): number {
  const n = options.length;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step += 1) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!options[i].disabled) return i;
  }
  return -1;
}

/** Primera opción habilitada, a partir de la activa, cuya etiqueta empieza por `ch`. */
export function typeahead(options: readonly Navigable[], from: number, ch: string): number {
  const c = ch.toLocaleLowerCase("es");
  const n = options.length;
  for (let step = 1; step <= n; step += 1) {
    const i = (from + step + n) % n;
    const o = options[i];
    if (!o.disabled && o.label.toLocaleLowerCase("es").startsWith(c)) return i;
  }
  return -1;
}
