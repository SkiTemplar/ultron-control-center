// P5 — Modal de confirmación de instalación. Selector de ámbito
// (global/proyecto), renombrado y bandera de sobrescritura.
//
// 2026-09-22 — gana un SEGUNDO modo en vez de nacer un modal paralelo: el
// modal ya existía y funcionaba desde Agents; lo que faltaba era el camino
// desde Destacados. Los dos modos comparten el marco, el selector de ámbito,
// la lista de proyectos y el manejo de error/ocupado:
//
//   * modo "fichero" (`item` + `kind`): trae UN fichero suelto por
//     `library_install_from_github`. Es el que usa Agents.
//   * modo "repo" (`detalle`): trae el manifiesto completo de un repositorio
//     por `repos_aplicar`, con lo que el repo trae, los avisos de la puerta de
//     seguridad y la lista exacta de ficheros que se escribirían.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AvisoRepo,
  DetalleRepo,
  LibraryKind,
  Manifiesto,
  PlanAplicar,
  RemoteItem,
  ResultadoAplicar,
  TargetScope,
  TipoRepo,
} from "../../types";
import { libraryInstallFromGitHub, reposAplicar } from "../../lib/library-client";
import { AlertTriangle, Check, Download, X } from "./icons";

type ProjectLite = { id: string; name: string };

type PropsComunes = {
  defaultScope?: TargetScope;
  defaultProjectId?: string;
  onClose: () => void;
  /** Recibe una frase con lo que pasó (ruta escrita o resumen de la acción). */
  onInstalled: (resumen: string) => void;
};

type PropsFichero = PropsComunes & {
  item: RemoteItem;
  kind: LibraryKind;
  detalle?: undefined;
};

type PropsRepo = PropsComunes & {
  detalle: DetalleRepo;
  item?: undefined;
  kind?: undefined;
};

type Props = PropsFichero | PropsRepo;

// Backend ProjectInfo is richer; we only need {id, name} here.
type RawProject = { id: string; name: string };

const ETIQUETA_TIPO: Record<TipoRepo, string> = {
  marketplace: "marketplace de plugins",
  skill: "skill",
  agente: "agente",
  mcp: "servidor MCP",
  hook: "hooks",
  proyecto: "proyecto",
};

/** Sólo skill y agente escriben ficheros; el resto sigue su vía oficial. */
function escribeFicheros(tipo: TipoRepo): boolean {
  return tipo === "skill" || tipo === "agente";
}

function ListaAvisos({ avisos }: { avisos: AvisoRepo[] }) {
  if (avisos.length === 0) return null;
  return (
    <ul className="space-y-1">
      {avisos.map((a, i) => (
        <li
          key={`${a.regla}-${i}`}
          className="flex items-start gap-1.5 rounded border p-1.5 text-[11px]"
          style={{
            borderColor:
              a.severidad === "bloquea"
                ? "rgba(248, 81, 73, 0.30)"
                : "var(--color-border)",
            background:
              a.severidad === "bloquea"
                ? "rgba(248, 81, 73, 0.06)"
                : "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
        >
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-tertiary)",
              }}
            >
              {a.regla}
            </span>{" "}
            — {a.detalle}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function InstallConfirmModal(props: Props) {
  const {
    defaultScope = "global",
    defaultProjectId,
    onClose,
    onInstalled,
  } = props;
  const detalle = props.detalle;
  const modoRepo = detalle !== undefined;

  // Un repo puede ser varias cosas a la vez (anthropics/skills es marketplace
  // Y trae skills). La acción por defecto es la que deja algo instalable; si
  // hay varias, el usuario elige en vez de que se decida por él.
  const manifiestos: Manifiesto[] = detalle?.manifiestos ?? [];
  const [accion, setAccion] = useState<TipoRepo>(
    manifiestos[0]?.tipo ?? detalle?.tipos[0] ?? "skill",
  );
  const [asset, setAsset] = useState<string>(manifiestos[0]?.asset ?? "");
  const manifiestosDelTipo = manifiestos.filter((m) => m.tipo === accion);
  const manifiesto =
    manifiestosDelTipo.find((m) => m.asset === asset) ??
    manifiestosDelTipo[0] ??
    null;

  const tipo: TipoRepo = modoRepo ? accion : "skill";
  const nombreInicial = modoRepo
    ? (manifiestos[0]?.asset ?? detalle.repo)
    : props.item.name;

  const [scope, setScope] = useState<TargetScope>(defaultScope);
  const [projectId, setProjectId] = useState<string | null>(
    defaultProjectId ?? null,
  );
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [renameTo, setRenameTo] = useState(nombreInicial);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoAplicar | null>(null);

  useEffect(() => {
    if (scope !== "project") return;
    (async () => {
      try {
        const raw = (await invoke<RawProject[]>("list_projects")) ?? [];
        const list: ProjectLite[] = raw.map((p) => ({ id: p.id, name: p.name }));
        setProjects(list);
        if (!projectId && list[0]) setProjectId(list[0].id);
      } catch (e) {
        setErr(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Un aviso que BLOQUEA no se puede saltar desde la interfaz: el backend
  // aborta igualmente, así que el botón se deshabilita y dice por qué.
  const bloqueo = useMemo(
    () => detalle?.avisos.find((a) => a.severidad === "bloquea") ?? null,
    [detalle],
  );

  async function aplicar() {
    setBusy(true);
    setErr(null);
    try {
      if (!modoRepo) {
        const written = await libraryInstallFromGitHub({
          owner: props.item.owner,
          repo: props.item.repo,
          path: props.item.path,
          kind: props.kind,
          target_scope: scope,
          target_project_id: scope === "project" ? projectId : null,
          target_name: renameTo === props.item.name ? null : renameTo,
          overwrite,
        });
        onInstalled(written);
        return;
      }
      const plan: PlanAplicar = {
        owner: detalle.owner,
        repo: detalle.repo,
        sha: detalle.sha,
        tipo,
        nombre: renameTo,
        ficheros: manifiesto?.ficheros ?? [],
        destino: scope,
        project_id: scope === "project" ? projectId : null,
        overwrite,
      };
      const res = await reposAplicar(plan);
      setResultado(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Un botón que no puede actuar explica por qué en vez de no hacer nada.
  const sinFicheros =
    modoRepo &&
    escribeFicheros(tipo) &&
    (manifiesto?.ficheros.length ?? 0) === 0;

  const titulo = modoRepo
    ? `Aplicar ${ETIQUETA_TIPO[tipo]}`
    : `Install ${props.kind}`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="max-h-[88vh] w-[min(620px,92vw)] overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] p-3">
          <Download size={16} />
          <h2 className="text-sm font-semibold">{titulo}</h2>
          <button
            className="ml-auto rounded p-1 hover:bg-[var(--color-surface-2)]"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={14} />
          </button>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* Resultado (sólo modo repo): lo que pasó de verdad             */}
        {/* ------------------------------------------------------------- */}
        {resultado ? (
          <div className="space-y-3 p-4 text-sm">
            <div
              className="flex items-start gap-2 rounded border p-2 text-[12px]"
              style={{
                borderColor: "rgba(63, 185, 80, 0.30)",
                background: "rgba(63, 185, 80, 0.08)",
              }}
            >
              <Check size={13} className="mt-0.5 shrink-0" />
              <span>{resultado.que_paso}</span>
            </div>

            {resultado.escritos.length > 0 && (
              <div>
                <div className="mb-1 text-xs text-[var(--color-text-muted)]">
                  Escrito ({resultado.escritos.length}):
                </div>
                <ul
                  className="max-h-40 space-y-0.5 overflow-y-auto rounded border p-2 text-[11px]"
                  style={{
                    borderColor: "var(--color-border)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {resultado.escritos.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            {resultado.comando_sugerido && (
              <div>
                <div className="mb-1 text-xs text-[var(--color-text-muted)]">
                  Ejecuta tú este comando:
                </div>
                <code
                  className="block select-all rounded border p-2 text-[11.5px]"
                  style={{
                    borderColor: "var(--color-border)",
                    background: "var(--color-surface-2)",
                  }}
                >
                  {resultado.comando_sugerido}
                </code>
              </div>
            )}

            {resultado.diff_propuesto && (
              <div>
                <div className="mb-1 text-xs text-[var(--color-text-muted)]">
                  Cambio propuesto (no se ha aplicado nada):
                </div>
                <pre
                  className="max-h-48 overflow-auto rounded border p-2 text-[11px]"
                  style={{
                    borderColor: "var(--color-border)",
                    background: "var(--color-surface-2)",
                  }}
                >
                  {resultado.diff_propuesto}
                </pre>
              </div>
            )}

            <ListaAvisos avisos={resultado.avisos} />

            <div className="flex justify-end">
              <button
                className="rounded px-3 py-1 text-xs font-medium"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                onClick={() => {
                  onInstalled(resultado.que_paso);
                  onClose();
                }}
              >
                Hecho
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3 p-4 text-sm">
              <div className="text-xs text-[var(--color-text-muted)]">
                Desde{" "}
                <span className="font-mono">
                  {modoRepo
                    ? `${detalle.owner}/${detalle.repo}`
                    : `${props.item.owner}/${props.item.repo}/${props.item.path}`}
                </span>
                {modoRepo && (
                  <>
                    {" @ "}
                    <span className="font-mono" title="Commit fijado">
                      {detalle.sha.slice(0, 10)}
                    </span>
                  </>
                )}
              </div>

              {modoRepo && (
                <>
                  <p
                    className="rounded border p-2 text-[12px]"
                    style={{
                      borderColor: "var(--color-border)",
                      background: "var(--color-surface-2)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {detalle.resumen}
                  </p>

                  {/* Qué hacer con él: un repo puede ser varias cosas */}
                  {detalle.tipos.length > 1 && (
                    <div>
                      <div className="mb-1 text-xs text-[var(--color-text-muted)]">
                        Este repositorio es varias cosas. ¿Qué quieres hacer?
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {detalle.tipos.map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => {
                              setAccion(t);
                              const m = manifiestos.find((x) => x.tipo === t);
                              if (m) {
                                setAsset(m.asset);
                                setRenameTo(m.asset);
                              }
                            }}
                            className="rounded px-2 py-1 text-[11px]"
                            style={{
                              background:
                                accion === t
                                  ? "var(--color-accent)"
                                  : "var(--color-surface-2)",
                              color:
                                accion === t
                                  ? "var(--color-accent-text)"
                                  : "var(--color-text-secondary)",
                              border: "1px solid var(--color-border)",
                            }}
                          >
                            {ETIQUETA_TIPO[t]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Cuál de ellas: un repo de skills trae muchas */}
                  {escribeFicheros(tipo) && manifiestosDelTipo.length > 1 && (
                    <label className="block">
                      <span className="text-xs text-[var(--color-text-muted)]">
                        Cuál de las {manifiestosDelTipo.length}
                      </span>
                      <select
                        className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
                        value={asset}
                        onChange={(e) => {
                          setAsset(e.target.value);
                          setRenameTo(e.target.value);
                        }}
                      >
                        {manifiestosDelTipo.map((m) => (
                          <option key={m.asset} value={m.asset}>
                            {m.asset} ({m.ficheros.length} ficheros)
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {/* El manifiesto: lo que se escribiría, antes de escribirlo */}
                  {escribeFicheros(tipo) && (
                    <div>
                      <div className="mb-1 text-xs text-[var(--color-text-muted)]">
                        Se escribirían {manifiesto?.ficheros.length ?? 0} ficheros
                        {tipo === "skill"
                          ? " en ~/.claude/skills/_disabled/ (deshabilitada: el dispatcher la inyecta cuando el prompt la pide)"
                          : " en ~/.claude/agents/"}
                        :
                      </div>
                      {!manifiesto || manifiesto.ficheros.length === 0 ? (
                        <p className="text-[11.5px] text-[var(--color-text-tertiary)]">
                          Ninguno: este repositorio no trae ninguna carpeta que
                          siga la convención, así que no hay nada que instalar.
                        </p>
                      ) : (
                        <ul
                          className="max-h-40 space-y-0.5 overflow-y-auto rounded border p-2 text-[11px]"
                          style={{
                            borderColor: "var(--color-border)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {manifiesto.ficheros.map((f) => (
                            <li
                              key={f.destino_rel}
                              className="flex justify-between gap-2"
                            >
                              <span className="truncate">{f.destino_rel}</span>
                              <span className="shrink-0 text-[var(--color-text-tertiary)]">
                                {f.tamano === null
                                  ? "?"
                                  : `${Math.max(1, Math.round(f.tamano / 1024))} KB`}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <ListaAvisos avisos={detalle.avisos} />
                </>
              )}

              {(!modoRepo || escribeFicheros(tipo) || tipo === "mcp") && (
                <>
                  <label className="block">
                    <span className="text-xs text-[var(--color-text-muted)]">
                      Nombre de destino (kebab-case)
                    </span>
                    <input
                      className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 outline-none"
                      value={renameTo}
                      onChange={(e) => setRenameTo(e.target.value)}
                    />
                  </label>

                  {(!modoRepo || escribeFicheros(tipo)) && (
                    <>
                      <fieldset className="flex gap-3">
                        <label className="flex items-center gap-1 text-xs">
                          <input
                            type="radio"
                            checked={scope === "global"}
                            onChange={() => setScope("global")}
                          />
                          Global (<span className="font-mono">~/.claude/</span>)
                        </label>
                        <label className="flex items-center gap-1 text-xs">
                          <input
                            type="radio"
                            checked={scope === "project"}
                            onChange={() => setScope("project")}
                          />
                          Proyecto
                        </label>
                      </fieldset>
                      {scope === "project" && (
                        <select
                          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
                          value={projectId ?? ""}
                          onChange={(e) => setProjectId(e.target.value || null)}
                        >
                          <option value="">(elige proyecto)</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={overwrite}
                          onChange={(e) => setOverwrite(e.target.checked)}
                        />
                        Sobrescribir si ya existe
                      </label>
                    </>
                  )}
                </>
              )}

              {err && (
                <div className="rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-2 text-xs text-[var(--color-error)]">
                  {err}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] p-3">
              {bloqueo && (
                <span className="mr-auto text-[11px] text-[var(--color-error)]">
                  Bloqueado por «{bloqueo.regla}»: {bloqueo.detalle}
                </span>
              )}
              <button
                className="rounded border border-[var(--color-border)] px-3 py-1 text-xs hover:bg-[var(--color-surface-2)]"
                onClick={onClose}
                disabled={busy}
              >
                Cancelar
              </button>
              <button
                className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                onClick={aplicar}
                disabled={
                  busy ||
                  bloqueo !== null ||
                  sinFicheros ||
                  (scope === "project" &&
                    (!modoRepo || escribeFicheros(tipo)) &&
                    !projectId)
                }
                title={
                  bloqueo
                    ? `No se puede aplicar: ${bloqueo.detalle}`
                    : sinFicheros
                      ? "No hay ningún fichero que escribir para esta acción"
                      : undefined
                }
              >
                {busy
                  ? "Aplicando…"
                  : modoRepo && !escribeFicheros(tipo) && tipo !== "mcp"
                    ? "Ver qué haría"
                    : "Aplicar"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default InstallConfirmModal;
