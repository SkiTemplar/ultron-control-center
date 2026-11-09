// Cadencia del sondeo de uso del plan (auditoría de estabilidad nocturna, H3).
// Cada vuelta pide `usage` (que sin muestra local reciente va al endpoint
// OAuth) y `usagePace` (que lanza `node`): con la ventana oculta no se sondea,
// en reposo (ninguna sesión en working) cada 10 min y a 60 s solo con turnos
// activos. Al volver a estar visible, una actualización inmediata, salvo que la
// última sea de hace menos de `PLAN_MIN_MS` (alternar ventanas no la repite).

/** Con algún turno en marcha: hay muestra local de la línea de estado y no se llama al endpoint. */
export const PLAN_ACTIVE_MS = 60_000;
/** En reposo. */
export const PLAN_IDLE_MS = 600_000;
/** Separación mínima entre dos actualizaciones aunque la ventana se oculte y vuelva. */
export const PLAN_MIN_MS = 20_000;

/** Intervalo que toca; `null` = en pausa (ventana oculta). */
export function planInterval(hidden: boolean, working: boolean): number | null {
  if (hidden) return null;
  return working ? PLAN_ACTIVE_MS : PLAN_IDLE_MS;
}

export interface PlanPollDeps {
  /** Lanza una actualización (`refreshPlan`); los errores los muestra el propio panel. */
  refresh: () => void;
  /** ¿Hay alguna sesión en working? */
  isWorking: () => boolean;
  /** Avisa de cambios del store (se recalcula `isWorking`). */
  subscribe: (listener: () => void) => () => void;
  doc?: Document;
  now?: () => number;
}

/** Arranca el sondeo (con una actualización inmediata) y devuelve la función que lo para. */
export function startPlanPolling(deps: PlanPollDeps): () => void {
  const doc = deps.doc ?? document;
  const now = deps.now ?? Date.now;
  let timer: number | null = null;
  let lastAt = 0;
  let working = deps.isWorking();

  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const run = () => {
    lastAt = now();
    deps.refresh();
    schedule();
  };
  /** Programa la siguiente vuelta contando desde la última actualización. */
  function schedule(): void {
    clear();
    const every = planInterval(doc.visibilityState === "hidden", working);
    if (every === null) return;
    timer = window.setTimeout(run, Math.max(0, lastAt + every - now()));
  }
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") clear();
    else if (lastAt === 0 || now() - lastAt >= PLAN_MIN_MS) run();
    // Recién actualizado: la vuelta siguiente se cuenta desde esa actualización.
    else schedule();
  };
  const onStore = () => {
    const next = deps.isWorking();
    if (next === working) return;
    working = next;
    if (timer !== null) schedule();
  };

  doc.addEventListener("visibilitychange", onVisibility);
  const unsubscribe = deps.subscribe(onStore);
  // Arrancar oculta no sondea: la primera actualización llega al hacerse visible.
  if (doc.visibilityState !== "hidden") run();
  return () => {
    clear();
    unsubscribe();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
