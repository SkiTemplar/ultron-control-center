// Bitácora del proyecto (E10): `cockpit/projects/<id>/estado.json` vía
// `sesiones_bitacora`. Solo lectura.

import { useApi } from "../../context";
import { useLoad, useReloadOnTurnEnd } from "../../hooks/useLoad";
import { formatAgo } from "../../parse";
import type { Bitacora as BitacoraData, SessionInfo } from "../../types";
import { IconRefresh } from "../icons";
import { NoSession } from "./Inspector";

function List({ title, items, tone }: { title: string; items: string[]; tone?: string }) {
  return (
    <>
      <div className="sect">{title} · {items.length}</div>
      {items.length === 0 ? <p className="note">Nada anotado.</p> : (
        <ul className={`blist${tone ? ` ${tone}` : ""}`}>
          {items.map((it, i) => <li key={i}>{it}</li>)}
        </ul>
      )}
    </>
  );
}

export function Bitacora({ session }: { session: SessionInfo | null }) {
  const api = useApi();
  const projectId = session?.projectId ?? null;
  const res = useLoad<BitacoraData>(projectId ? () => api.bitacora(projectId) : null, projectId ?? "");
  useReloadOnTurnEnd(session?.status, res.reload);
  if (!session) return <NoSession />;
  if (!projectId) return <p className="note">Sin proyecto registrado.</p>;
  const b = res.data;
  return (
    <>
      <div className="sect">
        Bitácora · {session.projectName}
        <button className="act" onClick={res.reload} disabled={res.loading}><IconRefresh /> Recargar</button>
      </div>
      {res.error && <p className="err-text" role="alert">No se pudo leer la bitácora: {res.error}</p>}
      {!b && res.loading && <p className="loading">Leyendo estado.json…</p>}
      {b && (
        <>
          <p className="bres">{b.resumen || "Sin resumen todavía."}</p>
          <p className="faint small">{b.updatedAt ? `Actualizada ${formatAgo(b.updatedAt)}` : "Sin fecha de actualización"}</p>
          <List title="Pendientes" items={b.pendientes} tone="todo" />
          <List title="Decisiones" items={b.decisiones} />
          <List title="Gotchas" items={b.gotchas} tone="warn" />
        </>
      )}
    </>
  );
}
