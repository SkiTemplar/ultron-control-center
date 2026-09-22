// Los atajos de dentro de la ventana, tal y como los sirve Rust.
//
// Vive fuera de App.tsx (2026-09-22) por una razon concreta: desde que hay
// editor (Ajustes → Atajos) el mapa YA NO se lee una vez al arrancar. Guardar
// en esa pantalla tiene que llegar al manejador de teclado sin reiniciar la
// app, y esa regla —"al oir «maria:atajos», vuelve a preguntar"— es justo lo
// que hay que poder probar. Dentro de App.tsx solo se podia probar montando la
// aplicacion entera: la suite pasaba de 7,5 s a ~80 s por el grafo de modulos
// de esa pantalla (xterm y compania). Medido antes de sacarlo.
//
// El combo NO se interpreta aqui: eso lo hace `matchCombo` en App.tsx, que es
// quien ve los KeyboardEvent. Esto solo trae el mapa y avisa cuando cambia.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { seDisparaEscribiendo } from "../components/jarvis/chatAcciones";

/** Eventos de ventana que obligan a releer el mapa.
 *
 *  Son dos porque los dispara gente distinta: `in-app-shortcuts-updated` es el
 *  historico (lo puede lanzar el backend) y `maria:atajos` lo lanza el editor
 *  al guardar. Escuchar solo uno dejaria al otro sin efecto hasta reiniciar. */
export const EVENTOS_ATAJOS = ["in-app-shortcuts-updated", "maria:atajos"] as const;

export type Atajos = Record<string, string>;

/**
 * El mapa `accion -> combinacion`, releido en cada evento de `EVENTOS_ATAJOS`.
 *
 * Devuelve las dos caras que hacen falta:
 *   * `bindings`, reactivo, para pintar el atajo en la paleta;
 *   * `ref`, para leerlo DENTRO del manejador de teclado, que se registra una
 *     sola vez y con el valor reactivo se quedaria mirando el mapa de cuando
 *     se monto.
 *
 * Un fallo al leer no vacia lo que ya habia: quedarse sin teclado porque una
 * lectura suelta fallo seria peor que seguir con el mapa anterior.
 */
export function useAtajos(): { bindings: Atajos; ref: React.RefObject<Atajos> } {
  const ref = useRef<Atajos>({});
  const [bindings, setBindings] = useState<Atajos>({});

  useEffect(() => {
    let cancelado = false;
    async function cargar() {
      try {
        const map = (await invoke("get_in_app_shortcuts")) as Atajos | null;
        if (cancelado || !map) return;
        ref.current = map;
        setBindings(map);
      } catch (err) {
        console.warn("[maria] get_in_app_shortcuts falló", err);
      }
    }
    void cargar();
    const alCambiar = () => void cargar();
    for (const ev of EVENTOS_ATAJOS) window.addEventListener(ev, alCambiar);
    return () => {
      cancelado = true;
      for (const ev of EVENTOS_ATAJOS) window.removeEventListener(ev, alCambiar);
    };
  }, []);

  return { bindings, ref };
}

// ---------------------------------------------------------------------------
// Qué hace una pulsación
// ---------------------------------------------------------------------------
//
// Vive aquí por lo mismo que `useAtajos` (2026-09-22): dentro de App.tsx la
// regla solo se podía probar montando la aplicación entera —terminales
// incluidas—, y la suite pasaba de 7,5 s a unos 80 s por un fichero. App.tsx se
// queda con lo que no es decisión: leer el foco, `preventDefault` y ejecutar.

/** Lo que hace falta de un `KeyboardEvent`. Se pide así, y no el evento
 *  entero, para poder decidir con un objeto plano — igual que `comboDeTecla`
 *  en el editor de atajos. */
export type Pulsacion = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

/** Las acciones que valen en toda la ventana, en el orden en que se miran. */
export const ACCIONES_GLOBALES = [
  "command.palette",
  "open.settings",
  "refresh.all",
] as const;

/** ¿El foco está donde se escribe? Ahí una tecla suelta es una letra, no un
 *  atajo. */
export function esCajaDeTexto(el: Element | null): boolean {
  const tag = el?.tagName?.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    (el as HTMLElement | null)?.isContentEditable === true
  );
}

/**
 * ¿Casa la combinación guardada («Ctrl+Alt+K», «Alt+1», «Escape») con esta
 * pulsación? Los modificadores tienen que coincidir EXACTAMENTE: si no,
 * «Alt+N» se dispararía también con Ctrl+Alt+N, que puede ser otra acción.
 *
 * Un combo que no se puede leer devuelve `false` en vez de reventar: el
 * fichero se puede editar a mano.
 */
export function casaCombo(combo: string, tecla: Pulsacion): boolean {
  const partes = combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (partes.length === 0) return false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let letra: string | null = null;
  for (const p of partes) {
    if (p === "ctrl" || p === "control") ctrl = true;
    else if (p === "alt" || p === "option") alt = true;
    else if (p === "shift") shift = true;
    else if (p === "meta" || p === "super" || p === "win" || p === "cmd") meta = true;
    else letra = p;
  }
  if (!letra) return false;
  if (tecla.ctrlKey !== ctrl) return false;
  if (tecla.altKey !== alt) return false;
  if (tecla.shiftKey !== shift) return false;
  if (tecla.metaKey !== meta) return false;
  return tecla.key.toLowerCase() === letra;
}

/** La acción que le toca a una pulsación, o `null` si no le toca ninguna. */
export type QueHaceLaTecla = { tipo: "global" | "chat" | "tab"; id: string } | null;

/**
 * Qué hace esta pulsación, con las tres familias en orden.
 *
 * La regla que manda es `escribiendo`: con el cursor dentro de una caja de
 * texto SOLO se dispara lo que lleva modificador (o Escape/F1-F12), porque una
 * tecla suelta dejaría esa letra intecleable en toda la ventana. Hasta el
 * 2026-09-22 eso solo protegía a las acciones del chat: las tres globales se
 * miraban antes del corte y hacían `preventDefault()` pase lo que pase, así
 * que guardar la Q sola en «Abrir la paleta de comandos» —cosa que
 * `normaliza_combo` acepta a propósito— dejaba esa letra sin poder escribirse
 * en el chat, en Ajustes y en el editor de settings.json, con la paleta
 * parpadeando en cada intento.
 *
 * Los saltos de pestaña siguen sin dispararse mientras se escribe, lleven lo
 * que lleven: es lo que ya hacían.
 */
export function decidirAtajo(estado: {
  bindings: Atajos;
  tecla: Pulsacion;
  escribiendo: boolean;
  /** Con la paleta abierta, las acciones del chat no se tocan: ahí Escape es
   *  suyo. */
  paletaAbierta: boolean;
  /** Ids de las acciones que el chat publica AHORA. Vacío = no hay chat. */
  chat: readonly string[];
  /** Ids de los saltos de pestaña que App.tsx sabe ejecutar. */
  tabs: readonly string[];
}): QueHaceLaTecla {
  const { bindings, tecla, escribiendo, paletaAbierta, chat, tabs } = estado;
  if (!bindings || Object.keys(bindings).length === 0) return null;

  const dispara = (id: string): boolean => {
    const combo = bindings[id];
    if (!combo || !casaCombo(combo, tecla)) return false;
    return !escribiendo || seDisparaEscribiendo(combo);
  };

  for (const id of ACCIONES_GLOBALES) {
    if (dispara(id)) return { tipo: "global", id };
  }
  if (!paletaAbierta) {
    for (const id of chat) {
      if (dispara(id)) return { tipo: "chat", id };
    }
  }
  if (escribiendo) return null;
  for (const id of tabs) {
    if (dispara(id)) return { tipo: "tab", id };
  }
  return null;
}
