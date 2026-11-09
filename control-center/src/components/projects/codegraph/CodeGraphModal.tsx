// Visor CodeGraph (pilar 3 del GOAL: «ver el grafo, no lanzar sesiones»).
//
// Se abre desde la tarjeta CodeGraph de ProjectWorkspace en un proyecto
// indexado. Tres columnas: búsqueda y ficheros/módulos a la izquierda, el
// grafo en el centro (clic en un nodo = seleccionarlo y expandir su
// vecindario) y el detalle del nodo con fichero:línea a la derecha.
// Backend: codegraph_files / codegraph_search / codegraph_neighborhood
// (commands/projects/git_ops/codegraph/view.rs), todo de solo lectura.

import { useEffect, useState, type FormEvent } from "react";
import { CodeGraphCanvas } from "./CodeGraphCanvas";
import { CodeGraphSidebar } from "./CodeGraphSidebar";
import { useCodeGraphViewer } from "./useCodeGraphViewer";
import { locationOf, MAX_VIEW_NODES, type CgNode } from "../../../lib/codegraph";

type Props = {
  path: string;
  projectName: string;
  onClose: () => void;
};

const DEPTHS = [1, 2, 3];

export function CodeGraphModal({ path, projectName, onClose }: Props) {
  const viewer = useCodeGraphViewer(path);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const edgesOf = (id: string | undefined) =>
    id ? viewer.view.edges.filter((e) => e.source === id || e.target === id).length : 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void viewer.search(query);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-full w-full max-w-7xl flex-col rounded"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`CodeGraph de ${projectName}`}
      >
        <header
          className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold">CodeGraph</h2>
            <p className="truncate text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              {projectName}
              {viewer.files && ` · ${viewer.files.total_files} ficheros indexados`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              Profundidad
            </span>
            <div className="flex gap-1" role="group" aria-label="Profundidad del vecindario">
              {DEPTHS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => viewer.setDepth(d)}
                  aria-pressed={viewer.depth === d}
                  className="rounded px-2 py-1 text-[11.5px]"
                  style={{
                    background: viewer.depth === d ? "var(--color-accent)" : "var(--color-surface-3)",
                    color: viewer.depth === d ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded px-2 py-1 text-[12px]"
              style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }}
            >
              Cerrar
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "280px 1fr 280px" }}>
          <aside className="flex min-h-0 flex-col border-r" style={{ borderColor: "var(--color-border)" }}>
            <form onSubmit={submit} className="flex shrink-0 gap-1 p-3" role="search">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar símbolo (route, ProjectWorkspace…)"
                aria-label="Buscar símbolo"
                className="min-w-0 flex-1 rounded px-2 py-1 text-[12px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                }}
              />
              <button
                type="submit"
                className="rounded px-2 py-1 text-[12px]"
                style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
              >
                Buscar
              </button>
            </form>
            <CodeGraphSidebar viewer={viewer} />
          </aside>

          <section className="relative min-h-0 min-w-0 overflow-hidden" aria-label="Grafo">
            {viewer.error && (
              <p
                className="border-b px-4 py-2 text-[12px]"
                style={{ borderColor: "var(--color-border)", color: "var(--color-danger, #ef4444)" }}
                role="alert"
              >
                {viewer.error}
              </p>
            )}
            {viewer.busy && (
              <p className="absolute right-3 top-2 text-[11px]" style={{ color: "var(--color-text-tertiary)" }} role="status">
                Cargando vecindario…
              </p>
            )}
            {viewer.view.truncated && (
              <p className="px-4 py-1 text-[11px]" style={{ color: "#ca8a04" }}>
                Grafo recortado: algún tope dejó nodos fuera (máximo {MAX_VIEW_NODES} en el visor).
              </p>
            )}
            <CodeGraphCanvas
              view={viewer.view}
              selectedId={viewer.selected?.id ?? null}
              onNodeClick={(node) => void viewer.expand(node)}
            />
          </section>

          <aside className="min-h-0 overflow-auto border-l p-4" style={{ borderColor: "var(--color-border)" }}>
            <NodeDetail node={viewer.selected} edges={edgesOf(viewer.selected?.id)} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function NodeDetail({ node, edges }: { node: CgNode | null; edges: number }) {
  if (!node) {
    return (
      <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
        Selecciona un nodo para ver su detalle.
      </p>
    );
  }
  return (
    <dl className="space-y-2 text-[12px]" aria-label="Detalle del nodo">
      <div>
        <dt style={{ color: "var(--color-text-tertiary)" }}>Nombre</dt>
        <dd className="font-semibold">{node.name}</dd>
      </div>
      <div>
        <dt style={{ color: "var(--color-text-tertiary)" }}>Tipo</dt>
        <dd>{node.kind} · {node.language}</dd>
      </div>
      <div>
        <dt style={{ color: "var(--color-text-tertiary)" }}>Ubicación</dt>
        <dd className="break-all" style={{ fontFamily: "var(--font-mono)" }} data-testid="codegraph-location">
          {locationOf(node)}
        </dd>
      </div>
      {node.qualified_name !== node.name && (
        <div>
          <dt style={{ color: "var(--color-text-tertiary)" }}>Nombre cualificado</dt>
          <dd className="break-all" style={{ fontFamily: "var(--font-mono)" }}>{node.qualified_name}</dd>
        </div>
      )}
      {node.signature && (
        <div>
          <dt style={{ color: "var(--color-text-tertiary)" }}>Firma</dt>
          <dd className="break-all" style={{ fontFamily: "var(--font-mono)" }}>{node.signature}</dd>
        </div>
      )}
      <div>
        <dt style={{ color: "var(--color-text-tertiary)" }}>Aristas visibles</dt>
        <dd>{edges}</dd>
      </div>
    </dl>
  );
}
