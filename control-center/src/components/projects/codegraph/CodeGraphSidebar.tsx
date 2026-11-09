// Columna izquierda del visor CodeGraph: resultados de búsqueda o, sin
// búsqueda, la lista de ficheros y módulos con su conteo de símbolos. Elegir
// un resultado o un fichero abre su vecindario en el grafo.

import { useMemo, useState } from "react";
import { locationOf, type CgFile, type CgNode } from "../../../lib/codegraph";
import type { Viewer } from "./useCodeGraphViewer";

type Tab = "files" | "modules";

/** Ficheros visibles: los del módulo elegido (o todos), ya ordenados por ruta. */
function filesIn(files: CgFile[], module: string | null): CgFile[] {
  if (module === null) return files;
  if (module === ".") return files.filter((f) => !f.path.includes("/"));
  return files.filter((f) => f.path.startsWith(`${module}/`));
}

const rowClass = "flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left text-[11.5px]";

export function CodeGraphSidebar({ viewer }: { viewer: Viewer }) {
  const [tab, setTab] = useState<Tab>("files");
  const [module, setModule] = useState<string | null>(null);
  const visibleFiles = useMemo(
    () => filesIn(viewer.files?.files ?? [], module),
    [viewer.files, module],
  );

  if (viewer.results) {
    return <SearchResults results={viewer.results} onOpen={(n) => void viewer.open(n.id)} />;
  }
  if (viewer.filesError) {
    return (
      <p className="px-3 text-[12px]" style={{ color: "var(--color-danger, #ef4444)" }} role="alert">
        {viewer.filesError}
      </p>
    );
  }
  if (!viewer.files) {
    return (
      <p className="px-3 text-[12px]" style={{ color: "var(--color-text-tertiary)" }} role="status">
        Leyendo el índice…
      </p>
    );
  }

  const pickModule = (path: string) => {
    setModule(path);
    setTab("files");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 px-3 pb-2" role="tablist">
        {(["files", "modules"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className="rounded px-2 py-1 text-[11.5px]"
            style={{
              background: tab === t ? "var(--color-surface-3)" : "transparent",
              color: "var(--color-text-secondary)",
            }}
          >
            {t === "files" ? "Ficheros" : "Módulos"}
          </button>
        ))}
      </div>
      {viewer.files.truncated && (
        <p className="px-3 pb-1 text-[11px]" style={{ color: "#ca8a04" }}>
          Lista recortada: el índice tiene {viewer.files.total_files} ficheros.
        </p>
      )}
      {tab === "files" && module !== null && (
        <button type="button" onClick={() => setModule(null)} className="mx-3 mb-1 text-left text-[11px] underline" style={{ color: "var(--color-text-tertiary)" }}>
          {module} · ver todos
        </button>
      )}
      <ul className="min-h-0 flex-1 overflow-auto px-1 pb-3">
        {tab === "files"
          ? visibleFiles.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={rowClass}
                  disabled={!f.node_id}
                  onClick={() => f.node_id && void viewer.open(f.node_id)}
                  title={f.node_id ? `Ver el vecindario de ${f.path}` : "Fichero sin nodo en el índice"}
                >
                  <span className="truncate" style={{ fontFamily: "var(--font-mono)" }}>{f.path}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>{f.symbols}</span>
                </button>
              </li>
            ))
          : viewer.files.modules.map((m) => (
              <li key={m.path}>
                <button type="button" className={rowClass} onClick={() => pickModule(m.path)}>
                  <span className="truncate" style={{ fontFamily: "var(--font-mono)" }}>{m.path}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>
                    {m.files} f · {m.symbols} s
                  </span>
                </button>
              </li>
            ))}
      </ul>
    </div>
  );
}

function SearchResults({ results, onOpen }: { results: CgNode[]; onOpen: (n: CgNode) => void }) {
  if (results.length === 0) {
    return (
      <p className="px-3 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
        Ningún símbolo coincide. Vacía la búsqueda para volver a los ficheros.
      </p>
    );
  }
  return (
    <ul className="min-h-0 flex-1 overflow-auto px-1 pb-3" aria-label="Resultados de la búsqueda">
      {results.map((n) => (
        <li key={n.id}>
          <button type="button" className={`${rowClass} flex-col`} onClick={() => onOpen(n)}>
            <span className="font-semibold">
              {n.name} <span style={{ color: "var(--color-text-tertiary)" }}>{n.kind}</span>
            </span>
            <span className="truncate" style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>
              {locationOf(n)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
