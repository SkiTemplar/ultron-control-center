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

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Artefacto } from "./Artefacto";
import { Markdown, type ArtefactoRef } from "./Markdown";

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

function Cambios({ proyecto, refresco }: { proyecto: string; refresco: number }) {
  const [cambios, setCambios] = useState<Cambio[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [cargando, setCargando] = useState(false);

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex items-center justify-between gap-2 border-b px-3 py-1.5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span className="hud-label truncate" title={proyecto}>
          {cambios.length} fichero{cambios.length === 1 ? "" : "s"} con cambios
        </span>
        <button type="button" className="cc-bloque-boton" onClick={() => void cargar()}>
          {cargando ? "leyendo…" : "refrescar"}
        </button>
      </div>
      {cambios.length === 0 ? (
        <Vacio>el árbol de trabajo está limpio: nada que revisar.</Vacio>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ul className="max-h-[38%] shrink-0 overflow-y-auto border-b" style={{ borderColor: "var(--color-border)" }}>
            {cambios.map((c) => {
              const e = estadoDe(c);
              return (
                <li key={c.path}>
                  <button
                    type="button"
                    onClick={() => void abrir(c)}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11.5px]"
                    style={{
                      background: abierto === c.path ? "var(--color-surface-3)" : "transparent",
                      color: "var(--color-text)",
                      border: "none",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                    }}
                    title={`${e.texto}${c.staged ? " · preparado" : ""}`}
                  >
                    <span style={{ color: e.color, width: 12 }}>{e.letra}</span>
                    <span className="min-w-0 flex-1 truncate">{c.path}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="min-h-0 flex-1 overflow-auto">
            {abierto ? <Diff texto={diff || "…"} /> : <Vacio>elige un fichero para ver su diff.</Vacio>}
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
  return (
    <aside
      className="flex h-full min-w-0 flex-col border-l"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
      aria-label="panel lateral"
    >
      <div
        className="flex items-center justify-between border-b"
        style={{ borderColor: "var(--color-border)" }}
        role="tablist"
      >
        <div className="flex">
          {pestañas.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={panel === p}
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
        {panel === "cambios" && <Cambios proyecto={proyecto} refresco={refresco} />}
        {panel === "web" && <Web onAviso={onAviso} />}
        {panel === "ficheros" && (
          <Ficheros threadId={threadId} refresco={refresco} onArtefacto={onArtefacto} />
        )}
      </div>
    </aside>
  );
}
