// mar.ia — lista lateral de conversaciones del chat.
//
// Igual que en Claude Desktop: fijadas arriba, luego las carpetas y al final
// el resto agrupado por fecha, con un mini titulo por fila. El agrupado por
// fecha reutiliza `bucketFor` del navegador de conversaciones para que "Hoy"
// signifique lo mismo en las dos pantallas.

import { bucketFor } from "../conversations/utils";
import type { DateBucket } from "../conversations/types";

export type ThreadMeta = {
  /** Proveedor pegado a esta conversacion. Vacio = decide el relevo. */
  provider?: string;
  /** Carpeta del proyecto sobre el que trabaja. Vacio = ninguno. */
  project?: string;
  id: string;
  title: string;
  folder: string;
  created: string;
  updated: string;
  pinned: boolean;
  closed: boolean;
  turns: number;
};

/** Orden en el que se pintan los cubos de fecha. */
const ORDEN_FECHA: DateBucket[] = [
  "Hoy",
  "Ayer",
  "Últimos 7 días",
  "Últimos 30 días",
  "Más antiguo",
  "Sin fecha",
];

/** Grupo pintable: un titulo y sus conversaciones. */
export type Grupo = { titulo: string; hilos: ThreadMeta[] };

/**
 * Agrupa para la barra lateral. Pura: se testea sin React.
 *
 * Prioridad: fijadas > carpeta > fecha. Una conversacion aparece en UN solo
 * grupo — verla dos veces haria imposible saber cuantas hay.
 */
export function agrupar(hilos: ThreadMeta[], now: Date = new Date()): Grupo[] {
  const grupos: Grupo[] = [];
  const fijadas = hilos.filter((h) => h.pinned);
  if (fijadas.length > 0) grupos.push({ titulo: "fijadas", hilos: fijadas });

  const resto = hilos.filter((h) => !h.pinned);
  const carpetas = new Map<string, ThreadMeta[]>();
  const sueltas: ThreadMeta[] = [];
  for (const h of resto) {
    const carpeta = h.folder.trim();
    if (!carpeta) {
      sueltas.push(h);
      continue;
    }
    const lista = carpetas.get(carpeta) ?? [];
    lista.push(h);
    carpetas.set(carpeta, lista);
  }
  // Los grupos de carpeta y los de fecha compiten por el mismo sitio, asi que
  // se ordenan TODOS por su conversacion mas reciente. Antes las carpetas iban
  // siempre delante y una conversacion recien creada (que no tiene carpeta)
  // aparecia debajo de todas ellas — el usuario lo reporto el 2026-09-21:
  // "cuando se crea una nueva conversacion aparece abajo cuando deberia
  // aparecer arriba".
  //
  // Las fijadas se quedan las primeras: eso lo ha decidido el usuario a mano y
  // manda sobre la recencia.
  const compiten: Grupo[] = [];

  for (const nombre of carpetas.keys()) {
    compiten.push({ titulo: `📁 ${nombre}`, hilos: carpetas.get(nombre) ?? [] });
  }

  const porFecha = new Map<DateBucket, ThreadMeta[]>();
  for (const h of sueltas) {
    const cubo = bucketFor(h.updated, now);
    const lista = porFecha.get(cubo) ?? [];
    lista.push(h);
    porFecha.set(cubo, lista);
  }
  for (const cubo of ORDEN_FECHA) {
    const lista = porFecha.get(cubo);
    if (lista && lista.length > 0) compiten.push({ titulo: cubo.toLowerCase(), hilos: lista });
  }

  compiten.sort((a, b) => masReciente(b).localeCompare(masReciente(a)));
  grupos.push(...compiten);
  return grupos;
}

/** Fecha de la conversacion mas reciente del grupo. Cadena vacia si no hay. */
function masReciente(g: Grupo): string {
  let max = "";
  for (const h of g.hilos) {
    if (h.updated > max) max = h.updated;
  }
  return max;
}

/** Filtra por texto del titulo o de la carpeta. Pura. */
export function filtrar(hilos: ThreadMeta[], consulta: string): ThreadMeta[] {
  const q = consulta.trim().toLowerCase();
  if (!q) return hilos;
  return hilos.filter(
    (h) => h.title.toLowerCase().includes(q) || h.folder.toLowerCase().includes(q),
  );
}

type Props = {
  threads: ThreadMeta[];
  activeId: string;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onPin: (id: string, pinned: boolean) => void;
};

export function ThreadSidebar({
  threads,
  activeId,
  query,
  onQuery,
  onSelect,
  onNew,
  onPin,
}: Props) {
  const grupos = agrupar(filtrar(threads, query));

  return (
    <aside
      className="flex w-[228px] shrink-0 flex-col gap-2 overflow-hidden"
      style={{ borderRight: "1px solid var(--color-border)" }}
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <button
          type="button"
          onClick={onNew}
          className="hud-panel hud-label flex-1 px-2 py-1.5 text-left"
          style={{ color: "var(--color-accent)", cursor: "pointer" }}
        >
          + conversación
        </button>
      </div>
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="buscar…"
        aria-label="buscar conversación"
        className="hud-panel mx-3 px-2 py-1 text-[11px]"
        style={{
          color: "var(--color-text)",
          fontFamily: "var(--font-mono)",
          outline: "none",
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3">
        {grupos.length === 0 && (
          <p className="hud-label px-1 py-3">sin conversaciones todavía</p>
        )}
        {grupos.map((g) => (
          <section key={g.titulo} className="mb-2">
            <h3 className="hud-label px-1 py-1">{g.titulo}</h3>
            {g.hilos.map((h) => {
              const activo = h.id === activeId;
              return (
                <div
                  key={h.id}
                  className="group flex items-center gap-1 px-1"
                  style={{
                    background: activo ? "var(--color-surface-3)" : "transparent",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(h.id)}
                    title={`${h.title} · ${h.turns} turnos`}
                    className="min-w-0 flex-1 truncate py-1 text-left text-[11px]"
                    style={{
                      color: activo ? "var(--color-accent)" : "var(--color-text-secondary)",
                      cursor: "pointer",
                      background: "none",
                      border: "none",
                    }}
                  >
                    {h.closed ? "· " : ""}
                    {h.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => onPin(h.id, !h.pinned)}
                    aria-label={h.pinned ? "soltar conversación" : "fijar conversación"}
                    title={h.pinned ? "soltar" : "fijar"}
                    className="shrink-0 px-1 text-[10px]"
                    style={{
                      color: h.pinned ? "var(--color-accent)" : "var(--color-text-tertiary)",
                      cursor: "pointer",
                      background: "none",
                      border: "none",
                    }}
                  >
                    {h.pinned ? "★" : "☆"}
                  </button>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
