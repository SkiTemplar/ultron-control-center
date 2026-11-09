// Adjuntos de la sesión en dos secciones: Entrada (imágenes y ficheros que
// aporta el usuario) y Salida (todo fichero que escribe o cita Claude). Cada
// ruta se comprueba en disco (`sesiones_paths_status`): las citadas en el
// texto solo se enseñan si existen; las escritas o aportadas, siempre, como
// ausentes si ya no están. Se vuelve a comprobar al recuperar el foco (un
// render que termina después) y con «Comprobar».

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../../context";
import { useSession } from "../../store";
import type { PathStatus } from "../../types";
import "../../styles/adjuntos.css";
import { AdjuntoFila } from "./AdjuntoFila";
import { collectAttachments, type AttachmentItem } from "./adjuntos-collect";
import { NoSession } from "./Inspector";

/** Tope de `sesiones_paths_status`. */
const MAX_PATHS = 500;

interface StatusState {
  byPath: Map<string, PathStatus>;
  isChecking: boolean;
  error: string | null;
}

const emptyStatus = (): StatusState => ({ byPath: new Map(), isChecking: false, error: null });

const isEmptyStatus = (s: StatusState): boolean => s.byPath.size === 0 && !s.isChecking && s.error === null;

/** Estado en disco de `paths`; solo cuenta la respuesta de la última consulta. */
function usePathStatus(paths: readonly string[]): StatusState & { refresh: () => void } {
  const api = useApi();
  const [state, setState] = useState<StatusState>(emptyStatus);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const joined = paths.join("\n");
  useEffect(() => {
    const list = joined ? joined.split("\n") : [];
    // Sin rutas no queda nada que comprobar: fuera el estado de la lista
    // anterior (filas, error y un «Comprobando» de una consulta descartada).
    if (list.length === 0) {
      setState((s) => (isEmptyStatus(s) ? s : emptyStatus()));
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, isChecking: true }));
    api.pathsStatus(list).then(
      (rows) => alive && setState({ byPath: new Map(rows.map((r) => [r.path, r])), isChecking: false, error: null }),
      (e: unknown) => alive && setState((s) => ({ ...s, isChecking: false, error: e instanceof Error ? e.message : String(e) })),
    );
    return () => {
      alive = false;
    };
  }, [api, joined, tick]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  return { ...state, refresh };
}

/** Lo que se enseña: lo especulativo solo si existe y es un fichero. */
function visible(items: readonly AttachmentItem[], byPath: Map<string, PathStatus>): AttachmentItem[] {
  return items.filter((it) => {
    if (!it.isSpeculative || !it.path) return true;
    const st = byPath.get(it.path);
    return !!st && st.exists && st.isFile;
  });
}

interface SectionProps {
  title: string;
  items: AttachmentItem[];
  status: StatusState;
  cwd: string | undefined;
  testId: string;
  empty: string;
}

function Section({ title, items, status, cwd, testId, empty }: SectionProps) {
  return (
    <div data-testid={testId}>
      <div className="sect">{title} · {items.length}</div>
      {items.length === 0 ? (
        <p className="note">{empty}</p>
      ) : (
        <div className="adj-list">
          {items.map((it) => <AdjuntoFila key={it.key} it={it} st={it.path ? status.byPath.get(it.path) : undefined} isChecking={status.isChecking} cwd={cwd} />)}
        </div>
      )}
    </div>
  );
}

export function Adjuntos({ sessionId, cwd }: { sessionId: string | null; cwd?: string }) {
  const state = useSession(sessionId);
  const { input, output } = useMemo(() => collectAttachments(state.messages, state.attachments, cwd), [state.messages, state.attachments, cwd]);
  const paths = useMemo(() => {
    const all = [...input, ...output].flatMap((it) => (it.path ? [it.path] : []));
    return [...new Set(all)].slice(0, MAX_PATHS);
  }, [input, output]);
  const status = usePathStatus(paths);
  if (!sessionId) return <NoSession />;
  return (
    <>
      <div className="adj-head">
        {status.error ? <span className="err-text">No se pudo comprobar qué ficheros existen: {status.error}</span> : <span className="adj-hint">{status.isChecking ? "Comprobando ficheros…" : "Rutas resueltas contra el directorio de la sesión."}</span>}
        <button className="btn sm ghost" disabled={status.isChecking || paths.length === 0} onClick={status.refresh} title="Volver a comprobar qué ficheros existen en disco">Comprobar</button>
      </div>
      <Section title="Entrada" items={input} status={status} cwd={cwd} testId="adjuntos-entrada"
        empty="Aquí aparecen las imágenes que pegas y los ficheros que citas con @." />
      <Section title="Salida" items={visible(output, status.byPath)} status={status} cwd={cwd} testId="adjuntos-salida"
        empty="Aquí aparecen los ficheros que Claude escribe o cita en sus respuestas y existen en disco." />
    </>
  );
}
