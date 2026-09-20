// mar.ia — mosaico: varias conversaciones y terminales a la vez.
//
// El usuario lo pidio el 2026-09-18: "poder arrastrar y tener en paralelo o en
// grid varias conversaciones/chat/terminales, para ver mejor todo, al igual
// que en Claude Desktop".
//
// Como funciona: una rejilla de paneles; cada panel lleva dentro un chat, una
// terminal o el navegador de conversaciones. Se arrastran por su cabecera para
// reordenarlos y se elige de una a tres columnas. La disposicion se guarda en
// el navegador, asi que al volver esta como la dejaste.
//
// Limite declarado (mandamiento 13): los paneles se REORDENAN, no se
// redimensionan uno a uno; el ancho lo da el numero de columnas. Un sistema de
// divisiones arrastrables es otra feature, y esta ya resuelve el "ver varias
// cosas a la vez" que se pidio.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Conversations } from "../Conversations";
import { MariaChat } from "./MariaChat";
import { TerminalPane } from "./TerminalPane";
import { HudSelect } from "./HudSelect";
import {
  anadir,
  cargar,
  ETIQUETA,
  fijarColumnas,
  fijarRef,
  guardar,
  MAX_COLUMNAS,
  MAX_PANELES,
  MIN_COLUMNAS,
  mover,
  quitar,
  sincronizar,
  type Disposicion,
  type Panel,
  type TipoPanel,
} from "./mosaicoState";

/** Una terminal viva, tal y como la devuelve `maria_term_list`. */
type TermInfo = { id: string; provider: string; running: boolean; model: string };
/** Una conversacion, tal y como la devuelve `maria_threads_list`. */
type HiloInfo = { id: string; title: string; closed: boolean; turns: number };

const TIPOS: TipoPanel[] = ["chat", "terminal", "conversaciones"];

export function Mosaico() {
  const [disp, setDisp] = useState<Disposicion>(() =>
    cargar(typeof localStorage === "undefined" ? null : localStorage),
  );
  /** Panel que se esta arrastrando ahora mismo. */
  const [arrastrando, setArrastrando] = useState<string | null>(null);
  /** Panel sobre el que se soltaria (para pintar la guia). */
  const [encima, setEncima] = useState<string | null>(null);

  useEffect(() => {
    guardar(typeof localStorage === "undefined" ? null : localStorage, disp);
  }, [disp]);

  /** Trae al mosaico lo que ya este abierto: cada terminal viva y las
   *  conversaciones sin cerrar. Se hace al entrar y con el boton de recargar.
   *
   *  Las conversaciones se limitan a las mas recientes: el mosaico tiene nueve
   *  huecos y meterle treinta hilos no ayuda a nadie. */
  const sincronizarAbierto = useCallback(async () => {
    const [terms, hilos] = await Promise.all([
      invoke<TermInfo[]>("maria_term_list").catch(() => [] as TermInfo[]),
      invoke<HiloInfo[]>("maria_threads_list").catch(() => [] as HiloInfo[]),
    ]);
    const vivas = terms.filter((t) => t.running).map((t) => t.id);
    const abiertos = hilos.filter((h) => !h.closed && h.turns > 0).slice(0, 3).map((h) => h.id);
    setDisp((d) => sincronizar(sincronizar(d, "terminal", vivas), "chat", abiertos));
  }, []);

  useEffect(() => {
    void sincronizarAbierto();
  }, [sincronizarAbierto]);

  const fijarRefDe = useCallback((key: string, ref: string) => {
    setDisp((d) => fijarRef(d, key, ref));
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col px-4 py-3">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h1 className="hud-label" style={{ fontSize: 12 }}>
          mosaico · varias cosas a la vez
        </h1>
        <span className="flex-1" />

        <button
          type="button"
          onClick={() => void sincronizarAbierto()}
          title="trae al mosaico las terminales y conversaciones que tengas abiertas"
          className="hud-panel px-2 text-[11px]"
          style={{ minHeight: 26, color: "var(--color-text-secondary)", cursor: "pointer" }}
        >
          traer lo abierto
        </button>

        {TIPOS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setDisp((d) => anadir(d, t))}
            disabled={disp.paneles.length >= MAX_PANELES}
            title={
              disp.paneles.length >= MAX_PANELES
                ? `máximo ${MAX_PANELES} paneles`
                : `añadir ${ETIQUETA[t]}`
            }
            className="hud-panel hud-label px-2 py-1"
            style={{
              color:
                disp.paneles.length >= MAX_PANELES
                  ? "var(--color-text-tertiary)"
                  : "var(--color-accent)",
              cursor: disp.paneles.length >= MAX_PANELES ? "default" : "pointer",
            }}
          >
            + {ETIQUETA[t]}
          </button>
        ))}

        <HudSelect
          etiqueta="columnas"
          valor={String(disp.columnas)}
          ancho={110}
          opciones={Array.from(
            { length: MAX_COLUMNAS - MIN_COLUMNAS + 1 },
            (_, i) => i + MIN_COLUMNAS,
          ).map((n) => ({ id: String(n), label: String(n) }))}
          onChange={(v) => setDisp((d) => fijarColumnas(d, Number(v)))}
        />
      </header>

      {disp.paneles.length === 0 ? (
        <p className="hud-label p-3">
          mosaico vacío. añade un chat o una terminal con los botones de arriba.
        </p>
      ) : (
        <div
          className="grid min-h-0 flex-1 gap-2 overflow-auto"
          style={{
            gridTemplateColumns: `repeat(${disp.columnas}, minmax(0, 1fr))`,
            // Filas de altura util: con `auto` un panel con poco contenido se
            // encoge y el terminal de al lado se queda sin sitio.
            gridAutoRows: "minmax(320px, 1fr)",
          }}
        >
          {disp.paneles.map((p) => (
            <PanelCaja
              key={p.key}
              panel={p}
              resaltado={encima === p.key && arrastrando !== p.key}
              onArrastrar={() => setArrastrando(p.key)}
              onSoltarEncima={() => {
                if (arrastrando) setDisp((d) => mover(d, arrastrando, p.key));
                setArrastrando(null);
                setEncima(null);
              }}
              onEncima={() => setEncima(p.key)}
              onFinArrastre={() => {
                setArrastrando(null);
                setEncima(null);
              }}
              onCerrar={() => setDisp((d) => quitar(d, p.key))}
              onRef={(ref) => fijarRefDe(p.key, ref)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PanelCaja({
  panel,
  resaltado,
  onArrastrar,
  onSoltarEncima,
  onEncima,
  onFinArrastre,
  onCerrar,
  onRef,
}: {
  panel: Panel;
  resaltado: boolean;
  onArrastrar: () => void;
  onSoltarEncima: () => void;
  onEncima: () => void;
  onFinArrastre: () => void;
  onCerrar: () => void;
  onRef: (ref: string) => void;
}) {
  return (
    <section
      className="hud-panel flex min-h-0 min-w-0 flex-col overflow-hidden"
      style={{
        outline: resaltado ? "1px solid var(--color-accent)" : "none",
        outlineOffset: "-1px",
      }}
      onDragOver={(e) => {
        // Sin preventDefault el navegador no considera esta zona soltable y el
        // cursor sale tachado aunque el drop funcione.
        e.preventDefault();
        onEncima();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onSoltarEncima();
      }}
    >
      {/* Solo la cabecera arrastra: si arrastrara el panel entero, seleccionar
          texto en el chat o en la terminal iniciaria un arrastre. */}
      <header
        draggable
        onDragStart={onArrastrar}
        onDragEnd={onFinArrastre}
        className="flex items-center gap-2 px-2 py-1"
        style={{
          borderBottom: "1px solid var(--color-border)",
          cursor: "grab",
          background: "var(--color-surface-3)",
        }}
        title="arrastra para mover el panel"
      >
        <span className="hud-label" aria-hidden>
          ⠿
        </span>
        <span className="hud-label" style={{ color: "var(--color-accent)" }}>
          {ETIQUETA[panel.tipo]}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCerrar}
          aria-label={`cerrar panel ${ETIQUETA[panel.tipo]}`}
          className="text-[12px]"
          style={{
            color: "var(--color-text-tertiary)",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {panel.tipo === "chat" && (
          <MariaChat hiloInicial={panel.ref || undefined} compacto onHilo={onRef} />
        )}
        {panel.tipo === "terminal" && (
          <TerminalPane sessionId={panel.ref} onSession={onRef} />
        )}
        {panel.tipo === "conversaciones" && <Conversations />}
      </div>
    </section>
  );
}
