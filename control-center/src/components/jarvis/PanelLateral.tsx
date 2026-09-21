// mar.ia — panel lateral del chat: artefacto, cambios, web y ficheros.
//
// Lo que en Claude Desktop son los paneles de la derecha. Aqui comparten un
// mismo hueco y una barra de pestañas:
//
//   * artefacto — lo que la IA genero para verse (`Artefacto.tsx`).
//   * cambios   — `git status` + diff por fichero del proyecto de la
//                 conversacion. Se refresca solo cuando un agente termina.
//   * web       — vista previa de una direccion. Pensado para el servidor de
//                 desarrollo (localhost); un sitio que se niega a pintarse en un
//                 marco se abre en ventana propia o en el navegador.
//   * ficheros  — la carpeta de trabajo (o el proyecto): ver lo que han dejado
//                 los agentes sin salir del chat.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { confirmDialog } from "../../lib/dialog";
import { Artefacto } from "./Artefacto";
import { Markdown, type ArtefactoRef } from "./Markdown";
import { siguientePestana } from "./panelLateralNav";

export type PanelId = "artefacto" | "cambios" | "web" | "ficheros";

type Cambio = {
  path: string;
  index_status: string;
  worktree_status: string;
  staged: boolean;
  untracked: boolean;
};
type Entrada = { nombre: string; ruta: string; carpeta: boolean; bytes: number };

const ETIQUETA: Record<PanelId, string> = {
  artefacto: "artefacto",
  cambios: "cambios",
  web: "web",
  ficheros: "ficheros",
};

/** Letra de estado de git, en cristiano. */
function estadoDe(c: Cambio): { letra: string; texto: string; color: string } {
  if (c.untracked) return { letra: "N", texto: "nuevo", color: "var(--color-success)" };
  const s = (c.worktree_status.trim() || c.index_status.trim()).toUpperCase();
  if (s === "D") return { letra: "B", texto: "borrado", color: "var(--color-danger)" };
  if (s === "A") return { letra: "A", texto: "añadido", color: "var(--color-success)" };
  if (s === "R") return { letra: "R", texto: "renombrado", color: "var(--color-warn)" };
  return { letra: "M", texto: "modificado", color: "var(--color-warn)" };
}

/** Un diff unificado con sus lineas en color. */
export function Diff({ texto }: { texto: string }) {
  return (
    <pre className="cc-code cc-diff m-0">
      {texto.split("\n").map((l, i) => {
        const clase = l.startsWith("+++") || l.startsWith("---")
          ? "cc-diff-cab"
          : l.startsWith("@@")
            ? "cc-diff-tramo"
            : l.startsWith("+")
              ? "cc-diff-mas"
              : l.startsWith("-")
                ? "cc-diff-menos"
                : undefined;
        return (
          <span key={i} className={clase} style={{ display: "block" }}>
            {l || " "}
          </span>
        );
      })}
    </pre>
  );
}

function Vacio({ children }: { children: React.ReactNode }) {
  return (
    <p className="p-4 text-[12px] leading-relaxed" style={{ color: "var(--color-text-tertiary)" }}>
      {children}
    </p>
  );
}

// --------------------------------------------------------------------------
// Cambios
// --------------------------------------------------------------------------

function Cambios({
  proyecto,
  refresco,
  onAviso,
}: {
  proyecto: string;
  refresco: number;
  onAviso: (t: string, tono?: "info" | "error") => void;
}) {
  const [cambios, setCambios] = useState<Cambio[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [cargando, setCargando] = useState(false);
  /** Mensaje del commit. Vive aqui: al cerrar el panel se pierde a proposito. */
  const [mensaje, setMensaje] = useState("");
  /** Hay una operacion de git en marcha: nada de dos a la vez sobre el repo. */
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    if (!proyecto) return;
    setCargando(true);
    try {
      setCambios(await invoke<Cambio[]>("git_changes", { path: proyecto }));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setCargando(false);
    }
  }, [proyecto]);

  useEffect(() => {
    void cargar();
  }, [cargar, refresco]);

  const abrir = useCallback(
    async (c: Cambio) => {
      setAbierto(c.path);
      setDiff("");
      try {
        const d = c.untracked
          ? await invoke<string>("maria_fichero_leer", { ruta: `${proyecto}/${c.path}` })
          : await invoke<string>("git_diff_file", { path: proyecto, file: c.path, staged: c.staged });
        setDiff(d || "(sin diferencias de texto)");
      } catch (e) {
        setDiff(String(e));
      }
    },
    [proyecto],
  );

  // Una operacion de git, y a releer. Mismo patron que `runOp` de RepoModal
  // (components/projects/RepoModal.tsx), que es donde estas tres llamadas
  // llevan funcionando desde el micro GitHub Desktop: aqui no se inventa
  // nada, se pone a mano en la superficie donde ya se ve el diff.
  const correr = useCallback(
    async (fn: () => Promise<unknown>, hecho?: string) => {
      setOcupado(true);
      try {
        await fn();
        await cargar();
        if (hecho) onAviso(hecho);
      } catch (e) {
        onAviso(String(e), "error");
      } finally {
        setOcupado(false);
      }
    },
    [cargar, onAviso],
  );

  /** Descartar es lo unico de aqui que no tiene vuelta atras: se pregunta. */
  const descartar = useCallback(
    async (c: Cambio) => {
      const ok = await confirmDialog(
        `Descartar los cambios de «${c.path}»? Vuelve a como está en el último commit y lo que hubiera se pierde.`,
        { title: "Descartar cambios", kind: "warning", okLabel: "Descartar" },
      );
      if (!ok) return;
      await correr(
        () => invoke("git_discard_file", { path: proyecto, file: c.path }),
        `«${c.path}» vuelve a como estaba`,
      );
      setAbierto((a) => (a === c.path ? null : a));
    },
    [correr, proyecto],
  );

  if (!proyecto) {
    return (
      <Vacio>
        Esta conversación no trabaja sobre ningún proyecto. Elige uno en el selector «proyecto» de
        la cabecera (o con <code>/proyecto &lt;ruta&gt;</code>) y aquí verás lo que cambian los
        agentes, fichero a fichero.
      </Vacio>
    );
  }
  if (error) return <Vacio>no pude leer los cambios: {error}</Vacio>;
  if (!cambios) return <p className="hud-label hud-pulse p-4">leyendo el repositorio…</p>;

  const preparados = cambios.filter((c) => c.staged).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex items-center justify-between gap-2 border-b px-3 py-1.5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span className="hud-label truncate" title={proyecto}>
          {cambios.length} fichero{cambios.length === 1 ? "" : "s"} con cambios
          {preparados > 0 ? ` · ${preparados} preparado${preparados === 1 ? "" : "s"}` : ""}
        </span>
        <span className="flex shrink-0 gap-1.5">
          <button
            type="button"
            className="cc-bloque-boton"
            disabled={ocupado || cambios.length === 0}
            title="preparar todos los cambios (git add -A)"
            onClick={() => void correr(() => invoke("git_stage", { path: proyecto, files: [] }))}
          >
            preparar todo
          </button>
          <button
            type="button"
            className="cc-bloque-boton"
            disabled={ocupado || preparados === 0}
            title="quitar todos del preparado; los cambios no se tocan"
            onClick={() => void correr(() => invoke("git_unstage", { path: proyecto, files: [] }))}
          >
            quitar todo
          </button>
          <button type="button" className="cc-bloque-boton" onClick={() => void cargar()}>
            {cargando ? "leyendo…" : "refrescar"}
          </button>
        </span>
      </div>
      {cambios.length === 0 ? (
        <Vacio>el árbol de trabajo está limpio: nada que revisar.</Vacio>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ul className="max-h-[38%] shrink-0 overflow-y-auto border-b" style={{ borderColor: "var(--color-border)" }}>
            {cambios.map((c) => {
              const e = estadoDe(c);
              return (
                <li
                  key={c.path}
                  className="cc-fila-fichero group flex items-center gap-2 px-3 py-1 text-[11.5px]"
                  style={{
                    background: abierto === c.path ? "var(--color-surface-3)" : "transparent",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={c.staged}
                    disabled={ocupado}
                    aria-label={`${c.staged ? "quitar de preparado" : "preparar"} ${c.path}`}
                    title={c.staged ? "quitar de preparado" : "preparar para el commit"}
                    onChange={() =>
                      void correr(() =>
                        invoke(c.staged ? "git_unstage" : "git_stage", {
                          path: proyecto,
                          files: [c.path],
                        }),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() => void abrir(c)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    style={{
                      color: "var(--color-text)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                    title={`${e.texto}${c.staged ? " · preparado" : ""}`}
                  >
                    <span style={{ color: e.color, width: 12 }}>{e.letra}</span>
                    <span className="min-w-0 flex-1 truncate">{c.path}</span>
                  </button>
                  {/* Sin seguir no se ofrece: descartarlo seria borrarlo y git
                      no tendria de donde recuperarlo (lo rechaza tambien el
                      backend, `git_discard_file`). */}
                  {!c.untracked && (
                    <button
                      type="button"
                      className="cc-bloque-boton shrink-0"
                      disabled={ocupado}
                      aria-label={`descartar los cambios de ${c.path}`}
                      title="descartar: vuelve a como estaba en el último commit"
                      onClick={() => void descartar(c)}
                    >
                      descartar
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="min-h-0 flex-1 overflow-auto">
            {abierto ? <Diff texto={diff || "…"} /> : <Vacio>elige un fichero para ver su diff.</Vacio>}
          </div>
          {/* La barra de confirmar, abajo: revisar el diff y guardarlo sin
              pasar por Proyectos -> Repo, que era el pendiente nº3 de
              docs/PARIDAD-CLAUDE-DESKTOP.md. */}
          <div
            className="flex shrink-0 flex-col gap-1.5 border-t px-3 py-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            <textarea
              value={mensaje}
              onChange={(ev) => setMensaje(ev.target.value)}
              placeholder="qué has cambiado y por qué…"
              aria-label="mensaje del commit"
              rows={2}
              className="hud-panel w-full resize-none px-2 py-1.5 text-[11.5px]"
              style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)", outline: "none" }}
            />
            <button
              type="button"
              className="cc-bloque-boton"
              disabled={ocupado || preparados === 0 || !mensaje.trim()}
              title={
                preparados === 0
                  ? "marca antes qué ficheros entran en el commit"
                  : "git commit de lo preparado"
              }
              onClick={() =>
                void correr(async () => {
                  await invoke("git_commit", { path: proyecto, message: mensaje });
                  setMensaje("");
                }, `commit hecho con ${preparados} fichero${preparados === 1 ? "" : "s"}`)
              }
            >
              confirmar {preparados > 0 ? `(${preparados})` : ""}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Web
// --------------------------------------------------------------------------

const ULTIMA_URL = "maria.panel.web.url";

/** Misma regla que `paneles::url_valida` en Rust. */
export function normalizaUrl(url: string): string | null {
  const u = url.trim();
  const bajo = u.toLowerCase();
  if (bajo.startsWith("http://") || bajo.startsWith("https://")) return u;
  if (!u || /\s/.test(u) || u.includes("://") || bajo.startsWith("javascript:")) return null;
  const local = bajo.startsWith("localhost") || bajo.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${u}`;
}

function Web({ onAviso }: { onAviso: (t: string, tono?: "info" | "error") => void }) {
  const [caja, setCaja] = useState(() => localStorage.getItem(ULTIMA_URL) ?? "localhost:5173");
  const [url, setUrl] = useState<string | null>(null);
  const [vuelta, setVuelta] = useState(0);

  function ir() {
    const u = normalizaUrl(caja);
    if (!u) {
      onAviso("esa dirección no es http ni https", "error");
      return;
    }
    localStorage.setItem(ULTIMA_URL, caja);
    setUrl(u);
    setVuelta((v) => v + 1);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="flex items-center gap-1.5 border-b px-2 py-1.5"
        style={{ borderColor: "var(--color-border)" }}
        onSubmit={(e) => {
          e.preventDefault();
          ir();
        }}
      >
        <input
          value={caja}
          onChange={(e) => setCaja(e.target.value)}
          aria-label="dirección"
          placeholder="localhost:5173 o una dirección web"
          className="hud-panel min-w-0 flex-1 px-2 py-1 text-[11.5px]"
          style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)", outline: "none" }}
        />
        <button type="submit" className="cc-bloque-boton">
          ir
        </button>
        <button type="button" className="cc-bloque-boton" disabled={!url} onClick={() => setVuelta((v) => v + 1)}>
          recargar
        </button>
        <button
          type="button"
          className="cc-bloque-boton"
          title="en una ventana propia de mar.ia: sirve para los sitios que no se dejan enmarcar"
          onClick={() => {
            const u = normalizaUrl(caja);
            if (u) void invoke("maria_web_ventana", { url: u }).catch((e) => onAviso(String(e), "error"));
          }}
        >
          ventana
        </button>
        <button
          type="button"
          className="cc-bloque-boton"
          onClick={() => {
            const u = normalizaUrl(caja);
            if (u) void openUrl(u);
          }}
        >
          navegador
        </button>
      </form>
      {url ? (
        <iframe
          key={vuelta}
          title="vista previa web"
          src={url}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          className="min-h-0 w-full flex-1"
          style={{ border: "none", background: "#fff" }}
        />
      ) : (
        <Vacio>
          Escribe una dirección y pulsa «ir». Está pensado para tu servidor de desarrollo
          (<code>localhost:5173</code>, <code>localhost:3000</code>…). Muchos sitios públicos se
          niegan a pintarse dentro de un marco: si se queda en blanco, usa «ventana» o «navegador».
        </Vacio>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Ficheros
// --------------------------------------------------------------------------

function tamaño(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function Ficheros({
  threadId,
  refresco,
  onArtefacto,
}: {
  threadId: string;
  refresco: number;
  onArtefacto: (a: ArtefactoRef) => void;
}) {
  const [raiz, setRaiz] = useState("");
  const [dir, setDir] = useState("");
  const [entradas, setEntradas] = useState<Entrada[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fichero, setFichero] = useState<{ ruta: string; texto: string } | null>(null);

  useEffect(() => {
    if (!threadId) return;
    void invoke<string>("maria_carpeta_de", { threadId })
      .then((r) => {
        setRaiz(r);
        setDir(r);
      })
      .catch((e) => setError(String(e)));
  }, [threadId]);

  useEffect(() => {
    if (!dir) return;
    setFichero(null);
    void invoke<Entrada[]>("maria_ficheros", { ruta: dir })
      .then((l) => {
        setEntradas(l);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [dir, refresco]);

  async function abrir(e: Entrada) {
    if (e.carpeta) {
      setDir(e.ruta);
      return;
    }
    try {
      const texto = await invoke<string>("maria_fichero_leer", { ruta: e.ruta });
      const ext = e.nombre.split(".").pop()?.toLowerCase() ?? "";
      if (ext === "html" || ext === "htm") onArtefacto({ tipo: "html", codigo: texto });
      else if (ext === "svg") onArtefacto({ tipo: "svg", codigo: texto });
      else if (ext === "mmd") onArtefacto({ tipo: "mermaid", codigo: texto });
      else setFichero({ ruta: e.ruta, texto });
    } catch (err) {
      setFichero({ ruta: e.ruta, texto: `${String(err)}` });
    }
  }

  const relativa = dir.startsWith(raiz) ? dir.slice(raiz.length).replace(/^[\\/]/, "") : dir;
  const enRaiz = dir === raiz;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex items-center gap-1.5 border-b px-2 py-1.5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <button
          type="button"
          className="cc-bloque-boton"
          disabled={enRaiz}
          onClick={() => setDir(dir.replace(/[\\/][^\\/]+$/, "") || raiz)}
        >
          subir
        </button>
        <span className="hud-label min-w-0 flex-1 truncate" title={dir}>
          {relativa || "carpeta de la conversación"}
        </span>
        <button type="button" className="cc-bloque-boton" onClick={() => void openPath(dir)}>
          abrir en el explorador
        </button>
      </div>
      {error ? (
        <Vacio>{error}</Vacio>
      ) : fichero ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2 px-3 py-1">
            <span className="hud-label truncate">{fichero.ruta.split(/[\\/]/).pop()}</span>
            <span className="flex gap-1.5">
              <button type="button" className="cc-bloque-boton" onClick={() => void openPath(fichero.ruta)}>
                abrir con su programa
              </button>
              <button type="button" className="cc-bloque-boton" onClick={() => setFichero(null)}>
                volver
              </button>
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 text-[12px]">
            {/\.(md|markdown)$/i.test(fichero.ruta) ? (
              <Markdown texto={fichero.texto} onAbrir={onArtefacto} />
            ) : (
              <pre className="cc-code m-0">
                <code>{fichero.texto}</code>
              </pre>
            )}
          </div>
        </div>
      ) : !entradas ? (
        <p className="hud-label hud-pulse p-4">leyendo la carpeta…</p>
      ) : entradas.length === 0 ? (
        <Vacio>la carpeta está vacía. Lo que produzcan los agentes aparecerá aquí.</Vacio>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {entradas.map((e) => (
            <li key={e.ruta}>
              <button
                type="button"
                onClick={() => void abrir(e)}
                className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11.5px]"
                style={{
                  background: "transparent",
                  color: e.carpeta ? "var(--color-accent)" : "var(--color-text)",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {e.nombre}
                  {e.carpeta ? "/" : ""}
                </span>
                {!e.carpeta && (
                  <span style={{ color: "var(--color-text-tertiary)" }}>{tamaño(e.bytes)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// El panel
// --------------------------------------------------------------------------

export function PanelLateral({
  panel,
  onPanel,
  onCerrar,
  artefacto,
  onArtefacto,
  threadId,
  proyecto,
  refresco,
  onAviso,
}: {
  panel: PanelId;
  onPanel: (p: PanelId) => void;
  onCerrar: () => void;
  artefacto: ArtefactoRef | null;
  onArtefacto: (a: ArtefactoRef) => void;
  threadId: string;
  proyecto: string;
  /** Sube cada vez que un agente termina: cambios y ficheros se vuelven a leer. */
  refresco: number;
  onAviso: (texto: string, tono?: "info" | "error") => void;
}) {
  const pestañas: PanelId[] = artefacto
    ? ["artefacto", "cambios", "web", "ficheros"]
    : ["cambios", "web", "ficheros"];
  const activa = Math.max(0, pestañas.indexOf(panel));
  const botones = useRef<Array<HTMLButtonElement | null>>([]);

  /** Flechas por la tira de pestañas (patrón de tabs con tabIndex móvil). */
  function teclaPestana(e: React.KeyboardEvent<HTMLButtonElement>) {
    const destino = siguientePestana(e.key, activa, pestañas.length);
    if (destino === null) return; // el resto de teclas siguen su camino
    e.preventDefault();
    onPanel(pestañas[destino]);
    botones.current[destino]?.focus();
  }

  return (
    <aside
      className="flex h-full min-w-0 flex-col border-l"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
      aria-label="panel lateral"
    >
      <div
        className="flex items-center justify-between border-b"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex" role="tablist" aria-label="paneles del chat">
          {pestañas.map((p, i) => (
            <button
              key={p}
              type="button"
              role="tab"
              ref={(el) => {
                botones.current[i] = el;
              }}
              aria-selected={panel === p}
              // tabIndex movil: al tabular se entra a la pestaña activa y
              // desde ahi se recorren con las flechas, no con mas tabulador.
              tabIndex={i === activa ? 0 : -1}
              onKeyDown={teclaPestana}
              onClick={() => onPanel(p)}
              className="px-3 py-1.5 text-[11px] uppercase"
              style={{
                background: panel === p ? "var(--color-surface-3)" : "transparent",
                color: panel === p ? "var(--color-text)" : "var(--color-text-tertiary)",
                border: "none",
                borderBottom: panel === p ? "1px solid var(--color-accent)" : "1px solid transparent",
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.1em",
                cursor: "pointer",
              }}
            >
              {ETIQUETA[p]}
            </button>
          ))}
        </div>
        <button type="button" className="cc-bloque-boton mr-2" onClick={onCerrar} aria-label="cerrar el panel">
          cerrar
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {panel === "artefacto" && artefacto && (
          <Artefacto artefacto={artefacto} threadId={threadId} onAviso={onAviso} />
        )}
        {panel === "cambios" && (
          <Cambios proyecto={proyecto} refresco={refresco} onAviso={onAviso} />
        )}
        {panel === "web" && <Web onAviso={onAviso} />}
        {panel === "ficheros" && (
          <Ficheros threadId={threadId} refresco={refresco} onArtefacto={onArtefacto} />
        )}
      </div>
    </aside>
  );
}
