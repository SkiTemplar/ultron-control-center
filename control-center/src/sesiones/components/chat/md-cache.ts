// Caché LRU a nivel de módulo para el render rico del chat: al virtualizar, una
// fila que sale de la vista se desmonta y al volver se rehace entera (Markdown,
// KaTeX, resaltado, diagramas). Con tope de entradas y de peso para que una
// sesión de días no la haga crecer sin límite.

export class LruCache<V> {
  private readonly map = new Map<string, { value: V; weight: number }>();
  private total = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly weigh: (key: string, value: V) => number = () => 1,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get weight(): number {
    return this.total;
  }

  /** El valor y lo marca como recién usado. */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Guarda y expulsa lo menos usado hasta caber; un valor más pesado que el tope no se guarda. */
  set(key: string, value: V): void {
    const weight = this.weigh(key, value);
    this.delete(key);
    if (weight > this.maxWeight) return;
    this.map.set(key, { value, weight });
    this.total += weight;
    while (this.map.size > this.maxEntries || this.total > this.maxWeight) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.total -= entry.weight;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}
