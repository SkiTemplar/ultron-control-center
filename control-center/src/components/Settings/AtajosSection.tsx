// Ajustes → Atajos: cambiar las teclas dentro de la ventana.
//
// POR QUE EXISTE (2026-09-22): los combos vivian en
// `~/.maria/.tmp/in-app-shortcuts.json` y la unica forma de tocarlos era abrir
// ese fichero a mano. El comentario de App.tsx llego a decir «editable via
// Settings → General → In-app shortcuts» cuando esa pantalla nunca existio
// (mandamiento 6). Esta es la pantalla.
//
// Lo que NO hace esta pantalla, a proposito: no valida el combo ella misma.
// Quien manda es `set_in_app_shortcuts` (Rust), que es quien ademas ve TODAS
// las acciones a la vez y puede detectar el duplicado. Aqui se captura, se
// manda y se pinta el motivo del rechazo junto a la fila que lo provoco: una
// segunda validacion en TypeScript acabaria discrepando de la de Rust.
//
// El atajo global de abrir mar.ia (Ctrl+Alt+M) NO esta aqui: ese lo registra
// el sistema operativo y vive en General.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { etiquetaAccionChat } from "../jarvis/chatAcciones";

/**
 * Nombre en castellano de cada accion que NO es del chat.
 *
 * Las `chat.*` salen de `ACCIONES_CHAT` (`jarvis/chatAcciones.ts`): es la
 * misma lista que alimenta la paleta y los atajos, y copiar aqui sus etiquetas
 * garantizaria que un dia dijeran cosas distintas.
 *
 * Un id que no este ni aqui ni alli se ensena TAL CUAL. Rust puede anadir una
 * accion nueva antes que esta pantalla; esconderla seria peor que ensenar el
 * id crudo.
 */
const ETIQUETAS: Record<string, string> = {
  "command.palette": "Abrir la paleta de comandos",
  "open.settings": "Abrir Ajustes",
  "refresh.all": "Refrescar los avisos",
  "tab.dashboard": "Ir a Panel",
  "tab.usage": "Ir a Consumo",
  "tab.notifications": "Ir a Avisos",
  "tab.sessions": "Ir a Sesiones",
  "tab.projects": "Ir a Proyectos",
  "tab.plans": "Ir a Planes",
  "tab.memory": "Ir a Memoria",
  "tab.skills": "Ir a Skills",
  "tab.logs": "Ir a Registros",
  "tab.settings": "Ir a Ajustes",
};

/** Etiqueta de un id, con las tres fuentes en orden. */
export function etiquetaDe(id: string): string {
  return etiquetaAccionChat(id) ?? ETIQUETAS[id] ?? id;
}

/** Teclas que por si solas no son un atajo: son el modificador. */
const SOLO_MODIFICADOR = ["Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock", "Dead"];

/**
 * Una pulsacion -> el combo en el formato que App.tsx compara.
 *
 * App.tsx parte por «+», pasa todo a minusculas y compara la ultima parte con
 * `e.key.toLowerCase()`. Es decir: las mayusculas dan igual para que FUNCIONE,
 * pero se escriben como los valores por defecto de Rust («Alt+N», «Ctrl+,»,
 * «Escape») para que el fichero se lea igual lo haya escrito quien lo haya
 * escrito. El orden de los modificadores tambien es el suyo: Ctrl, Alt, Shift,
 * Meta.
 *
 * Devuelve null mientras solo haya modificadores pulsados: ahi el usuario
 * todavia no ha terminado de componer el atajo.
 */
export function comboDeTecla(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  if (!e.key || SOLO_MODIFICADOR.includes(e.key)) return null;
  const partes: string[] = [];
  if (e.ctrlKey) partes.push("Ctrl");
  if (e.altKey) partes.push("Alt");
  if (e.shiftKey) partes.push("Shift");
  if (e.metaKey) partes.push("Meta");
  // Una letra se guarda en mayuscula («Alt+N»); lo demas tal cual («Escape»,
  // «F5», «,»). `toUpperCase` sobre un signo lo deja igual.
  partes.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return partes.join("+");
}

/**
 * Filas a las que pertenece un error del backend.
 *
 * El rechazo llega como UNA frase que nombra la accion (o las dos, si es un
 * duplicado). Se busca el id dentro del texto en vez de inventar un protocolo
 * de errores estructurados: si Rust cambia la frase, lo peor que pasa es que
 * el mensaje salga solo arriba, no que se pierda.
 */
export function filasDelError(mensaje: string, ids: string[]): string[] {
  return ids.filter((id) => mensaje.includes(id));
}

type Props = {
  /** Solo para los tests: evita depender del `CustomEvent` global. */
  onGuardado?: () => void;
};

export function AtajosSection({ onGuardado }: Props = {}) {
  /** Lo que sirve Rust (por defecto + fichero). La referencia para «cambiado». */
  const [efectivos, setEfectivos] = useState<Record<string, string> | null>(null);
  /** Lo tocado en esta pantalla y aun sin guardar. "" = volver al de fabrica. */
  const [borrador, setBorrador] = useState<Record<string, string>>({});
  /** Accion esperando la siguiente tecla. null = no se esta capturando. */
  const [capturando, setCapturando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [culpables, setCulpables] = useState<string[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  /** Fila que hay que devolver el foco tras capturar. */
  const botones = useRef<Record<string, HTMLButtonElement | null>>({});

  const cargar = useCallback(async () => {
    const map = await invoke<Record<string, string>>("get_in_app_shortcuts").catch((e) => {
      setError(String(e));
      return null;
    });
    if (map) {
      setEfectivos(map);
      setBorrador({});
      setError(null);
      setCulpables([]);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // La captura escucha en CAPTURA y sobre `document`: mientras se esta
  // componiendo un atajo, esa pulsacion no puede llegar al manejador global de
  // App.tsx o capturar «Ctrl+K» abriria la paleta encima.
  useEffect(() => {
    if (!capturando) return;
    const tecla = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Escape suelto sale de la captura sin cambiar nada. Para asignar
        // Escape a una accion esta el boton «por defecto» de chat.parar, que
        // ya lo trae de fabrica.
        setCapturando(null);
        botones.current[capturando]?.focus();
        return;
      }
      const combo = comboDeTecla(e);
      if (!combo) return; // todavia solo hay modificadores pulsados
      setBorrador((prev) => ({ ...prev, [capturando]: combo }));
      setCapturando(null);
      setAviso(null);
      botones.current[capturando]?.focus();
    };
    document.addEventListener("keydown", tecla, true);
    return () => document.removeEventListener("keydown", tecla, true);
  }, [capturando]);

  const filas = useMemo(() => {
    const ids = Object.keys(efectivos ?? {});
    return ids
      .map((id) => ({ id, etiqueta: etiquetaDe(id) }))
      .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, "es"));
  }, [efectivos]);

  const cambios = Object.keys(borrador).length;

  async function guardar() {
    if (!efectivos || cambios === 0) return;
    setGuardando(true);
    setError(null);
    setCulpables([]);
    setAviso(null);
    // Se manda el mapa ENTERO (lo efectivo + lo tocado): asi Rust ve todas las
    // acciones a la vez y puede detectar que dos comparten combinacion.
    const bindings = { ...efectivos, ...borrador };
    try {
      const map = await invoke<Record<string, string>>("set_in_app_shortcuts", { bindings });
      setEfectivos(map ?? {});
      setBorrador({});
      setAviso("guardado");
      // App.tsx vuelve a pedir `get_in_app_shortcuts` al oirlo: sin esto los
      // atajos nuevos no valdrian hasta reiniciar la app.
      window.dispatchEvent(new CustomEvent("maria:atajos"));
      onGuardado?.();
    } catch (e) {
      const msg = String(e);
      setError(msg);
      setCulpables(filasDelError(msg, Object.keys(bindings)));
    } finally {
      setGuardando(false);
    }
  }

  if (!efectivos) {
    return <p className="hud-label p-4">{error ?? "cargando…"}</p>;
  }

  return (
    <div className="flex flex-col gap-3 p-4" style={{ maxWidth: 860 }}>
      <header>
        <h2 className="hud-label" style={{ fontSize: 12 }}>
          atajos dentro de la ventana
        </h2>
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-secondary)" }}>
          Solo funcionan con mar.ia en primer plano. Los que empiezan por{" "}
          <strong>Chat</strong> solo hacen algo con la pestaña Chat abierta. El atajo para
          abrir mar.ia desde cualquier sitio está en <strong>General</strong>.
        </p>
      </header>

      <table className="w-full text-[12.5px]" style={{ borderCollapse: "collapse" }}>
        <caption className="sr-only">atajos de teclado por acción</caption>
        <thead>
          <tr className="hud-label" style={{ textAlign: "left" }}>
            <th scope="col" className="py-1">
              acción
            </th>
            <th scope="col" className="py-1">
              combinación
            </th>
            <th scope="col" className="py-1">
              <span className="sr-only">cambiar</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {filas.map(({ id, etiqueta }) => {
            const tocado = Object.prototype.hasOwnProperty.call(borrador, id);
            const valor = tocado ? borrador[id] : efectivos[id];
            const capturandoEsta = capturando === id;
            const suError = culpables.includes(id) ? error : null;
            return (
              <tr key={id} style={{ borderTop: "1px solid var(--color-border)" }}>
                <th
                  scope="row"
                  className="py-1.5 pr-3 font-normal"
                  style={{ textAlign: "left", color: "var(--color-text)" }}
                >
                  {etiqueta}
                  {/* El id, para poder casar la fila con el fichero. Salvo
                      cuando la etiqueta YA es el id (acción que Rust tiene y
                      esta pantalla todavía no): escribirlo dos veces no
                      informa de nada. */}
                  {etiqueta !== id && (
                    <span
                      className="ml-2 text-[10.5px]"
                      style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
                    >
                      {id}
                    </span>
                  )}
                  {suError && (
                    <span
                      role="alert"
                      className="mt-0.5 block text-[11.5px]"
                      style={{ color: "var(--color-danger)" }}
                    >
                      {suError}
                    </span>
                  )}
                </th>
                <td className="py-1.5 pr-3">
                  <span
                    aria-live={capturandoEsta ? "polite" : undefined}
                    className="px-2 py-0.5"
                    style={{
                      fontFamily: "var(--font-mono)",
                      border: `1px solid ${
                        capturandoEsta ? "var(--color-accent)" : "var(--color-border)"
                      }`,
                      color: tocado ? "var(--color-accent)" : "var(--color-text-secondary)",
                    }}
                  >
                    {capturandoEsta
                      ? "pulsa la combinación…"
                      : valor === ""
                        ? "(la de fábrica, al guardar)"
                        : valor}
                  </span>
                </td>
                <td className="py-1.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      ref={(n) => {
                        botones.current[id] = n;
                      }}
                      type="button"
                      className="cc-bloque-boton"
                      aria-label={`capturar la combinación de ${etiqueta}`}
                      aria-pressed={capturandoEsta}
                      onClick={() => setCapturando(capturandoEsta ? null : id)}
                    >
                      {capturandoEsta ? "cancelar" : "capturar"}
                    </button>
                    <button
                      type="button"
                      className="cc-bloque-boton"
                      aria-label={`devolver ${etiqueta} a su combinación de fábrica`}
                      onClick={() => setBorrador((prev) => ({ ...prev, [id]: "" }))}
                    >
                      por defecto
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="cc-bloque-boton"
          disabled={cambios === 0 || guardando}
          onClick={() => void guardar()}
          style={{ opacity: cambios === 0 || guardando ? 0.5 : 1 }}
          title={
            cambios === 0
              ? "no has cambiado ninguna combinación"
              : `guarda ${cambios} cambio${cambios === 1 ? "" : "s"}`
          }
        >
          {guardando ? "guardando…" : "guardar"}
        </button>
        {cambios > 0 && !guardando && (
          <button
            type="button"
            className="cc-bloque-boton"
            onClick={() => {
              setBorrador({});
              setError(null);
              setCulpables([]);
            }}
          >
            descartar
          </button>
        )}
        <span className="hud-label">
          {cambios === 0
            ? "sin cambios"
            : `${cambios} sin guardar`}
        </span>
      </div>

      {aviso && (
        <p role="status" className="text-[12px]" style={{ color: "var(--color-success)" }}>
          {aviso}
        </p>
      )}
      {error && culpables.length === 0 && (
        <p
          role="alert"
          className="px-3 py-2 text-[12px]"
          style={{ border: "1px solid var(--color-danger)", color: "var(--color-danger)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
